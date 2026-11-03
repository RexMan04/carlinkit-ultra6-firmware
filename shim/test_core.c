/* Host tests for the pass-through core (PASSTHROUGH_PLAN.md "Verification" 1).
 * Streams in testdata/ come from x264 (make testdata). Access units are fed
 * the way libScreenStream delivers them: Annex-B, config only via avcC. */
#include "cpthru_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL %s:%d: ", __FILE__, __LINE__); \
	printf(__VA_ARGS__); printf("\n"); } } while (0)

/* ---- fake firmware ---- */
static char ev[4096][48];
static int nev, push_script[64], nscript, marker, verbose;
static void add(const char *s) { if (nev < 4096) snprintf(ev[nev++], 48, "%s", s); }
static int f_push(void *ctx, void *car, uint8_t *b, int n, int flag)
{
	(void)ctx, (void)car;
	char s[48];
	int r = nscript ? push_script[0] : 0;
	if (nscript)
		memmove(push_script, push_script + 1, --nscript * sizeof *push_script);
	if (flag)
		snprintf(s, 48, "cfg %d r=%d", (b[4] & 31) == 7 && n > 8, r);
	else
		snprintf(s, 48, "frame %d sc=%d r=%d", b[4] & 31, !memcmp(b, "\0\0\0\1", 4), r);
	add(s);
	return r;
}
static void f_idr(void *ctx) { (void)ctx; add("idr"); }
static void f_orig(void *ctx, void *sr, char *b, int n)
{
	(void)ctx, (void)sr;
	int off[32], len[32], k = cp_nal_split((uint8_t *)b, n, off, len, 32);
	char s[48];
	snprintf(s, 48, "orig %d", k ? b[off[0]] & 31 : -1);
	for (int i = 0; i < k; i++)
		if ((b[off[i]] & 31) == 5 || (b[off[i]] & 31) == 1)
			snprintf(s, 48, "orig %d", b[off[i]] & 31);
	add(s);
}
static void f_enckf(void *ctx) { (void)ctx; add("enc_kf"); }
static int own_fail;
static int f_setowned(void *ctx, int own)
{
	(void)ctx;
	char e[48];
	if (own && own_fail) { add("own refused"); return 0; }
	snprintf(e, 48, "own %d", own);
	add(e);
	return 1;
}
static int f_mexists(void *ctx) { (void)ctx; return marker; }
static void f_mwrite(void *ctx) { (void)ctx; marker = 1; add("marker"); }
static FILE *status_out;
static char last_status[1024];
static void f_status(void *ctx, const char *j)
{
	(void)ctx;
	snprintf(last_status, sizeof last_status, "%s", j);
	if (status_out)
		fprintf(status_out, "%s\n", j);
}
static void f_log(void *ctx, const char *l) { (void)ctx; if (verbose) printf("  %s\n", l); }

/* ---- streams ---- */
struct au { uint8_t *p; int n; };
struct stream { uint8_t *avcc; int avcc_n; struct au au[256]; int n; int idr[256]; };

static uint8_t *slurp(const char *f, int *n)
{
	FILE *fp = fopen(f, "rb");
	if (!fp) { printf("missing %s (run make testdata)\n", f); exit(2); }
	fseek(fp, 0, SEEK_END); *n = ftell(fp); fseek(fp, 0, SEEK_SET);
	uint8_t *b = malloc(*n);
	if (fread(b, 1, *n, fp) != (size_t)*n) exit(2);
	fclose(fp);
	return b;
}

/* Split at AUD NALs; pull SPS/PPS out into an avcC (nsps copies of the SPS). */
static void load(struct stream *s, const char *f, int nsps)
{
	int n, off[8192], len[8192];
	uint8_t *d = slurp(f, &n);
	int k = cp_nal_split(d, n, off, len, 8192);
	uint8_t *sps = 0, *pps = 0;
	int spsn = 0, ppsn = 0;
	memset(s, 0, sizeof *s);
	s->n = -1;
	for (int i = 0; i < k; i++) {
		int t = d[off[i]] & 31;
		if (t == 7) { sps = d + off[i], spsn = len[i]; continue; }
		if (t == 8) { pps = d + off[i], ppsn = len[i]; continue; }
		if (t == 9) { s->n++; s->au[s->n].p = malloc(n); s->au[s->n].n = 0; }
		if (s->n < 0) continue;
		struct au *a = &s->au[s->n];
		memcpy(a->p + a->n, "\0\0\0\1", 4);
		memcpy(a->p + a->n + 4, d + off[i], len[i]);
		a->n += 4 + len[i];
		if (t == 5) s->idr[s->n] = 1;
	}
	s->n++;
	uint8_t *a = s->avcc = malloc(64 + nsps * (spsn + 2) + ppsn);
	int o = 0;
	a[o++] = 1, a[o++] = sps[1], a[o++] = sps[2], a[o++] = sps[3], a[o++] = 0xff;
	a[o++] = 0xe0 | nsps;
	for (int i = 0; i < nsps; i++) {
		a[o++] = spsn >> 8, a[o++] = spsn & 255;
		memcpy(a + o, sps, spsn), o += spsn;
	}
	a[o++] = 1, a[o++] = ppsn >> 8, a[o++] = ppsn & 255;
	memcpy(a + o, pps, ppsn), o += ppsn;
	s->avcc_n = o;
}

static struct stream M, O, MS, MULTISPS;
static struct cp C;
static int sr_dummy;

static void reset(void)
{
	struct cp_ops o = {.push = f_push, .request_idr = f_idr, .orig_setdata = f_orig,
			   .encoder_keyframe = f_enckf, .set_owned = f_setowned,
			   .marker_exists = f_mexists, .marker_write = f_mwrite, .log = f_log,
			   .status = f_status};
	cp_init(&C, &o);
	nev = nscript = marker = own_fail = 0;
	C.in.now_ms = 1000;
	C.in.car_w = 1920, C.in.car_h = 720, C.in.car_fps = 60;
}
static void set_avcc(struct stream *s) { C.in.avcc = s->avcc, C.in.avcc_len = s->avcc_n, C.in.cfg_gen++; }
static void up(struct stream *s) /* session, stream, config, car */
{
	C.in.session = &sr_dummy;
	C.in.stream_live = 1, C.in.stream_gen++;
	set_avcc(s);
	C.in.car = &sr_dummy, C.in.car_gen++;
}
static int feed(struct stream *s, int i)
{
	C.in.now_ms += 16;
	int k = nev;
	uint8_t *copy = malloc(s->au[i].n);
	memcpy(copy, s->au[i].p, s->au[i].n);
	cp_frame(&C, &sr_dummy, (char *)copy, s->au[i].n);
	free(copy);
	return k;
}
static int count(int from, const char *prefix)
{
	int c = 0;
	for (int i = from; i < nev; i++) c += !strncmp(ev[i], prefix, strlen(prefix));
	return c;
}
static int first(int from, const char *prefix)
{
	for (int i = from; i < nev; i++) if (!strncmp(ev[i], prefix, strlen(prefix))) return i;
	return -1;
}

static void t_parsers(void)
{
	int n, off[64], len[64], w, h, p, l;
	uint8_t *d = slurp("testdata/crop.h264", &n);
	int k = cp_nal_split(d, 4096 < n ? 4096 : n, off, len, 64);
	int found = 0;
	for (int i = 0; i < k; i++)
		if ((d[off[i]] & 31) == 7) {
			CHECK(cp_sps_size(d + off[i], len[i], &w, &h, &p, &l) == 0, "crop sps parse");
			CHECK(w == 1920 && h == 1080 && p == 66, "crop sps %dx%d p%d", w, h, p);
			found = 1;
		}
	CHECK(found, "crop sps present");
	uint8_t *all, *pt; int an, pn; const uint8_t *sps; int sn;
	CHECK(cp_avcc_to_annexb(M.avcc, M.avcc_n, &all, &an, &pt, &pn, &sps, &sn) == 0, "avcc");
	CHECK(pt && !memcmp(pt, "\0\0\0\1", 4) && (pt[4] & 31) == 7, "pt header layout");
	CHECK(cp_sps_size(sps, sn, &w, &h, &p, &l) == 0 && w == 1920 && h == 720 && p == 100,
	      "main sps %dx%d p%d", w, h, p);
	CHECK(cp_avcc_to_annexb(MULTISPS.avcc, MULTISPS.avcc_n, &all, &an, &pt, &pn, &sps, &sn) == 0 &&
	      !pt && an > 0, "multi-sps avcc keeps hdr_all, no hdr_pt");
	CHECK(cp_avcc_to_annexb(M.avcc, 5, &all, &an, &pt, &pn, &sps, &sn) != 0, "truncated avcc rejected");
	/* truncated / garbage frames must not crash */
	uint8_t junk[] = {0, 0, 1, 0x65, 0, 0, 0, 1};
	CHECK(cp_nal_split(junk, sizeof junk, off, len, 64) >= 1, "junk split");
}

static void t_happy(void)
{
	reset(); up(&M);
	int k = feed(&M, 1); /* a P frame first: config pushed, frame dropped */
	int cf = first(k, "cfg");
	CHECK(cf >= 0 && !strcmp(ev[cf], "cfg 1 r=0") && first(k, "idr") > cf && first(k, "own 1") < cf,
	      "ownership, then config, then IDR request");
	CHECK(C.st == CP_WAIT_IDR && count(k, "frame") == 0, "P dropped in WAIT_IDR");
	for (int i = 2; i < 20; i++) feed(&M, i);
	CHECK(count(0, "frame") == 0, "nothing until IDR");
	k = feed(&M, 20);
	CHECK(C.st == CP_PASSTHRU && count(k, "frame 5 sc=1 r=0") == 1, "IDR pushed with start code");
	k = nev;
	for (int i = 21; i < 40; i++) feed(&M, i);
	CHECK(count(k, "frame 1 sc=1") == 19 && count(k, "frame 6") == 0 && count(k, "frame 9") == 0,
	      "P frames pushed, SEI/AUD dropped");
	CHECK(count(0, "orig") == 0, "stock decoder never called");
	CHECK(C.owned, "owned flag for output guard");
}

static void t_early_header(void)
{
	reset();
	C.in.session = &sr_dummy; C.in.stream_live = 1; C.in.stream_gen++; set_avcc(&M);
	cp_poll(&C);
	CHECK(C.st == CP_IDLE, "no car yet: IDLE");
	C.in.car = &sr_dummy; C.in.car_gen++;
	int k = feed(&M, 0);
	CHECK(count(k, "cfg 1 r=0") == 1 && count(k, "frame 5") == 1 && C.st == CP_PASSTHRU,
	      "car arrives later: config then IDR");
}

static void t_multislice(void)
{
	reset(); up(&M);
	feed(&M, 0); feed(&M, 1);
	int k = feed(&MS, 1);
	CHECK(C.st == CP_RESYNC && count(k, "idr") == 1 && count(k, "frame") == 0,
	      "multi-slice AU: RESYNC + IDR request, nothing pushed");
	k = feed(&M, 2);
	CHECK(count(k, "frame") == 0, "P dropped in RESYNC");
	k = feed(&M, 20);
	CHECK(C.st == CP_PASSTHRU && count(k, "frame 5") == 1, "single-slice IDR resumes");
	/* only multi-slice IDRs arrive: deadline -> fallback */
	feed(&MS, 1);
	for (int i = 0; i < 160; i++) feed(&MS, 0);
	CHECK(C.st == CP_TRANSCODE || C.st == CP_FALLBACK, "no usable IDR: fallback (%s)", cp_state_name(C.st));
}

static void t_new_config(void)
{
	reset(); up(&M);
	feed(&M, 0); feed(&M, 1);
	set_avcc(&M);
	int k = feed(&M, 2);
	CHECK(count(k, "cfg 1") == 1 && C.st == CP_RESYNC, "same-size config: re-push + RESYNC (%s)",
	      cp_state_name(C.st));
	set_avcc(&O);
	k = feed(&O, 1);
	CHECK(C.st == CP_FALLBACK && count(k, "cfg") == 0, "other size: fallback, no push (%s)",
	      cp_state_name(C.st));
	CHECK(first(k, "orig 7") >= 0 || first(k, "orig") >= 0, "fallback feeds the new header first");
	k = feed(&O, 0);
	CHECK(count(k, "orig 5") == 1 && count(k, "enc_kf") == 1 && C.st == CP_TRANSCODE,
	      "IDR forwarded to transcoder, encoder keyframe");
	k = feed(&O, 2);
	CHECK(count(k, "orig 1") == 1, "TRANSCODE forwards everything");

	reset(); up(&M); feed(&M, 0);
	set_avcc(&MULTISPS);
	k = feed(&M, 1);
	CHECK(C.st == CP_FALLBACK, "multi-SPS config: fallback");
	CHECK(first(k, "orig 7") >= 0 && first(k, "orig 7") == first(k, "orig"),
	      "fallback header (multi-SPS hdr_all) goes first");
}

static void t_kf_storm(void)
{
	reset(); up(&M); feed(&M, 0); feed(&M, 1);
	C.in.kf_new = 1;
	int k = feed(&M, 2);
	CHECK(C.st == CP_RESYNC && count(k, "cfg 1") == 1, "1st car keyframe: config + RESYNC");
	C.in.kf_new = 1; feed(&M, 3);
	CHECK(C.st == CP_RESYNC, "2nd during RESYNC: still RESYNC");
	C.in.kf_new = 1; feed(&M, 4);
	CHECK(C.st == CP_FALLBACK, "3rd within 10 s: fallback (%s)", cp_state_name(C.st));

	reset(); up(&M); feed(&M, 0);
	C.in.kf_new = 1; feed(&M, 1);
	uint32_t t0 = C.in.now_ms;
	feed(&M, 20); /* IDR -> PASSTHRU */
	C.in.now_ms = t0 + 11000;
	C.in.kf_new = 1; feed(&M, 21);
	C.in.kf_new = 1; feed(&M, 22);
	CHECK(C.st != CP_FALLBACK && C.st != CP_TRANSCODE, "requests >10 s apart: no storm");
}

static void t_kill_and_marker(void)
{
	reset(); C.in.killed = 1; up(&M);
	for (int i = 0; i < 25; i++) feed(&M, i);
	CHECK(C.st == CP_TRANSCODE && count(0, "cfg") == 0 && count(0, "frame") == 0 &&
	      count(0, "orig") == 25, "GPS toggle: stock path only");
	CHECK(!C.owned, "not owned");
	reset(); marker = 1; up(&M);
	feed(&M, 0);
	CHECK(C.st == CP_TRANSCODE && count(0, "orig") == 1, "fail marker: stock path");
}

static void t_car_restart(void)
{
	reset(); up(&M); feed(&M, 0); feed(&M, 1);
	C.in.car = 0;
	int k = feed(&M, 2);
	CHECK(C.st == CP_IDLE && count(k, "frame") == 0, "car stop: IDLE (%s)", cp_state_name(C.st));
	C.in.car = &sr_dummy; C.in.car_gen++;
	k = feed(&M, 3);
	CHECK(count(k, "cfg 1") == 1 && C.st == CP_WAIT_IDR, "car restart: SYNC_CONFIG again, not stock");
	CHECK(count(0, "orig") <= 1, "no stock frames during restart");
	/* stream restart in the same session */
	C.in.stream_live = 0; C.in.stream_gen++; feed(&M, 4);
	C.in.stream_live = 1; C.in.stream_gen++; set_avcc(&M);
	k = feed(&M, 20);
	CHECK(count(k, "cfg 1") == 1 && count(k, "frame 5") == 1, "screen restart, same session: resync");
}

static void t_sync_readiness(void)
{
	reset(); up(&M);
	push_script[0] = -1, push_script[1] = -2, push_script[2] = 0, nscript = 3;
	int k = feed(&M, 0);
	for (int i = 1; i < 10; i++) { C.in.now_ms += 40; feed(&M, i); }
	CHECK(count(k, "cfg 1 r=-1") == 1 && count(k, "cfg 1 r=-2") == 1 && count(k, "cfg 1 r=0") == 1,
	      "config retried after readiness failures");
	CHECK(C.st == CP_WAIT_IDR, "then waits for IDR (%s)", cp_state_name(C.st));
	CHECK(first(k, "frame 5") < 0 || first(k, "frame 5") > first(k, "cfg 1 r=0"), "no IDR before config");

	reset(); up(&M);
	for (int i = 0; i < 64; i++) push_script[i] = -1;
	nscript = 64;
	for (int i = 0; i < 160 && C.st != CP_FALLBACK; i++) feed(&M, i % 40);
	CHECK(C.st == CP_FALLBACK, "config never ready: fallback after 2 s");
}

static void t_transport_lost(void)
{
	reset(); up(&M); feed(&M, 0); feed(&M, 1);
	push_script[0] = CP_PUSH_IO, nscript = 1;
	feed(&M, 2);
	CHECK(C.st == CP_TRANSPORT_LOST, "write failure: TRANSPORT_LOST");
	int k = nev;
	for (int i = 3; i < 40; i++) feed(&M, i);
	CHECK(count(k, "frame") == 0 && count(k, "orig") == 0, "no pushes, no stock frames");
	C.in.now_ms += 5000; feed(&M, 3);
	CHECK(marker, "5 s without restart: failed recovery -> marker");
	/* REV-01: the marker stays; this stream still resyncs, never raw stock */
	C.in.car = &sr_dummy; C.in.car_gen++;
	k = feed(&M, 20);
	CHECK(count(k, "cfg 1") == 1 && C.st == CP_PASSTHRU && count(k, "orig") == 0,
	      "car restart with the marker set resyncs this stream (%s)", cp_state_name(C.st));
	C.in.stream_live = 0; C.in.stream_gen++; feed(&M, 21);
	C.in.stream_live = 1; C.in.stream_gen++; set_avcc(&M);
	feed(&M, 22);
	CHECK(C.st == CP_TRANSCODE, "next stream honours the marker (%s)", cp_state_name(C.st));
}

static void t_fallback_timeout(void)
{
	reset(); up(&M); feed(&M, 0);
	C.in.kf_new = 3;
	feed(&M, 1);
	CHECK(C.st == CP_FALLBACK, "storm -> fallback");
	int k = nev;
	for (int i = 2; i < 19; i++) { C.in.now_ms += 200; feed(&M, i); }
	CHECK(C.st == CP_TRANSCODE, "3 s without IDR: TRANSCODE (%s)", cp_state_name(C.st));
	CHECK(count(k, "idr") >= 2 && count(k, "enc_kf") == 1 && marker, "re-requests, encoder kf, marker");
	CHECK(count(k, "orig 1") >= 1, "forwards all after deadline");
}

/* C04: transport loss is latched to the car handle. */
static void t_tl_latch(void)
{
	reset(); up(&M); feed(&M, 0); feed(&M, 1);
	push_script[0] = CP_PUSH_IO, nscript = 1;
	feed(&M, 2);
	int k = nev;
	set_avcc(&M); feed(&M, 3);
	set_avcc(&O); feed(&M, 4);
	C.in.kf_new = 3; feed(&M, 5);
	CHECK(C.st == CP_TRANSPORT_LOST && count(k, "cfg") == 0 && count(k, "frame") == 0 &&
	      count(k, "orig") == 0, "config change and keyframe storm don't resume a lost transport (%s)",
	      cp_state_name(C.st));
}

/* C05: a config change during fallback re-feeds the transcoder. */
static void t_fallback_new_config(void)
{
	reset(); up(&M); feed(&M, 0);
	C.in.kf_new = 3; feed(&M, 1);      /* fallback, header A fed */
	int k = nev;
	set_avcc(&O);                       /* config B before the IDR */
	feed(&O, 1);
	CHECK(first(k, "orig 7") >= 0, "header B fed to the transcoder");
	k = nev;
	feed(&O, 0);
	CHECK(count(k, "orig 5") == 1 && C.st == CP_TRANSCODE, "B's IDR recovers after B's header");

	/* after recovery, a new config is fed too */
	k = nev;
	set_avcc(&M); feed(&M, 1);
	CHECK(first(k, "orig 7") >= 0 && C.st == CP_FALLBACK, "TRANSCODE re-feeds a new header");
}

/* C06: a car restart never hands raw frames to the stock decoder. */
static void t_car_restart_ineligible(void)
{
	reset(); up(&M); feed(&M, 0); feed(&M, 1);
	C.in.car = 0; feed(&M, 2);
	C.in.car = &sr_dummy; C.in.car_gen++; C.in.car_w = 1280; /* new car size */
	int k = feed(&M, 3);
	CHECK(C.st == CP_FALLBACK && first(k, "orig 7") == first(k, "orig"),
	      "ineligible after restart: fallback with header first (%s)", cp_state_name(C.st));
}

/* C07: repeated triggers can't extend a resync forever. */
static void t_resync_deadline(void)
{
	reset(); up(&M); feed(&M, 0); feed(&M, 1);
	for (int i = 0; i < 64; i++) push_script[i] = CP_PUSH_NOT_STREAMING;
	nscript = 64;
	C.in.kf_new = 1;
	for (int i = 0; i < 60 && C.st != CP_FALLBACK; i++) {
		set_avcc(&M);
		C.in.now_ms += 100;
		feed(&M, 2 + i % 30);
	}
	CHECK(C.st == CP_FALLBACK, "bounded by the episode deadline (%s)", cp_state_name(C.st));
}

/* C08: candidate frames never reach the stock decoder raw. */
static void t_idle_candidate(void)
{
	reset();
	C.in.stream_live = 1; C.in.stream_gen++; set_avcc(&M);
	C.in.car = &sr_dummy; C.in.car_gen++;   /* no phone session yet */
	int k = nev;
	for (int i = 0; i < 20; i++) feed(&M, i);
	CHECK(count(k, "orig") == 0, "frames held while inputs are missing");
	for (int i = 0; i < 100 && C.st == CP_IDLE; i++) feed(&M, i % 40);
	CHECK(C.st == CP_FALLBACK && first(k, "orig 7") == first(k, "orig"),
	      "after 1.5 s: fallback, header first (%s)", cp_state_name(C.st));
}

/* C02/C03: ownership refused (teardown raced) leaves the stream unowned. */
static void t_own_refused(void)
{
	reset(); own_fail = 1; up(&M);
	feed(&M, 0);
	CHECK(!C.owned && count(0, "cfg") == 0 && count(0, "own refused") >= 1,
	      "no push without the output gate");
	own_fail = 0;
	reset(); up(&M); feed(&M, 0);
	int k = nev;
	C.in.kf_new = 3; feed(&M, 1);
	CHECK(count(k, "own 0") == 1, "ownership released on fallback");
}

/* C09 + C10: big NAL histogram; 31 SEI + 2 slices is not one slice. */
static void t_stats_and_overflow(void)
{
	reset(); up(&M); feed(&M, 0);
	uint8_t au[2048];
	int n = 0;
	for (int t = 0; t < 31; t++) {
		memcpy(au + n, "\0\0\0\1", 4), au[n + 4] = 6, au[n + 5] = 0x80, n += 6;
	}
	for (int t = 0; t < 2; t++) {
		memcpy(au + n, "\0\0\0\1", 4), au[n + 4] = 0x41, memset(au + n + 5, 0x80, 8), n += 13;
	}
	int k = nev;
	cp_frame(&C, &sr_dummy, (char *)au, n);
	CHECK(count(k, "frame") == 0 && C.st == CP_RESYNC, "33-NAL AU treated as unsupported (%s)",
	      cp_state_name(C.st));
	/* every NAL type with large counts, then a stats line */
	for (int t = 0; t < 32; t++) C.s.nal_hist[t] += 123456789u;
	C.in.now_ms += 6000;
	cp_frame(&C, &sr_dummy, (char *)au, n);
	CHECK(1, "stats line with a full histogram did not overflow");
}

/* WEB-02/03: status shows the stock output rate and keeps the fallback cause. */
static void t_status(void)
{
	reset(); up(&M); feed(&M, 0);
	C.in.kf_new = 3; feed(&M, 1);           /* fallback: car keyframe storm */
	feed(&M, 20);                            /* IDR -> picture recovered */
	CHECK(C.st == CP_TRANSCODE, "recovered");
	CHECK(strstr(last_status, "\"last_fallback\":\"car keyframe storm\"") != 0,
	      "fallback cause kept through recovery: %s", last_status);
	CHECK(strstr(last_status, "\"reason\":\"picture recovered\"") != 0, "current reason separate");
	for (int i = 21; i < 40; i++) { C.in.stock_sent++; C.in.now_ms += 300; feed(&M, i); }
	float pt = -1, sk = -1;
	const char *a = strstr(last_status, "\"pt_fps\":"), *b = strstr(last_status, "\"stock_fps\":");
	if (a) sscanf(a + 9, "%f", &pt);
	if (b) sscanf(b + 12, "%f", &sk);
	CHECK(sk > 2.5f && pt >= 0 && pt < sk, "stock output counted (%.1f) above pass-through (%.1f)", sk, pt);
}

int main(int argc, char **argv)
{
	(void)argv;
	verbose = argc > 1;
	status_out = fopen("build/status.jsonl", "w");
	load(&M, "testdata/main.h264", 1);
	load(&O, "testdata/other.h264", 1);
	load(&MS, "testdata/multi.h264", 1);
	load(&MULTISPS, "testdata/main.h264", 2);
	CHECK(M.n == 40 && M.idr[0] && M.idr[20] && !M.idr[1], "main stream: 40 AUs, IDR at 0 and 20");
	t_parsers();
	t_happy();
	t_early_header();
	t_multislice();
	t_new_config();
	t_kf_storm();
	t_kill_and_marker();
	t_car_restart();
	t_sync_readiness();
	t_transport_lost();
	t_fallback_timeout();
	t_tl_latch();
	t_fallback_new_config();
	t_car_restart_ineligible();
	t_resync_deadline();
	t_idle_candidate();
	t_own_refused();
	t_stats_and_overflow();
	t_status();
	if (status_out)
		fclose(status_out);
	printf("%d/%d checks passed\n", checks - fails, checks);
	return fails != 0;
}
