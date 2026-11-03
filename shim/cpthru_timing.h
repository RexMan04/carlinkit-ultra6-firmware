/* Frame-hook timing for the diagnostic build (NEXT_TEST_PLAN.md A).
 * Platform-free and constant-space: the glue passes millisecond timestamps
 * from the firmware's get_current_mono_time_ms; nothing here reads a clock,
 * allocates, or does I/O. Only the frame thread touches a struct cp_timing.
 *
 * Accounting, per callback (setCarlinkH264Data hook):
 *   cb   entry -> exit, excluding the timing file publication
 *   iv   previous entry -> this entry (none for the first frame of a stream
 *        generation: no fabricated interval)
 *   gap  previous exit (after any publication) -> this entry
 *   pub  publication cost, reported on its own so it never shows up as idle
 *   res  cb minus the measured parts (lk, par, plk, vsend, csend, orig);
 *        wall time we did not split further, NOT a CPU measurement
 * so sum(iv) ~= sum(cb) + sum(pub) + sum(gap). The clock has 1 ms resolution;
 * a 0 means "under 1 ms", nothing finer is claimed. Differences use uint32
 * modular arithmetic, so a wrapping clock is fine; totals are uint64.
 */
#ifndef CPTHRU_TIMING_H
#define CPTHRU_TIMING_H
#include <stdint.h>

#define CPT_RING 24          /* closed windows kept (about 2 minutes) */
#define CPT_WINDOW_MS 5000
#define CPT_JSON_MAX (96 * 1024)

enum cpt_stat {
	CPT_CB, CPT_IV, CPT_GAP, CPT_LK, CPT_PAR, CPT_PLK, CPT_VSEND, CPT_CSEND,
	CPT_ORIG, CPT_RES, CPT_PUB, CPT_NSTAT
};

struct cpt_acc { uint32_t n, max; uint64_t sum; };

struct cpt_win {
	uint32_t seq, gen, t0, len_ms;
	uint32_t calls, first;                 /* frames; frames without an interval */
	uint32_t v_ok, v_fail, v_gate;         /* video: sent, sender failed, not called */
	uint32_t c_ok, c_fail, c_gate;         /* config (SPS/PPS) pushes, same split */
	uint32_t slow16, slow33, slow100;      /* real video sends taking >= N ms */
	struct cpt_acc a[CPT_NSTAT];
};

struct cp_timing {
	int available;          /* 0: no firmware clock, everything is a no-op */
	int open, in_frame, have_prev, dirty;
	uint32_t gen, seq;
	uint32_t entry, last_entry, last_exit, measured;
	struct cpt_win cur;
	struct cpt_win ring[CPT_RING];
	int ring_head, ring_n;
};

void cp_timing_init(struct cp_timing *t, int available);
/* Callback entry, before the first lock. gen = stream generation. */
void cp_timing_begin(struct cp_timing *t, uint32_t now, uint32_t gen);
/* A measured part of this callback (CPT_LK, CPT_PAR or CPT_ORIG). */
void cp_timing_span(struct cp_timing *t, enum cpt_stat s, uint32_t ms);
/* One cp_ops.push: config or video; real = the firmware sender was called
 * (ok = it returned success); lock_ms = out_lk wait; send_ms = sender time. */
void cp_timing_push(struct cp_timing *t, int config, int real, int ok,
		    uint32_t lock_ms, uint32_t send_ms);
/* Callback exit. Returns 1 when a window closed: publish now, then call
 * cp_timing_published with the times around the publication. */
int cp_timing_end(struct cp_timing *t, uint32_t now);
void cp_timing_published(struct cp_timing *t, uint32_t before, uint32_t after);
/* {"v":1,<head>,...,"windows":[oldest..newest]} into buf. head is a JSON
 * member list without braces (may be empty). Returns the length, or -1 if
 * it did not fit (buf then holds no usable JSON). */
int cp_timing_json(const struct cp_timing *t, char *buf, int cap, const char *head);
/* One compact log line for the newest closed window; -1 if none/no room. */
int cp_timing_logline(const struct cp_timing *t, char *buf, int cap);
/* Newest closed window or 0. */
const struct cpt_win *cp_timing_last(const struct cp_timing *t);
#endif
