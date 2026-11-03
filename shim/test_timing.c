/* Host tests for the frame-hook timing accumulator (NEXT_TEST_PLAN.md
 * Verification 1). Time is simulated: every timestamp is passed in, nothing
 * sleeps. Writes JSON samples to build/timing/ for check_timing_json.py. */
#include "cpthru_timing.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL %s:%d: ", __FILE__, __LINE__); \
	printf(__VA_ARGS__); printf("\n"); } } while (0)

static struct cp_timing T;
static char J[CPT_JSON_MAX];

/* One callback: entry at t, lock wait lk, params par, one optional push
 * (kind: 0 none, 1 video, 2 config), sender time send, total cb. */
struct fr { uint32_t lk, par, plk, send, cb; int kind, real, ok; };
static int frame(uint32_t t, uint32_t gen, struct fr f)
{
	cp_timing_begin(&T, t, gen);
	cp_timing_span(&T, CPT_LK, f.lk);
	cp_timing_span(&T, CPT_PAR, f.par);
	if (f.kind)
		cp_timing_push(&T, f.kind == 2, f.real, f.ok, f.plk, f.send);
	return cp_timing_end(&T, t + f.cb);
}

static void save(const char *name, int n)
{
	char p[128];
	snprintf(p, sizeof p, "build/timing/%s.json", name);
	FILE *f = fopen(p, "w");
	if (!f) { CHECK(0, "write %s", p); return; }
	fwrite(J, 1, n > 0 ? (size_t)n : 0, f);
	fclose(f);
}

static const struct cpt_win *last(void) { return cp_timing_last(&T); }

static void t_fast_sender(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 1000;
	int closed = 0;
	for (int i = 0; i < 400 && !closed; i++, t += 16)
		closed = frame(t, 1, (struct fr){.lk = 0, .par = 0, .plk = 0, .send = 1, .cb = 2, .kind = 1, .real = 1, .ok = 1});
	const struct cpt_win *w = last();
	CHECK(closed && w, "a window closed after 5 s of frames");
	if (!w) return;
	CHECK(w->len_ms >= 5000 && w->len_ms < 5016, "window length %u", w->len_ms);
	CHECK(w->calls == w->v_ok && w->calls > 300, "every frame sent once: calls %u v_ok %u", w->calls, w->v_ok);
	CHECK(w->first == 1 && w->a[CPT_IV].n == w->calls - 1, "first frame has no interval");
	CHECK(w->a[CPT_IV].max == 16 && w->a[CPT_IV].sum == 16ull * (w->calls - 1), "interval 16 ms");
	CHECK(w->a[CPT_GAP].max == 14, "gap = interval - callback (%u)", w->a[CPT_GAP].max);
	CHECK(w->a[CPT_VSEND].max == 1 && w->slow16 == 0, "fast sender");
	CHECK(w->a[CPT_RES].max == 1, "residual = cb - measured (%u)", w->a[CPT_RES].max);
	int n = cp_timing_json(&T, J, sizeof J, "\"build\":\"test\",\"up_ms\":1");
	CHECK(n > 0 && strstr(J, "\"iv\":{\"n\":") && strstr(J, "\"avg\":16.0"), "JSON has 16.0 ms avg interval");
	save("fast", n);
	char line[512];
	CHECK(cp_timing_logline(&T, line, sizeof line) > 0 && strstr(line, "iv=16.0/16"), "log line: %s", line);
}

static void t_blocked_sender(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 50;
	frame(t, 1, (struct fr){.send = 1, .cb = 2, .kind = 1, .real = 1, .ok = 1});
	t += 16;
	frame(t, 1, (struct fr){.lk = 3, .plk = 5, .send = 120, .cb = 130, .kind = 1, .real = 1, .ok = 1});
	t += 140;
	frame(t, 1, (struct fr){.send = 40, .cb = 41, .kind = 1, .real = 1, .ok = 1});
	t += 50;
	frame(t, 1, (struct fr){.send = 20, .cb = 21, .kind = 1, .real = 1, .ok = 1});
	cp_timing_end(&T, t + 21); /* no-op: not in a frame */
	const struct cpt_win *w = &T.cur;
	CHECK(w->slow100 == 1 && w->slow33 == 2 && w->slow16 == 3, "slow sends %u/%u/%u", w->slow16, w->slow33, w->slow100);
	CHECK(w->a[CPT_VSEND].max == 120 && w->a[CPT_CB].max == 130, "sender time inside callback");
	CHECK(w->a[CPT_LK].max == 3 && w->a[CPT_PLK].max == 5, "lock waits measured");
	CHECK(w->a[CPT_RES].max == 2 && w->a[CPT_RES].n == 4, "residual 130-3-5-120 = 2 (%u)", w->a[CPT_RES].max);
	CHECK(w->a[CPT_IV].max == 140 && w->a[CPT_GAP].max == 14, "blocked callback shows as callback time, not idle");
	CHECK(w->calls == 4 && w->a[CPT_CB].n == 4, "end outside a frame ignored");
}

static void t_slow_arrival(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 7;
	for (int i = 0; i < 50; i++, t += 125)
		frame(t, 3, (struct fr){.send = 0, .cb = 1, .kind = 1, .real = 1, .ok = 1});
	const struct cpt_win *w = last();
	CHECK(w != 0, "closed");
	if (!w) return;
	CHECK(w->a[CPT_IV].max == 125 && w->a[CPT_GAP].max == 124 && w->a[CPT_CB].max == 1,
	      "slow arrival: long gaps, fast callback (iv %u gap %u cb %u)", w->a[CPT_IV].max, w->a[CPT_GAP].max,
	      w->a[CPT_CB].max);
	CHECK(w->gen == 3, "generation label");
}

static void t_wrap(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 0xFFFFFF00u;
	int closed = 0;
	for (int i = 0; i < 400 && !closed; i++, t += 16)
		closed = frame(t, 1, (struct fr){.send = 1, .cb = 3, .kind = 1, .real = 1, .ok = 1});
	const struct cpt_win *w = last();
	CHECK(closed && w, "window closes across the wrap");
	if (!w) return;
	CHECK(w->a[CPT_IV].max == 16 && w->a[CPT_GAP].max == 13 && w->len_ms < 5020,
	      "no huge values at the wrap (iv %u gap %u len %u)", w->a[CPT_IV].max, w->a[CPT_GAP].max, w->len_ms);
}

static void t_generation(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 100;
	for (int i = 0; i < 10; i++, t += 16)
		CHECK(!frame(t, 5, (struct fr){.send = 1, .cb = 2, .kind = 1, .real = 1, .ok = 1}), "no publish mid-window");
	t += 3000; /* stream restarted after 3 s */
	int pub = frame(t, 6, (struct fr){.send = 1, .cb = 2, .kind = 1, .real = 1, .ok = 1});
	const struct cpt_win *w = last();
	CHECK(pub && w && w->gen == 5 && w->calls == 10, "generation change closes and publishes the old window");
	if (w) CHECK(w->len_ms == 9 * 16 + 2, "old window ends at its last exit (%u)", w->len_ms);
	CHECK(T.cur.gen == 6 && T.cur.calls == 1 && T.cur.first == 1 && T.cur.a[CPT_IV].n == 0,
	      "first frame of the new stream has no interval");
	frame(t + 16, 6, (struct fr){.cb = 1});
	CHECK(T.cur.a[CPT_IV].n == 1 && T.cur.a[CPT_IV].max == 16, "intervals resume in the new stream");
}

static void t_missing_clock(void)
{
	cp_timing_init(&T, 0);
	for (uint32_t t = 0; t < 20000; t += 16)
		CHECK(!frame(t, 1, (struct fr){.send = 1, .cb = 2, .kind = 1, .real = 1, .ok = 1}), "never publishes");
	CHECK(T.ring_n == 0 && T.cur.calls == 0, "nothing accumulated");
	int n = cp_timing_json(&T, J, sizeof J, "\"build\":\"test\"");
	CHECK(n > 0 && strstr(J, "\"available\":0") && strstr(J, "\"windows\":[]"), "unavailable JSON: %s", J);
	save("unavailable", n);
	char line[64];
	CHECK(cp_timing_logline(&T, line, sizeof line) == -1, "no log line without windows");
}

static void t_counts(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 10;
	frame(t, 1, (struct fr){.cb = 1}); /* dropped frame: no push */
	CHECK(T.cur.v_ok == 0 && T.cur.a[CPT_VSEND].n == 0, "zero counts");
	frame(t += 16, 1, (struct fr){.plk = 2, .send = 4, .cb = 7, .kind = 2, .real = 1, .ok = 1});
	frame(t += 16, 1, (struct fr){.plk = 1, .cb = 2, .kind = 1, .real = 0});
	frame(t += 16, 1, (struct fr){.send = 9, .cb = 10, .kind = 1, .real = 1, .ok = 0});
	frame(t += 16, 1, (struct fr){.cb = 1, .kind = 2, .real = 0});
	frame(t += 16, 1, (struct fr){.send = 3, .cb = 4, .kind = 2, .real = 1, .ok = 0});
	struct cpt_win *w = &T.cur;
	CHECK(w->c_ok == 1 && w->c_fail == 1 && w->c_gate == 1, "config ok/fail/gate %u/%u/%u", w->c_ok, w->c_fail, w->c_gate);
	CHECK(w->v_ok == 0 && w->v_fail == 1 && w->v_gate == 1, "video ok/fail/gate %u/%u/%u", w->v_ok, w->v_fail, w->v_gate);
	CHECK(w->a[CPT_CSEND].n == 2 && w->a[CPT_CSEND].max == 4, "config sends timed separately");
	CHECK(w->a[CPT_VSEND].n == 1 && w->a[CPT_VSEND].max == 9 && w->slow16 == 0, "only real video sends timed");
	CHECK(w->a[CPT_PLK].n == 5, "push lock wait counted for every push, including gated ones");
	/* rest of the window is idle; next frame after 6 s closes it */
	int n = frame(t += 6000, 1, (struct fr){.cb = 1});
	CHECK(n == 1 && last() && last()->calls == 7, "closing frame included in the closed window");
	n = cp_timing_json(&T, J, sizeof J, "");
	static const char lead[] = "{\"v\":1,\"available\":1,";
	CHECK(n > 0 && !strncmp(J, lead, sizeof lead - 1), "empty head: %.40s", J);
	CHECK(strstr(J, "\"vsend\":{\"n\":1,\"avg\":9.0,\"max\":9,\"sum\":9}") != 0, "stat object shape");
	CHECK(strstr(J, "\"cb\":{\"n\":7,\"avg\":3.7,") != 0, "fixed-point average 26/7 = 3.7");
	save("counts", n);
	/* Regression: the exact head publish_timing() writes (spaces, nulls). */
	n = cp_timing_json(&T, J, sizeof J,
		"\"build\":\"1b93a4b1163f\",\"up_ms\":200000,\"mono_ms\":199000,\"session_mono_ms\":null,"
		"\"stock_sent\":0,\"stock_suppressed\":12,\"info_source\":\"last value returned by sd_get_info_int\","
		"\"info\":{\"VIDEO_WIDTH\":{\"calls\":2,\"last_mono_ms\":150100,\"stock\":800,\"returned\":1920,\"override\":1},"
		"\"VIDEO_HEIGHT\":{\"calls\":2,\"last_mono_ms\":150100,\"stock\":480,\"returned\":720,\"override\":1},"
		"\"VIDEO_FPS\":{\"calls\":0,\"last_mono_ms\":null,\"stock\":null,\"returned\":null,\"override\":null}}");
	CHECK(n > 0 && strstr(J, "\"info_source\":\"last value returned by sd_get_info_int\",\"info\":{"), "production head");
	save("production", n);
}

static void t_publish_accounting(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 0;
	int pub = 0;
	for (; !pub; t += 20)
		pub = frame(t, 1, (struct fr){.cb = 2});
	uint32_t exit = t - 20 + 2;
	cp_timing_published(&T, exit, exit + 7);
	CHECK(T.cur.a[CPT_PUB].n == 1 && T.cur.a[CPT_PUB].max == 7, "publication cost recorded");
	frame(t, 1, (struct fr){.cb = 2});
	CHECK(T.cur.a[CPT_GAP].max == 20 - 2 - 7, "gap excludes publication (%u)", T.cur.a[CPT_GAP].max);
	CHECK(T.cur.a[CPT_IV].max == 20, "interval still entry to entry");
}

static void t_ring_and_large(void)
{
	cp_timing_init(&T, 1);
	uint32_t t = 0;
	for (int w = 0; w < 30; w++) {
		frame(t, (uint32_t)w / 10, (struct fr){.cb = 1});
		frame(t += 5000, (uint32_t)w / 10, (struct fr){.cb = 1});
		t += 10;
	}
	CHECK(T.ring_n == CPT_RING, "ring bounded at %d (%d)", CPT_RING, T.ring_n);
	int n = cp_timing_json(&T, J, sizeof J, "");
	const char *first = strstr(J, "\"windows\":[{\"seq\":");
	unsigned seq0 = 0;
	if (first) sscanf(first + 18, "%u", &seq0);
	CHECK(seq0 == T.seq - CPT_RING + 1, "oldest window first (seq %u of %u)", seq0, T.seq);
	save("ring", n);

	/* Worst case: every counter and total at its maximum. */
	for (int i = 0; i < CPT_RING; i++) {
		struct cpt_win *w = &T.ring[i];
		memset(w, 0xff, sizeof *w);
		for (int s = 0; s < CPT_NSTAT; s++)
			w->a[s].n = 0xffffffffu, w->a[s].max = 0xffffffffu, w->a[s].sum = ~0ull;
	}
	char head[1024];
	memset(head, 0, sizeof head);
	snprintf(head, sizeof head, "\"build\":\"0123456789ab\",\"up_ms\":4294967295,\"pad\":\"%0900d\"", 0);
	n = cp_timing_json(&T, J, sizeof J, head);
	CHECK(n > 0 && n < CPT_JSON_MAX, "worst-case JSON fits the bound (%d of %d)", n, CPT_JSON_MAX);
	CHECK(strstr(J, "\"sum\":18446744073709551615") && strstr(J, "\"avg\":4294967297.0"),
	      "uint64 totals and integer averages");
	save("large", n);
	char small[2000];
	CHECK(cp_timing_json(&T, small, sizeof small, head) == -1 && small[0] == 0, "too small: -1, no half JSON");
	char line[512];
	CHECK(cp_timing_logline(&T, line, sizeof line) > 0 && strlen(line) < sizeof line, "worst-case log line bounded");
	CHECK(cp_timing_logline(&T, line, 40) == -1 && line[0] == 0, "short log buffer refused");
}

int main(void)
{
	mkdir("build", 0755);
	mkdir("build/timing", 0755);
	t_fast_sender();
	t_blocked_sender();
	t_slow_arrival();
	t_wrap();
	t_generation();
	t_missing_clock();
	t_counts();
	t_publish_accounting();
	t_ring_and_large();
	printf("%d/%d timing checks passed\n", checks - fails, checks);
	return fails != 0;
}
