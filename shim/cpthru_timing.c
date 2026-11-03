/* Frame-hook timing accumulator. See cpthru_timing.h for the accounting. */
#include "cpthru_timing.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static const char *stat_names[CPT_NSTAT] = {
	"cb", "iv", "gap", "lk", "par", "plk", "vsend", "csend", "orig", "res", "pub"
};

static void acc(struct cpt_acc *a, uint32_t v)
{
	a->n++;
	a->sum += v;
	if (v > a->max)
		a->max = v;
}

static void start_window(struct cp_timing *t, uint32_t now, uint32_t gen)
{
	memset(&t->cur, 0, sizeof t->cur);
	t->cur.t0 = now;
	t->cur.gen = gen;
	t->open = 1;
}

static void close_window(struct cp_timing *t, uint32_t end)
{
	t->cur.len_ms = end - t->cur.t0;
	t->cur.seq = ++t->seq;
	t->ring[t->ring_head] = t->cur;
	t->ring_head = (t->ring_head + 1) % CPT_RING;
	if (t->ring_n < CPT_RING)
		t->ring_n++;
	t->open = 0;
	t->dirty = 1;
}

void cp_timing_init(struct cp_timing *t, int available)
{
	memset(t, 0, sizeof *t);
	t->available = available != 0;
}

void cp_timing_begin(struct cp_timing *t, uint32_t now, uint32_t gen)
{
	if (!t->available)
		return;
	if (t->open && gen != t->gen) {
		/* New stream generation: its frames get their own window and no
		 * interval back into the old stream. */
		if (t->cur.calls)
			close_window(t, t->last_exit);
		t->open = 0;
		t->have_prev = 0;
	}
	if (!t->open) {
		start_window(t, now, gen);
		t->gen = gen;
	}
	t->cur.calls++;
	if (t->have_prev) {
		acc(&t->cur.a[CPT_IV], now - t->last_entry);
		acc(&t->cur.a[CPT_GAP], now - t->last_exit);
	} else {
		t->cur.first++;
	}
	t->entry = now;
	t->measured = 0;
	t->in_frame = 1;
}

void cp_timing_span(struct cp_timing *t, enum cpt_stat s, uint32_t ms)
{
	if (!t->available || !t->in_frame || (unsigned)s >= CPT_NSTAT)
		return;
	acc(&t->cur.a[s], ms);
	t->measured += ms;
}

void cp_timing_push(struct cp_timing *t, int config, int real, int ok,
		    uint32_t lock_ms, uint32_t send_ms)
{
	if (!t->available || !t->in_frame)
		return;
	struct cpt_win *w = &t->cur;
	cp_timing_span(t, CPT_PLK, lock_ms);
	if (!real) {
		if (config)
			w->c_gate++;
		else
			w->v_gate++;
		return;
	}
	cp_timing_span(t, config ? CPT_CSEND : CPT_VSEND, send_ms);
	if (config) {
		if (ok)
			w->c_ok++;
		else
			w->c_fail++;
		return;
	}
	if (ok)
		w->v_ok++;
	else
		w->v_fail++;
	w->slow16 += send_ms >= 16;
	w->slow33 += send_ms >= 33;
	w->slow100 += send_ms >= 100;
}

int cp_timing_end(struct cp_timing *t, uint32_t now)
{
	if (!t->available || !t->in_frame)
		return 0;
	uint32_t cb = now - t->entry;
	acc(&t->cur.a[CPT_CB], cb);
	acc(&t->cur.a[CPT_RES], cb > t->measured ? cb - t->measured : 0);
	t->last_entry = t->entry;
	t->last_exit = now;
	t->have_prev = 1;
	t->in_frame = 0;
	if (now - t->cur.t0 >= CPT_WINDOW_MS) {
		close_window(t, now);
		start_window(t, now, t->gen);
	}
	int d = t->dirty;
	t->dirty = 0;
	return d;
}

void cp_timing_published(struct cp_timing *t, uint32_t before, uint32_t after)
{
	if (!t->available)
		return;
	if (!t->open)
		start_window(t, before, t->gen);
	acc(&t->cur.a[CPT_PUB], after - before);
	t->last_exit = after; /* publication is not idle time */
}

const struct cpt_win *cp_timing_last(const struct cp_timing *t)
{
	if (!t->ring_n)
		return 0;
	return &t->ring[(t->ring_head + CPT_RING - 1) % CPT_RING];
}

/* ---- bounded serialization -------------------------------------------- */

struct jb { char *b; int cap, k, bad; };

static void ap(struct jb *j, const char *fmt, ...)
{
	if (j->bad)
		return;
	va_list v;
	va_start(v, fmt);
	int w = vsnprintf(j->b + j->k, (size_t)(j->cap - j->k), fmt, v);
	va_end(v);
	if (w < 0 || w >= j->cap - j->k)
		j->bad = 1;
	else
		j->k += w;
}

/* Average with one fixed-point decimal, integer math only (no NaN/inf). */
static void avg(const struct cpt_acc *a, unsigned long long *ip, unsigned *fp)
{
	if (!a->n) {
		*ip = 0, *fp = 0;
		return;
	}
	*ip = a->sum / a->n;
	*fp = (unsigned)((a->sum % a->n) * 10 / a->n);
}

static void stat_json(struct jb *j, const struct cpt_acc *a, const char *name)
{
	unsigned long long i;
	unsigned f;
	avg(a, &i, &f);
	ap(j, ",\"%s\":{\"n\":%u,\"avg\":%llu.%u,\"max\":%u,\"sum\":%llu}", name, (unsigned)a->n, i, f,
	   (unsigned)a->max, (unsigned long long)a->sum);
}

static void win_json(struct jb *j, const struct cpt_win *w)
{
	ap(j, "{\"seq\":%u,\"gen\":%u,\"t0\":%u,\"len_ms\":%u,\"calls\":%u,\"first\":%u,"
	   "\"v_ok\":%u,\"v_fail\":%u,\"v_gate\":%u,\"c_ok\":%u,\"c_fail\":%u,\"c_gate\":%u,"
	   "\"slow16\":%u,\"slow33\":%u,\"slow100\":%u",
	   (unsigned)w->seq, (unsigned)w->gen, (unsigned)w->t0, (unsigned)w->len_ms,
	   (unsigned)w->calls, (unsigned)w->first, (unsigned)w->v_ok, (unsigned)w->v_fail,
	   (unsigned)w->v_gate, (unsigned)w->c_ok, (unsigned)w->c_fail, (unsigned)w->c_gate,
	   (unsigned)w->slow16, (unsigned)w->slow33, (unsigned)w->slow100);
	for (int s = 0; s < CPT_NSTAT; s++)
		stat_json(j, &w->a[s], stat_names[s]);
	ap(j, "}");
}

int cp_timing_json(const struct cp_timing *t, char *buf, int cap, const char *head)
{
	if (!buf || cap <= 0)
		return -1;
	struct jb j = {buf, cap, 0, 0};
	ap(&j, "{\"v\":1,%s%s\"available\":%d,\"clock_res_ms\":1,\"window_ms\":%d,\"ring_max\":%d,"
	   "\"gen\":%u,\"seq\":%u,\"windows\":[",
	   head ? head : "", head && *head ? "," : "", t->available, CPT_WINDOW_MS, CPT_RING,
	   (unsigned)t->gen, (unsigned)t->seq);
	for (int i = 0; i < t->ring_n; i++) {
		if (i)
			ap(&j, ",");
		win_json(&j, &t->ring[(t->ring_head + CPT_RING - t->ring_n + i) % CPT_RING]);
	}
	ap(&j, "]}");
	if (j.bad) {
		buf[0] = 0;
		return -1;
	}
	return j.k;
}

int cp_timing_logline(const struct cp_timing *t, char *buf, int cap)
{
	const struct cpt_win *w = cp_timing_last(t);
	if (!w || !buf || cap <= 0)
		return -1;
	struct jb j = {buf, cap, 0, 0};
	ap(&j, "cpthru: timing seq=%u gen=%u len=%ums calls=%u v_ok=%u v_fail=%u v_gate=%u c_ok=%u "
	   "slow16/33/100=%u/%u/%u", (unsigned)w->seq, (unsigned)w->gen, (unsigned)w->len_ms,
	   (unsigned)w->calls, (unsigned)w->v_ok, (unsigned)w->v_fail, (unsigned)w->v_gate,
	   (unsigned)w->c_ok, (unsigned)w->slow16, (unsigned)w->slow33, (unsigned)w->slow100);
	static const enum cpt_stat shown[] = {CPT_CB, CPT_IV, CPT_GAP, CPT_LK, CPT_PLK, CPT_VSEND, CPT_RES, CPT_PUB};
	for (unsigned s = 0; s < sizeof shown / sizeof *shown; s++) {
		unsigned long long i;
		unsigned f;
		avg(&w->a[shown[s]], &i, &f);
		ap(&j, " %s=%llu.%u/%u", stat_names[shown[s]], i, f, (unsigned)w->a[shown[s]].max);
	}
	ap(&j, " (avg/max ms, 1 ms clock)");
	if (j.bad) {
		buf[0] = 0;
		return -1;
	}
	return j.k;
}
