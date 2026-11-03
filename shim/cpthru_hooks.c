/* Device glue for libcpthru.so (LD_PRELOAD into sdDongle). Interposes the
 * PLT-bound firmware calls listed in PASSTHROUGH_PLAN.md and feeds the core.
 * The ScreenStream* originals are libAirPlaySupport's stubs (they forward
 * unchanged arguments to libScreenStream through a dlsym table).
 *
 * Threading: all core state is owned by the frame thread (the
 * setCarlinkH264Data hook). Hooks running on other threads only publish
 * events through atomics or leaf locks that never call out.
 *
 * Output gate (out_lk, C02/C03): every send to the car, the shim's and the
 * stock encoder path's, happens under out_lk. g_owned says who may send.
 * Taking ownership takes out_lk, so it waits for an admitted stock send to
 * finish, and it fails if g_epoch moved since the frame began. Teardown hooks
 * (screen stream start/stop, session end, car stop) release ownership and bump
 * g_epoch under out_lk immediately, without waiting for another frame. Lock
 * order is always caller's firmware locks -> out_lk -> the sender's internal
 * mutex; nothing takes out_lk while holding the sender's mutex.
 *
 * sess_lk is held across ForceKeyFrame so Finalize can wait for an in-flight
 * request before the session is freed.
 *
 * Timing (diagnostic build, cpthru_timing.h): the frame thread owns T and
 * timestamps its own callback with the firmware's get_current_mono_time_ms
 * only (no new clock imports, no per-frame /proc reads, logging or
 * allocation). Without that helper timing is reported unavailable. Forwarding
 * and the core's clock fallback are unchanged.
 */
#define _GNU_SOURCE
#include "cpthru_core.h"
#include "cpthru_timing.h"
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef CP_BUILD_ID
#define CP_BUILD_ID "dev"
#endif
#define MARKER "/mnt/UDISK/cpthru.fail." CP_BUILD_ID
#define KF_PROP "sys.suding.force.key.frame"
#define OFF_PROP "persist.cpthru.off" /* the web page switch: 1 = stock */
#define STATUS "/tmp/cpthru.status"
#define LINK "/tmp/cpthru.link"
#define TIMING "/tmp/cpthru.timing"

/* zig's musl headers redirect dlsym to __dlsym_time64, which the device's
 * musl 1.1.24 doesn't have; bind the plain symbol instead. */
void *cp_dlsym(void *handle, const char *name) __asm__("dlsym");

#define LOAD(a) __atomic_load_n(&(a), __ATOMIC_ACQUIRE)
#define STORE(a, v) __atomic_store_n(&(a), (v), __ATOMIC_RELEASE)
#define BUMP(a) __atomic_add_fetch(&(a), 1, __ATOMIC_ACQ_REL)

/* Originals. */
static void (*r_setdata)(void *, char *, int);
static void *(*r_video_start)(void);
static void *(*r_video_force_start)(void);
static void (*r_video_stop)(void *);
static int (*r_push)(void *, uint8_t *, int, int);
static int (*r_prop_set)(const char *, const char *);
static int (*r_info_int)(const char *, int);
static int (*r_ss_start)(void *, void *, void *);
static void (*r_ss_stop)(void *, void *);
static int (*r_ss_avcc)(void *, const uint8_t *, size_t);
static int (*r_sess_init)(void *);
static void (*r_sess_fini)(void *);
/* Firmware helpers we call. */
static int (*f_force_kf)(void *, void *, void *);
static int (*f_car_params)(int *, int *, int *);
static int (*f_prop_get_int)(const char *, int);
static int (*f_mono_ms)(void);

/* Published events. */
static void *g_session, *g_car;
static unsigned g_stream_gen, g_cfg_gen, g_car_gen;
static int g_stream_live, g_killed, g_kf;
static unsigned g_stock_sent;   /* stock frames let through the gate */
static pthread_mutex_t link_lk = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t cfg_lk = PTHREAD_MUTEX_INITIALIZER;
static uint8_t *g_avcc;
static int g_avcc_len;
static pthread_mutex_t out_lk = PTHREAD_MUTEX_INITIALIZER;
static int g_owned;            /* guarded by out_lk */
static unsigned g_epoch;       /* bumped by teardown hooks under out_lk */
static unsigned f_epoch;       /* epoch seen at the start of this frame */
static pthread_mutex_t sess_lk = PTHREAD_MUTEX_INITIALIZER;

static struct cp C;            /* frame thread only */
static uint8_t *f_avcc;        /* frame thread's copy of the avcC */
static unsigned f_cfg_gen;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static const char build_tag[] = "cpthru-build-id=" CP_BUILD_ID;

/* Timing (frame thread only, except the atomics below). */
static struct cp_timing T;
static int t_on;               /* set once in init: f_mono_ms resolved */
static char t_json[CPT_JSON_MAX];
static unsigned g_stock_suppressed; /* stock sends dropped by the ownership gate */
static unsigned g_session_mono, g_session_seen;
/* Last value returned by sd_get_info_int per video key (other thread). This
 * is what the shim handed back, not proof of what the phone was advertised. */
struct info_rec { unsigned calls, mono, mono_ok, stock_ok, ovr; int stock, ret; };
static struct info_rec g_info[3];
static const char *const info_keys[3] = {"VIDEO_WIDTH", "VIDEO_HEIGHT", "VIDEO_FPS"};

static uint32_t mono(void) { return (uint32_t)f_mono_ms(); } /* only when t_on */

static void *next(const char *name)
{
	void *p = cp_dlsym(RTLD_NEXT, name);
	if (!p)
		fprintf(stderr, "cpthru: missing %s\n", name);
	return p;
}

static void op_status(void *ctx, const char *json);
static void write_file(const char *path, const char *text);
static void publish_timing(void);

static void log_line(void *ctx, const char *line)
{
	(void)ctx;
	fprintf(stderr, "%s\n", line);
	fflush(stderr);
}

/* The sender returns -1 both when the handle isn't streaming and when a
 * write fails part way (libSdUtils writen), so check readiness here first,
 * from the fields push_frame itself tests: fd at +0 (< 0 -> -2) and the
 * streaming flag at +0x258 (0 -> -1). Any failure of the real call is then
 * an I/O failure (C01). The sender's global "connected" flag can't be read
 * from here; if it's off the call fails with -1 and is treated as I/O too,
 * which only costs waiting for the car to restart its handle. */
static int op_push(void *ctx, void *car, uint8_t *buf, int len, int flag)
{
	(void)ctx;
	int r, real = 0;
	uint32_t t0 = t_on ? mono() : 0, t1 = 0, t2 = 0, t3 = 0;
	pthread_mutex_lock(&out_lk);
	if (t_on)
		t1 = mono();
	if (!car || LOAD(g_car) != car || !g_owned || g_epoch != f_epoch || !r_push)
		r = CP_PUSH_NOT_STREAMING;
	else if (((int *)car)[0] < 0)
		r = CP_PUSH_BAD_FD;
	else if (((int *)car)[0x96] == 0)
		r = CP_PUSH_NOT_STREAMING;
	else {
		real = 1;
		if (t_on)
			t2 = mono();
		r = r_push(car, buf, len, flag) < 0 ? CP_PUSH_IO : 0;
		if (t_on)
			t3 = mono();
	}
	pthread_mutex_unlock(&out_lk);
	if (t_on)
		cp_timing_push(&T, flag != 0, real, r == 0, t1 - t0, t3 - t2);
	return r;
}

static int op_set_owned(void *ctx, int own)
{
	(void)ctx;
	int ok = 1;
	pthread_mutex_lock(&out_lk);
	if (own && g_epoch != f_epoch)
		ok = 0;
	else
		g_owned = own;
	pthread_mutex_unlock(&out_lk);
	return ok;
}

/* Teardown: stop the shim sending now; the core catches up on its next frame. */
static void release(const char *why)
{
	pthread_mutex_lock(&out_lk);
	int was = g_owned;
	g_owned = 0;
	g_epoch++;
	pthread_mutex_unlock(&out_lk);
	if (was)
		fprintf(stderr, "cpthru: ownership released (%s)\n", why);
}

static void op_request_idr(void *ctx)
{
	(void)ctx;
	pthread_mutex_lock(&sess_lk);
	void *s = LOAD(g_session);
	if (s && f_force_kf)
		f_force_kf(s, 0, 0);
	pthread_mutex_unlock(&sess_lk);
}

static void op_orig_setdata(void *ctx, void *sr, char *buf, int len)
{
	(void)ctx;
	uint32_t t0 = t_on ? mono() : 0;
	if (r_setdata)
		r_setdata(sr, buf, len);
	if (t_on)
		cp_timing_span(&T, CPT_ORIG, mono() - t0);
}

static void op_encoder_keyframe(void *ctx)
{
	(void)ctx;
	if (r_prop_set)
		r_prop_set(KF_PROP, "1");
}

static int op_marker_exists(void *ctx)
{
	(void)ctx;
	return access(MARKER, F_OK) == 0;
}

static void op_marker_write(void *ctx)
{
	(void)ctx;
	int fd = open(MARKER, O_CREAT | O_WRONLY, 0644);
	if (fd >= 0)
		close(fd);
}

static void init(void)
{
	r_setdata = next("_ZN12ScreenRecord18setCarlinkH264DataEPci");
	r_video_start = next("carplay_reverse_video_start");
	r_video_force_start = next("carplay_reverse_video_force_start");
	r_video_stop = next("carplay_reverse_video_stop");
	r_push = next("carplay_reverse_video_push_frame");
	r_prop_set = next("wrap_system_property_set");
	r_info_int = next("sd_get_info_int");
	r_ss_start = next("ScreenStreamStart");
	r_ss_stop = next("ScreenStreamStop");
	r_ss_avcc = next("ScreenStreamSetAVCC");
	r_sess_init = next("AirPlayReceiverSessionPlatformInitialize");
	r_sess_fini = next("AirPlayReceiverSessionPlatformFinalize");
	f_force_kf = cp_dlsym(RTLD_DEFAULT, "AirPlayReceiverSessionForceKeyFrame");
	f_car_params = cp_dlsym(RTLD_DEFAULT, "carplay_reverse_get_video_parameters");
	f_prop_get_int = cp_dlsym(RTLD_DEFAULT, "prop_get_int");
	f_mono_ms = cp_dlsym(RTLD_DEFAULT, "get_current_mono_time_ms");
	struct cp_ops o = {.push = op_push, .request_idr = op_request_idr,
			   .orig_setdata = op_orig_setdata, .encoder_keyframe = op_encoder_keyframe,
			   .set_owned = op_set_owned, .marker_exists = op_marker_exists,
			   .marker_write = op_marker_write, .log = log_line, .status = op_status};
	cp_init(&C, &o);
	t_on = f_mono_ms != 0;
	cp_timing_init(&T, t_on);
	if (!t_on)
		publish_timing(); /* says "available":0 once; nothing else ever runs */
	write_file("/tmp/cpthru.build", CP_BUILD_ID "\n"); /* the page matches markers to it */
	fprintf(stderr, "cpthru: loaded %s (kf=%p car=%p prop=%p ms=%p)\n", build_tag,
		(void *)f_force_kf, (void *)f_car_params, (void *)f_prop_get_int, (void *)f_mono_ms);
}

static void ensure(void) { pthread_once(&once, init); }

static uint32_t now_ms(void)
{
	if (f_mono_ms)
		return (uint32_t)f_mono_ms();
	FILE *f = fopen("/proc/uptime", "r");
	double up = 0;
	if (f) {
		if (fscanf(f, "%lf", &up) != 1)
			up = 0;
		fclose(f);
	}
	return (uint32_t)(up * 1000);
}

static int killed(void)
{
	return f_prop_get_int && f_prop_get_int(OFF_PROP, 0) == 1;
}

/* /proc/uptime in ms: the web page compares file times with it. */
static unsigned uptime_ms(void)
{
	FILE *f = fopen("/proc/uptime", "r");
	double up = 0;
	if (f) {
		if (fscanf(f, "%lf", &up) != 1)
			up = 0;
		fclose(f);
	}
	return (unsigned)(up * 1000);
}

/* Atomic replace: readers see the old or the new file, never half. */
static void write_file(const char *path, const char *text)
{
	char tmp[64];
	snprintf(tmp, sizeof tmp, "%s.tmp", path);
	FILE *f = fopen(tmp, "w");
	if (!f)
		return;
	fputs(text, f);
	if (fclose(f) == 0)
		rename(tmp, path);
}

static void op_status(void *ctx, const char *json)
{
	(void)ctx;
	char buf[1024];
	snprintf(buf, sizeof buf, "{\"build\":\"%s\",\"up_ms\":%u,%s\n", CP_BUILD_ID, uptime_ms(),
		 json + 1);
	write_file(STATUS, buf);
}

/* Connection events, published by the hooks themselves so the page sees a
 * disconnect even when no frame follows it (WEB-01). Never touches core state. */
static void publish_link(const char *event)
{
	char buf[256];
	pthread_mutex_lock(&link_lk);
	snprintf(buf, sizeof buf,
		 "{\"up_ms\":%u,\"stream\":%d,\"session\":%d,\"car\":%d,\"event\":\"%s\"}\n",
		 uptime_ms(), LOAD(g_stream_live), LOAD(g_session) != 0, LOAD(g_car) != 0, event);
	write_file(LINK, buf);
	pthread_mutex_unlock(&link_lk);
}

/* "null" or the number, into a caller buffer. */
static const char *num_or_null(char *b, int n, int ok, long long v)
{
	if (!ok)
		return "null";
	snprintf(b, n, "%lld", v);
	return b;
}

/* Timing file: every closed window (about every 5 s, and at a stream change),
 * frame thread only. Bounded JSON, replaced atomically; plus one log line. */
static void publish_timing(void)
{
	char head[1024], s[8][24];
	int k = snprintf(head, sizeof head,
			 "\"build\":\"%s\",\"up_ms\":%u,\"mono_ms\":%s,\"session_mono_ms\":%s,"
			 "\"stock_sent\":%u,\"stock_suppressed\":%u,\"info_source\":\"last value returned by sd_get_info_int\",\"info\":{",
			 CP_BUILD_ID, uptime_ms(), num_or_null(s[0], 24, t_on, t_on ? mono() : 0),
			 num_or_null(s[1], 24, LOAD(g_session_seen), LOAD(g_session_mono)),
			 LOAD(g_stock_sent), LOAD(g_stock_suppressed));
	for (int i = 0; i < 3 && k > 0 && k < (int)sizeof head; i++) {
		struct info_rec *r = &g_info[i];
		unsigned calls = LOAD(r->calls);
		int w = snprintf(head + k, sizeof head - k,
				 "%s\"%s\":{\"calls\":%u,\"last_mono_ms\":%s,\"stock\":%s,\"returned\":%s,\"override\":%s}",
				 i ? "," : "", info_keys[i], calls,
				 num_or_null(s[2], 24, calls && LOAD(r->mono_ok), LOAD(r->mono)),
				 num_or_null(s[3], 24, calls && LOAD(r->stock_ok), LOAD(r->stock)),
				 num_or_null(s[4], 24, calls, LOAD(r->ret)),
				 num_or_null(s[5], 24, calls, LOAD(r->ovr)));
		k = w < 0 ? -1 : k + w;
	}
	if (k <= 0 || k + 2 > (int)sizeof head)
		return; /* can't happen with these fixed sizes; never write half */
	head[k++] = '}', head[k] = 0;
	if (cp_timing_json(&T, t_json, sizeof t_json, head) > 0)
		write_file(TIMING, t_json);
	char line[512];
	if (cp_timing_logline(&T, line, sizeof line) > 0)
		log_line(0, line);
}

/* ---- the frame hook ---------------------------------------------------- */

void cp_setdata(void *sr, char *buf, int len) __asm__("_ZN12ScreenRecord18setCarlinkH264DataEPci");
void cp_setdata(void *sr, char *buf, int len)
{
	ensure();
	struct cp_in *in = &C.in;
	uint32_t te = 0;
	if (t_on) {
		te = mono(); /* entry, before the first lock */
		cp_timing_begin(&T, te, LOAD(g_stream_gen));
	}
	pthread_mutex_lock(&out_lk);
	if (t_on)
		cp_timing_span(&T, CPT_LK, mono() - te);
	f_epoch = g_epoch;
	pthread_mutex_unlock(&out_lk);
	in->now_ms = now_ms();
	in->session = LOAD(g_session);
	in->stream_gen = LOAD(g_stream_gen);
	in->stream_live = LOAD(g_stream_live);
	in->killed = LOAD(g_killed);
	in->car = LOAD(g_car);
	in->car_gen = LOAD(g_car_gen);
	in->kf_new = __atomic_exchange_n(&g_kf, 0, __ATOMIC_ACQ_REL);
	in->stock_sent = LOAD(g_stock_sent);
	if (f_car_params) {
		uint32_t tp = t_on ? mono() : 0;
		f_car_params(&in->car_w, &in->car_h, &in->car_fps);
		if (t_on)
			cp_timing_span(&T, CPT_PAR, mono() - tp);
	}
	unsigned gen = LOAD(g_cfg_gen);
	if (gen != f_cfg_gen) {
		pthread_mutex_lock(&cfg_lk);
		gen = g_cfg_gen;
		free(f_avcc);
		f_avcc = 0;
		in->avcc_len = 0;
		if (g_avcc && (f_avcc = malloc(g_avcc_len))) {
			memcpy(f_avcc, g_avcc, g_avcc_len);
			in->avcc_len = g_avcc_len;
		}
		pthread_mutex_unlock(&cfg_lk);
		f_cfg_gen = gen;
		in->avcc = f_avcc;
		in->cfg_gen = gen;
	}
	cp_frame(&C, sr, buf, len);
	if (t_on && cp_timing_end(&T, mono())) {
		uint32_t a = mono();
		publish_timing();
		cp_timing_published(&T, a, mono());
	}
}

/* ---- event hooks (other threads) ---------------------------------------- */

static void *car_started(void *h)
{
	if (h) {
		STORE(g_car, h);
		BUMP(g_car_gen);
		fprintf(stderr, "cpthru: car video start %p\n", h);
		publish_link("car video start");
	}
	return h;
}

void *carplay_reverse_video_start(void)
{
	ensure();
	return car_started(r_video_start ? r_video_start() : 0);
}

void *carplay_reverse_video_force_start(void)
{
	ensure();
	return car_started(r_video_force_start ? r_video_force_start() : 0);
}

void carplay_reverse_video_stop(void *h)
{
	ensure();
	if (h && LOAD(g_car) == h) {
		STORE(g_car, (void *)0);
		release("car video stop"); /* also waits for an in-flight push */
		fprintf(stderr, "cpthru: car video stop %p\n", h);
		publish_link("car video stop");
	}
	if (r_video_stop)
		r_video_stop(h);
}

/* Output guard: while the shim owns the car stream, drop everything the stock
 * encoder path tries to send (the shim calls the original directly). */
int carplay_reverse_video_push_frame(void *h, uint8_t *buf, int len, int flag)
{
	ensure();
	int r = 0;
	pthread_mutex_lock(&out_lk);
	if (!g_owned) {
		r = r_push ? r_push(h, buf, len, flag) : -1;
		if (flag == 0 && r >= 0)
			BUMP(g_stock_sent); /* WEB-02: stock frames actually sent */
	} else if (flag == 0) {
		BUMP(g_stock_suppressed); /* diagnostics only; behaviour unchanged */
	}
	pthread_mutex_unlock(&out_lk);
	return r;
}

int wrap_system_property_set(const char *k, const char *v)
{
	ensure();
	int r = r_prop_set ? r_prop_set(k, v) : -1;
	if (k && v && !strcmp(k, KF_PROP) && strcmp(v, "0"))
		BUMP(g_kf);
	return r;
}

/* Record what sd_get_info_int handed back for a video key (atomics; read by
 * the frame thread's timing publication). */
static int note_info(int i, int orig, int ret, int ovr)
{
	struct info_rec *r = &g_info[i];
	STORE(r->stock_ok, r_info_int != 0);
	STORE(r->stock, orig);
	STORE(r->ret, ret);
	STORE(r->ovr, (unsigned)ovr);
	if (f_mono_ms) {
		STORE(r->mono, (unsigned)f_mono_ms());
		STORE(r->mono_ok, 1u);
	}
	BUMP(r->calls);
	return ret;
}

int sd_get_info_int(const char *key, int def)
{
	ensure();
	int orig = r_info_int ? r_info_int(key, def) : def;
	int w = 0, h = 0, fps = 0, *pick = 0, idx = -1;
	if (!key)
		return orig;
	if (!strcmp(key, "VIDEO_WIDTH"))
		pick = &w, idx = 0;
	else if (!strcmp(key, "VIDEO_HEIGHT"))
		pick = &h, idx = 1;
	else if (!strcmp(key, "VIDEO_FPS"))
		pick = &fps, idx = 2;
	if (!pick)
		return orig;
	if (killed() || op_marker_exists(0) || !f_car_params)
		return note_info(idx, orig, orig, 0);
	f_car_params(&w, &h, &fps);
	if (w <= 0 || h <= 0 || fps <= 0)
		return note_info(idx, orig, orig, 0);
	fprintf(stderr, "cpthru: phone display %s = %d (stock %d)\n", key, *pick, orig);
	return note_info(idx, orig, *pick, 1);
}

int ScreenStreamStart(void *a, void *b, void *c)
{
	ensure();
	STORE(g_killed, killed());
	STORE(g_stream_live, 1);
	BUMP(g_stream_gen);
	release("screen stream start");
	fprintf(stderr, "cpthru: screen stream start (cpthru.off=%d)\n",
		f_prop_get_int ? f_prop_get_int(OFF_PROP, 0) : -1);
	publish_link("screen stream start");
	return r_ss_start ? r_ss_start(a, b, c) : -1;
}

void ScreenStreamStop(void *a, void *b)
{
	ensure();
	STORE(g_stream_live, 0);
	BUMP(g_stream_gen);
	release("screen stream stop");
	fprintf(stderr, "cpthru: screen stream stop\n");
	publish_link("screen stream stop");
	if (r_ss_stop)
		r_ss_stop(a, b);
}

int ScreenStreamSetAVCC(void *ctx, const uint8_t *avcc, size_t len)
{
	ensure();
	pthread_mutex_lock(&cfg_lk);
	free(g_avcc);
	g_avcc = 0, g_avcc_len = 0;
	if (avcc && len > 0 && len < 4096 && (g_avcc = malloc(len))) {
		memcpy(g_avcc, avcc, len);
		g_avcc_len = (int)len;
	}
	BUMP(g_cfg_gen);
	pthread_mutex_unlock(&cfg_lk);
	return r_ss_avcc ? r_ss_avcc(ctx, avcc, len) : -1;
}

int AirPlayReceiverSessionPlatformInitialize(void *s)
{
	ensure();
	int r = r_sess_init ? r_sess_init(s) : -1;
	if (f_mono_ms) {
		STORE(g_session_mono, (unsigned)f_mono_ms());
		STORE(g_session_seen, 1u);
	}
	STORE(g_session, s);
	fprintf(stderr, "cpthru: phone session %p\n", s);
	publish_link("phone session start");
	return r;
}

void AirPlayReceiverSessionPlatformFinalize(void *s)
{
	ensure();
	pthread_mutex_lock(&sess_lk); /* wait for an in-flight keyframe request */
	if (LOAD(g_session) == s)
		STORE(g_session, (void *)0);
	pthread_mutex_unlock(&sess_lk);
	release("phone session end");
	fprintf(stderr, "cpthru: phone session %p ended\n", s);
	publish_link("phone session end");
	if (r_sess_fini)
		r_sess_fini(s);
}
