/* CarPlay pass-through state machine. See PASSTHROUGH_PLAN.md, "State
 * machine", "Configuration" and "Recovery"; comments cite the review IDs. */
#include "cpthru_core.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SYNC_RETRY_MS 50
#define SYNC_GIVEUP_MS 2000
#define IDR_REREQ_MS 1000
#define IDR_DEADLINE_MS 2000
#define IDR_MIN_GAP_MS 250
#define KF_WINDOW_MS 10000
#define KF_STORM 3
#define TL_COUNT_MS 5000
#define FB_DEADLINE_MS 3000
#define FB_REREQ_MS 1000
#define STATS_MS 5000
#define IDLE_WAIT_MS 1500

static const char *names[] = {"IDLE", "SYNC_CONFIG", "WAIT_IDR", "PASSTHRU",
	"RESYNC", "TRANSPORT_LOST", "FALLBACK", "TRANSCODE"};

const char *cp_state_name(enum cp_state s) { return names[s]; }

static void logf_(struct cp *c, const char *fmt, ...)
{
	char line[512];
	int k = snprintf(line, sizeof line, "cpthru: t=%u ", (unsigned)c->in.now_ms);
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(line + k, sizeof line - k, fmt, ap);
	va_end(ap);
	c->o.log(c->o.ctx, line);
}

static int owned_state(enum cp_state s)
{
	return s == CP_SYNC_CONFIG || s == CP_WAIT_IDR || s == CP_PASSTHRU ||
	       s == CP_RESYNC || s == CP_TRANSPORT_LOST;
}

/* Status JSON for the web page. Every string is a fixed literal from this
 * file; esc() still guards the JSON quoting. */
static const char *esc(const char *s, char *b, int n)
{
	int k = 0;
	for (; s && *s && k < n - 2; s++)
		if (*s != '"' && *s != '\\' && (unsigned char)*s >= 0x20)
			b[k++] = *s;
	b[k] = 0;
	return b;
}

static void publish(struct cp *c)
{
	if (!c->o.status)
		return;
	char j[768], r[96], f[96];
	snprintf(j, sizeof j,
		 "{\"t_ms\":%u,\"state\":\"%s\",\"reason\":\"%s\",\"off\":%d,\"marker\":%d,"
		 "\"in_fps\":%.1f,\"pt_fps\":%.1f,\"stock_fps\":%.1f,\"kbps\":%.0f,"
		 "\"car\":\"%dx%d@%d\",\"phone\":\"%dx%d p%d/l%d\",\"fallbacks\":%d,\"failed\":%d,"
		 "\"last_fallback\":\"%s\",\"last_fallback_t_ms\":%u,\"multi_vcl\":%u,"
		 "\"push_err\":%u,\"kf_car\":%u,\"kf_phone\":%u}",
		 (unsigned)c->in.now_ms, names[c->st], esc(c->reason, r, sizeof r), c->in.killed,
		 c->o.marker_exists(c->o.ctx), c->in_fps, c->pt_fps, c->stock_fps, c->kbps,
		 c->in.car_w, c->in.car_h, c->in.car_fps, c->cfg_w, c->cfg_h, c->cfg_profile,
		 c->cfg_level, c->fallbacks, c->failed, esc(c->last_fb, f, sizeof f),
		 (unsigned)c->last_fb_t, c->s.multi_vcl, c->s.push_err, c->s.kf_car, c->s.kf_phone);
	c->o.status(c->o.ctx, j);
}

static void set_state(struct cp *c, enum cp_state s, const char *why)
{
	if (c->st == s)
		return;
	int own = owned_state(s);
	if (own != c->owned) {
		/* Taking ownership waits for admitted stock sends and fails if a
		 * teardown hook ran since this frame began (C02, C03). */
		if (!c->o.set_owned(c->o.ctx, own)) {
			logf_(c, "state %s -> %s refused: torn down meanwhile", names[c->st], names[s]);
			s = CP_IDLE, own = 0;
			c->o.set_owned(c->o.ctx, 0);
		}
		c->owned = own;
	}
	if (c->st == s)
		return;
	logf_(c, "state %s -> %s (%s)", names[c->st], names[s], why);
	c->st = s;
	c->reason = why;
	publish(c);
}

/* ---- H.264 parsing ---------------------------------------------------- */

/* Split an Annex-B buffer into NAL payloads (without start codes). A 4-byte
 * start code's leading zero is not counted as part of the previous NAL. */
int cp_nal_split(const uint8_t *b, int n, int *off, int *len, int max)
{
	int k = 0, i = 0, start = -1;
	while (i + 3 <= n) {
		if (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) {
			if (start >= 0) {
				int end = i;
				while (end > start && b[end - 1] == 0)
					end--;
				if (k < max)
					off[k] = start, len[k] = end - start;
				k++;
			}
			i += 3;
			start = i;
		} else {
			i++;
		}
	}
	if (start >= 0 && start < n) {
		if (k < max)
			off[k] = start, len[k] = n - start;
		k++;
	}
	return k;
}

struct bits { const uint8_t *p; int n, pos; };

static int bit(struct bits *b)
{
	if (b->pos >= b->n * 8)
		return -1;
	int v = (b->p[b->pos >> 3] >> (7 - (b->pos & 7))) & 1;
	b->pos++;
	return v;
}

static int ue(struct bits *b)
{
	int z = 0, v;
	while ((v = bit(b)) == 0)
		if (++z > 31)
			return -1;
	if (v < 0)
		return -1;
	unsigned r = 1;
	for (int i = 0; i < z; i++) {
		if ((v = bit(b)) < 0)
			return -1;
		r = (r << 1) | v;
	}
	return (int)(r - 1);
}

static int se(struct bits *b)
{
	int k = ue(b);
	return k < 0 ? 0 : (k & 1) ? (k + 1) / 2 : -(k / 2);
}

/* Width/height of an SPS NAL (header byte included). */
int cp_sps_size(const uint8_t *sps, int n, int *w, int *h, int *profile, int *level)
{
	uint8_t rbsp[256];
	int m = 0;
	for (int i = 1; i < n && m < (int)sizeof rbsp; i++) {
		if (i >= 3 && sps[i] == 3 && sps[i - 1] == 0 && sps[i - 2] == 0)
			continue; /* emulation prevention byte */
		rbsp[m++] = sps[i];
	}
	if (n < 4 || (sps[0] & 0x1f) != 7)
		return -1;
	struct bits b = {rbsp, m, 0};
	int prof = rbsp[0];
	*profile = prof, *level = rbsp[2];
	b.pos = 24;
	ue(&b); /* seq_parameter_set_id */
	int chroma = 1;
	if (prof == 100 || prof == 110 || prof == 122 || prof == 244 || prof == 44 ||
	    prof == 83 || prof == 86 || prof == 118 || prof == 128 || prof == 138 ||
	    prof == 139 || prof == 134 || prof == 135) {
		chroma = ue(&b);
		if (chroma == 3)
			bit(&b);
		ue(&b), ue(&b); /* bit depths */
		bit(&b);        /* qpprime_y_zero_transform_bypass */
		if (bit(&b) == 1) {
			for (int i = 0; i < (chroma != 3 ? 8 : 12); i++) {
				if (bit(&b) != 1)
					continue;
				int last = 8, next = 8, size = i < 6 ? 16 : 64;
				for (int j = 0; j < size; j++) {
					if (next)
						next = (last + se(&b) + 256) % 256;
					last = next ? next : last;
				}
			}
		}
	}
	ue(&b); /* log2_max_frame_num */
	int poc = ue(&b);
	if (poc == 0) {
		ue(&b);
	} else if (poc == 1) {
		bit(&b);
		se(&b), se(&b);
		int k = ue(&b);
		if (k < 0 || k > 255)
			return -1;
		for (int i = 0; i < k; i++)
			se(&b);
	}
	ue(&b); /* max_num_ref_frames */
	bit(&b);
	int wmb = ue(&b) + 1, hmu = ue(&b) + 1;
	int frame_only = bit(&b);
	if (!frame_only)
		bit(&b);
	bit(&b); /* direct_8x8_inference */
	int cl = 0, cr = 0, ct = 0, cb = 0;
	if (bit(&b) == 1)
		cl = ue(&b), cr = ue(&b), ct = ue(&b), cb = ue(&b);
	if (b.pos > b.n * 8 || wmb <= 0 || hmu <= 0)
		return -1;
	int sx = chroma == 0 || chroma == 3 ? 1 : 2;
	int sy = (chroma == 1 ? 2 : 1) * (2 - frame_only);
	if (chroma == 0)
		sy = 2 - frame_only;
	*w = wmb * 16 - sx * (cl + cr);
	*h = hmu * 16 * (2 - frame_only) - sy * (ct + cb);
	return 0;
}

int cp_avcc_to_annexb(const uint8_t *a, int n, uint8_t **all, int *all_len,
		      uint8_t **pt, int *pt_len, const uint8_t **sps, int *sps_len)
{
	*all = *pt = 0, *all_len = *pt_len = 0, *sps = 0, *sps_len = 0;
	if (n < 7 || a[0] != 1)
		return -1;
	int lsize = (a[4] & 3) + 1, i, nsps = a[5] & 0x1f, npps = 0;
	const uint8_t *s0 = 0, *p0 = 0;
	int s0n = 0, p0n = 0;
	uint8_t *out = malloc(n * 2 + 16);
	int o = 0;
	if (!out)
		return -1;
	i = 6;
	for (int pass = 0; pass < 2; pass++) {
		int count = pass == 0 ? nsps : -1;
		if (pass == 1) {
			if (i >= n)
				goto bad;
			count = npps = a[i++];
		}
		for (int k = 0; k < count; k++) {
			if (i + 2 > n)
				goto bad;
			int l = a[i] << 8 | a[i + 1];
			i += 2;
			if (l <= 0 || i + l > n)
				goto bad;
			memcpy(out + o, "\0\0\0\1", 4);
			memcpy(out + o + 4, a + i, l);
			o += 4 + l;
			if (k == 0 && pass == 0)
				s0 = a + i, s0n = l;
			if (k == 0 && pass == 1)
				p0 = a + i, p0n = l;
			i += l;
		}
	}
	if (nsps < 1 || npps < 1)
		goto bad;
	*all = out, *all_len = o, *sps = s0, *sps_len = s0n;
	if (nsps == 1 && npps == 1 && lsize == 4) {
		*pt = malloc(8 + s0n + p0n);
		if (*pt) {
			memcpy(*pt, "\0\0\0\1", 4);
			memcpy(*pt + 4, s0, s0n);
			memcpy(*pt + 4 + s0n, "\0\0\0\1", 4);
			memcpy(*pt + 8 + s0n, p0, p0n);
			*pt_len = 8 + s0n + p0n;
		}
	}
	return 0;
bad:
	free(out);
	return -1;
}

/* ---- state machine ---------------------------------------------------- */

void cp_init(struct cp *c, const struct cp_ops *ops)
{
	memset(c, 0, sizeof *c);
	c->o = *ops;
	c->st = CP_IDLE;
}

static int eligible(struct cp *c)
{
	return c->hdr_pt && c->cfg_ok_shape && c->in.car_w > 0 && c->in.car_h > 0 &&
	       c->cfg_w == c->in.car_w && c->cfg_h == c->in.car_h;
}

static void request_idr(struct cp *c, int force)
{
	uint32_t t = c->in.now_ms;
	if (!force && c->last_idr_req && t - c->last_idr_req < IDR_MIN_GAP_MS)
		return;
	c->last_idr_req = t ? t : 1;
	c->s.kf_phone++;
	c->o.request_idr(c->o.ctx);
}

static void maybe_marker(struct cp *c)
{
	if ((c->fallbacks >= 2 || c->failed >= 1) && !c->o.marker_exists(c->o.ctx)) {
		c->o.marker_write(c->o.ctx);
		logf_(c, "fail marker written (fallbacks=%d failed=%d)", c->fallbacks, c->failed);
	}
}

static void enter_sync(struct cp *c, enum cp_state after, const char *why)
{
	if (c->st != CP_SYNC_CONFIG) { /* repeats keep the running budget (C07) */
		c->sync_t0 = c->in.now_ms;
		c->sync_try = 0;
	}
	c->after_sync = after;
	set_state(c, CP_SYNC_CONFIG, why);
}

/* Start a RESYNC episode; keep the deadline of one already running (R14). */
static void begin_resync(struct cp *c, int via_sync, const char *why)
{
	int running = c->st == CP_RESYNC ||
		      (c->st == CP_SYNC_CONFIG && c->after_sync == CP_RESYNC);
	if (!running)
		c->idr_t0 = c->in.now_ms, c->idr_rereq_done = 0;
	/* A new episode always asks the phone; repeats inside one are rate-limited. */
	if (via_sync) {
		int t0 = c->idr_t0, rr = c->idr_rereq_done;
		enter_sync(c, CP_RESYNC, why);
		c->idr_t0 = t0, c->idr_rereq_done = rr;
	} else {
		request_idr(c, !running);
		set_state(c, CP_RESYNC, why);
	}
}

static void transport_lost(struct cp *c, int r)
{
	c->tl_t0 = c->in.now_ms;
	c->tl_counted = 0;
	c->tl_car_gen = c->in.car_gen; /* latched until the handle is replaced (C04) */
	logf_(c, "push failed with %d after a possible partial write", r);
	set_state(c, CP_TRANSPORT_LOST, "write failure");
}

static void fallback(struct cp *c, const char *why)
{
	c->fallbacks++;
	c->fb_t0 = c->in.now_ms;
	c->fb_rereq = 0;
	c->fb_fed = 0;
	c->fb_done = 0;
	c->delivered_car_gen = c->delivered_cfg_gen = 0;
	c->last_fb = why, c->last_fb_t = c->in.now_ms ? c->in.now_ms : 1; /* WEB-03 */
	set_state(c, CP_FALLBACK, why);
	maybe_marker(c); /* the IDR request follows the header (stock_frame) */
}

static int push_copy(struct cp *c, const uint8_t *nal, int n, int flag, int with_sc)
{
	int need = n + 4;
	if (need > c->bufcap) {
		uint8_t *nb = realloc(c->buf, need + 4096);
		if (!nb)
			return CP_PUSH_NOT_STREAMING;
		c->buf = nb, c->bufcap = need + 4096;
	}
	int len = n;
	if (with_sc) {
		memcpy(c->buf, "\0\0\0\1", 4);
		memcpy(c->buf + 4, nal, n);
		len = n + 4;
	} else {
		memcpy(c->buf, nal, n);
	}
	int r = c->o.push(c->o.ctx, c->in.car, c->buf, len, flag);
	if (r < 0)
		c->s.push_err++;
	return r;
}

/* A stream that may run through the shim: its frames never reach the stock
 * decoder except through the fallback sequence (header, then an IDR), so
 * the stock idle re-encoder never holds a frame of it (C06, C08). */
static int candidate(struct cp *c)
{
	/* The switch and the fail marker are applied once, at stream start; a
	 * marker written mid-stream affects the next stream (REV-01). */
	return c->in.stream_live && c->stream_candidate && c->st != CP_TRANSCODE;
}

/* Apply generation changes and car keyframe requests from cp_in. */
static void apply_inputs(struct cp *c)
{
	struct cp_in *in = &c->in;

	if (in->stream_gen != c->seen_stream_gen) {
		c->seen_stream_gen = in->stream_gen;
		set_state(c, CP_IDLE, in->stream_live ? "stream start" : "stream stop");
		c->kf_n = 0;
		c->idle_t0 = 0;
		c->stream_candidate = in->stream_live && !in->killed && !c->o.marker_exists(c->o.ctx);
		if (in->stream_live && !c->stream_candidate) {
			logf_(c, "pass-through off for this stream (%s)",
			      in->killed ? "web page switch" : "fail marker");
			set_state(c, CP_TRANSCODE, "disabled");
		}
	}

	if (in->cfg_gen != c->seen_cfg_gen) {
		c->seen_cfg_gen = in->cfg_gen;
		free(c->hdr_all), free(c->hdr_pt);
		c->hdr_all = c->hdr_pt = 0;
		c->cfg_ok_shape = 0;
		c->cfg_w = c->cfg_h = 0;
		const uint8_t *sps;
		int sps_len;
		if (in->avcc && cp_avcc_to_annexb(in->avcc, in->avcc_len, &c->hdr_all,
						  &c->hdr_all_len, &c->hdr_pt, &c->hdr_pt_len,
						  &sps, &sps_len) == 0) {
			cp_sps_size(sps, sps_len, &c->cfg_w, &c->cfg_h, &c->cfg_profile,
				    &c->cfg_level);
			c->cfg_ok_shape = c->hdr_pt != 0;
		}
		logf_(c, "config gen %u: %dx%d profile %d level %d shape %s eligible %s",
		      in->cfg_gen, c->cfg_w, c->cfg_h, c->cfg_profile, c->cfg_level,
		      c->cfg_ok_shape ? "ok" : "unsupported", eligible(c) ? "yes" : "no");
		if (c->st == CP_TRANSPORT_LOST) {
			/* cached only; nothing is sent until the handle is replaced (C04) */
		} else if (c->owned) { /* R1, R16: every generation is re-checked */
			if (eligible(c))
				begin_resync(c, 1, "new config");
			else
				fallback(c, "ineligible config");
		} else if (c->st == CP_FALLBACK || (c->st == CP_TRANSCODE && c->fb_done)) {
			/* The transcoder must get this header too; sdDongle drops later
			 * SPS-led buffers itself (C05). */
			c->fb_fed = 0, c->fb_done = 0, c->fb_t0 = in->now_ms, c->fb_rereq = 0;
			set_state(c, CP_FALLBACK, "new config for the transcoder");
		}
	}

	if (c->owned && (!in->car || !in->session || in->car_gen != c->seen_car_gen)) {
		/* R13, C06: wait in IDLE (frames dropped); re-entry below decides
		 * between a resync and the full fallback, never raw stock. */
		set_state(c, CP_IDLE, !in->car ? "car stop" : !in->session ? "session end" : "car restart");
		c->idle_t0 = in->now_ms;
	}
	c->seen_car_gen = in->car_gen;

	if (in->kf_new) {
		int k = in->kf_new;
		in->kf_new = 0;
		c->s.kf_car += k;
		if (c->owned && c->st != CP_TRANSPORT_LOST) { /* C04: only counted there */
			while (k--) {
				if (c->kf_n == 8)
					memmove(c->kf_ring, c->kf_ring + 1, 7 * sizeof *c->kf_ring), c->kf_n--;
				c->kf_ring[c->kf_n++] = in->now_ms;
			}
			int recent = 0;
			for (int i = 0; i < c->kf_n; i++)
				recent += in->now_ms - c->kf_ring[i] <= KF_WINDOW_MS;
			if (recent >= KF_STORM)
				fallback(c, "car keyframe storm");
			else
				begin_resync(c, 1, "car keyframe request");
		}
	}

	/* Leave IDLE: pass-through when every piece is there; the full fallback
	 * when the config can't pass through or inputs stay missing. */
	if (c->st == CP_IDLE && candidate(c)) {
		if (!c->idle_t0)
			c->idle_t0 = in->now_ms ? in->now_ms : 1;
		if (in->session && in->car && c->hdr_all) {
			if (eligible(c)) {
				c->idr_t0 = in->now_ms, c->idr_rereq_done = 0;
				enter_sync(c, CP_WAIT_IDR, "all inputs ready");
			} else {
				fallback(c, "config not eligible for pass-through");
			}
		} else if (in->now_ms - c->idle_t0 > IDLE_WAIT_MS) {
			fallback(c, "inputs missing for 1.5 s");
		}
	}
}

static void timers(struct cp *c)
{
	uint32_t t = c->in.now_ms;
	switch (c->st) {
	case CP_SYNC_CONFIG:
		if (t - c->sync_t0 > SYNC_GIVEUP_MS)
			fallback(c, "config push not ready for 2 s");
		else if (c->after_sync == CP_RESYNC && t - c->idr_t0 > IDR_DEADLINE_MS)
			fallback(c, "resync deadline passed during config push"); /* C07 */
		break;
	case CP_WAIT_IDR:
	case CP_RESYNC:
		if (t - c->idr_t0 > IDR_DEADLINE_MS) {
			fallback(c, "no IDR within 2 s");
		} else if (!c->idr_rereq_done && t - c->idr_t0 > IDR_REREQ_MS) {
			c->idr_rereq_done = 1;
			request_idr(c, 1);
		}
		break;
	case CP_TRANSPORT_LOST:
		if (!c->tl_counted && t - c->tl_t0 > TL_COUNT_MS) {
			c->tl_counted = 1;
			c->failed++;
			logf_(c, "no car restart 5 s after transport loss");
			maybe_marker(c);
		}
		break;
	default:
		break;
	}
}

static void do_sync(struct cp *c)
{
	if (c->sync_try && c->in.now_ms - c->sync_try < SYNC_RETRY_MS)
		return;
	c->sync_try = c->in.now_ms ? c->in.now_ms : 1;
	int r = push_copy(c, c->hdr_pt, c->hdr_pt_len, 1, 0);
	if (r == 0) {
		c->delivered_car_gen = c->in.car_gen;
		c->delivered_cfg_gen = c->in.cfg_gen;
		request_idr(c, 1);
		if (c->after_sync == CP_WAIT_IDR)
			c->idr_t0 = c->in.now_ms, c->idr_rereq_done = 0;
		set_state(c, c->after_sync, "config delivered");
	} else if (r != CP_PUSH_NOT_STREAMING && r != CP_PUSH_BAD_FD) {
		transport_lost(c, r);
	}
}

void cp_poll(struct cp *c)
{
	apply_inputs(c);
	timers(c);
	if (c->st == CP_SYNC_CONFIG)
		do_sync(c);
}

static void stats(struct cp *c)
{
	uint32_t t = c->in.now_ms;
	if (!c->stats_t0) {
		c->stats_t0 = t ? t : 1;
		return;
	}
	if (t - c->stats_t0 < STATS_MS)
		return;
	float dt = (t - c->stats_t0) / 1000.0f;
	struct cp_stats *s = &c->s, *p = &c->s_prev;
	s->stock = c->in.stock_sent;
	c->in_fps = (s->in - p->in) / dt;
	c->pt_fps = (s->pushed - p->pushed) / dt;
	c->stock_fps = (s->stock - p->stock) / dt;
	c->kbps = (s->bytes - p->bytes) * 8 / dt / 1000;
	char hist[160];
	int k = 0;
	hist[0] = 0;
	for (int i = 0; i < 32 && k < (int)sizeof hist - 1; i++) {
		if (s->nal_hist[i] == p->nal_hist[i])
			continue;
		int w = snprintf(hist + k, sizeof hist - k, "%d:%u,", i,
				 s->nal_hist[i] - p->nal_hist[i]);
		if (w < 0 || w >= (int)sizeof hist - k)
			break; /* truncated: keep what fits (C09) */
		k += w;
	}
	logf_(c, "stats %s in=%.1ffps out=%.1ffps stock=%.1ffps kbps=%.0f dropped=%u multi_vcl=%u "
	      "push_err=%u kf_car=%u kf_phone=%u nal=%s car=%dx%d@%d",
	      names[c->st], c->in_fps, c->pt_fps, c->stock_fps, c->kbps, s->dropped - p->dropped,
	      s->multi_vcl - p->multi_vcl, s->push_err - p->push_err,
	      s->kf_car - p->kf_car, s->kf_phone - p->kf_phone, hist,
	      c->in.car_w, c->in.car_h, c->in.car_fps);
	*p = *s;
	c->stats_t0 = t;
	publish(c);
}

/* FALLBACK / TRANSCODE / IDLE frame handling: the stock path (R6, R18). */
static void stock_frame(struct cp *c, void *sr, char *buf, int len, int has_idr)
{
	if (c->st == CP_IDLE && candidate(c)) {
		c->s.dropped++; /* waiting for pass-through or the fallback (C08) */
		return;
	}
	if (c->st != CP_FALLBACK || c->fb_done) {
		c->o.orig_setdata(c->o.ctx, sr, buf, len);
		return;
	}
	uint32_t t = c->in.now_ms;
	if (!c->fb_fed && c->hdr_all) {
		/* Copy: the stock path may modify the buffer. */
		char *h = malloc(c->hdr_all_len);
		if (h) {
			memcpy(h, c->hdr_all, c->hdr_all_len);
			c->o.orig_setdata(c->o.ctx, sr, h, c->hdr_all_len);
			free(h);
			c->fb_fed = 1;
			c->fb_cfg_gen = c->in.cfg_gen;
			request_idr(c, 1);
		}
	}
	if (c->fb_fed && c->fb_cfg_gen == c->in.cfg_gen && has_idr) {
		c->o.orig_setdata(c->o.ctx, sr, buf, len);
		c->o.encoder_keyframe(c->o.ctx);
		c->fb_done = 1;
		set_state(c, CP_TRANSCODE, "picture recovered");
		return;
	}
	if (t - c->fb_t0 > FB_DEADLINE_MS) {
		c->failed++;
		c->fb_done = 1;
		maybe_marker(c);
		set_state(c, CP_TRANSCODE, "fallback deadline, forwarding all");
		c->o.orig_setdata(c->o.ctx, sr, buf, len);
		c->o.encoder_keyframe(c->o.ctx);
		return;
	}
	if (t - c->fb_t0 > (c->fb_rereq + 1) * FB_REREQ_MS) {
		c->fb_rereq++;
		request_idr(c, 1);
	}
	c->s.dropped++;
}

void cp_frame(struct cp *c, void *sr, char *buf, int len)
{
	c->sr = sr;
	c->s.in++;
	c->s.bytes += len;
	cp_poll(c);

	int off[32], nl[32], n = cp_nal_split((uint8_t *)buf, len, off, nl, 32);
	int vcl = 0, vi = -1, idr = 0, sps_first = 0, overflow = n > 32;
	if (overflow)
		n = 32; /* not fully inspected: never sent as one slice (C10) */
	for (int i = 0; i < n; i++) {
		int t = buf[off[i]] & 0x1f;
		c->s.nal_hist[t]++;
		if (i == 0 && t == 7)
			sps_first = 1;
		if (t >= 1 && t <= 5)
			vcl++, vi = i, idr |= t == 5;
	}

	if (!c->owned) {
		stock_frame(c, sr, buf, len, idr && vcl >= 1);
		stats(c);
		return;
	}

	/* Shim-owned: never call the stock decoder. */
	if (sps_first || vcl == 0 || c->st == CP_SYNC_CONFIG || c->st == CP_TRANSPORT_LOST) {
		c->s.dropped++;
		stats(c);
		return;
	}
	if (vcl > 1 || overflow) {
		c->s.multi_vcl++;
		c->s.dropped++;
		if (c->st == CP_PASSTHRU)
			begin_resync(c, 0, "multi-slice access unit");
		stats(c);
		return;
	}
	if ((c->st == CP_WAIT_IDR || c->st == CP_RESYNC) && !idr) {
		c->s.dropped++;
		stats(c);
		return;
	}
	/* R12: an IDR goes out only after this handle+config got the config. */
	if (c->delivered_car_gen != c->in.car_gen || c->delivered_cfg_gen != c->in.cfg_gen) {
		enter_sync(c, c->st == CP_PASSTHRU ? CP_RESYNC : c->st, "config not delivered");
		c->s.dropped++;
		stats(c);
		return;
	}
	int r = push_copy(c, (uint8_t *)buf + off[vi], nl[vi], 0, 1);
	if (r == 0) {
		c->s.pushed++;
		if (c->st != CP_PASSTHRU)
			set_state(c, CP_PASSTHRU, "IDR delivered");
	} else if (r == CP_PUSH_NOT_STREAMING || r == CP_PUSH_BAD_FD) {
		begin_resync(c, 1, "frame not sent (car not ready)"); /* R17 */
	} else {
		transport_lost(c, r);
	}
	stats(c);
}
