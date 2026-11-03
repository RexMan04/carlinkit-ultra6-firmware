/* CarPlay pass-through core: H.264 parsing and the per-stream state machine
 * from PASSTHROUGH_PLAN.md. Platform-free so it builds for the host tests and
 * for the device. Only the frame thread calls cp_frame(); other threads only
 * change the cp_in fields through the glue layer (cpthru_hooks.c).
 */
#ifndef CPTHRU_CORE_H
#define CPTHRU_CORE_H
#include <stdint.h>

enum cp_state {
	CP_IDLE, CP_SYNC_CONFIG, CP_WAIT_IDR, CP_PASSTHRU, CP_RESYNC,
	CP_TRANSPORT_LOST, CP_FALLBACK, CP_TRANSCODE
};

/* Results of cp_ops.push. The glue checks the handle's readiness itself
 * before calling the firmware sender, so the first two mean nothing was
 * written. The firmware sender returns -1 for both "not streaming" and a
 * failed write, so every failure of the real call is reported as CP_PUSH_IO
 * (possibly partial write: the connection can't be trusted) (C01). */
#define CP_PUSH_NOT_STREAMING (-1)
#define CP_PUSH_BAD_FD (-2)
#define CP_PUSH_IO (-100)

struct cp_ops {
	/* carplay_reverse_video_push_frame on the given car handle. */
	int (*push)(void *ctx, void *car, uint8_t *buf, int len, int flag);
	/* AirPlayReceiverSessionForceKeyFrame on the current phone session. */
	void (*request_idr)(void *ctx);
	/* the stock ScreenRecord::setCarlinkH264Data */
	void (*orig_setdata)(void *ctx, void *sr, char *buf, int len);
	/* real wrap_system_property_set("sys.suding.force.key.frame", "1") */
	void (*encoder_keyframe)(void *ctx);
	/* Publish ownership of the car stream to the output gate. Taking it
	 * fails (returns 0) if a teardown hook ran since this frame began. */
	int (*set_owned)(void *ctx, int owned);
	int (*marker_exists)(void *ctx);
	void (*marker_write)(void *ctx);
	void (*log)(void *ctx, const char *line);
	/* One JSON object (without the glue's build/up_ms fields) describing
	 * the current state, on every state change and stats tick. */
	void (*status)(void *ctx, const char *json);
	void *ctx;
};

/* Inputs written by the glue layer between frames. */
struct cp_in {
	uint32_t now_ms;
	void *session;          /* live phone receiver session, or 0 */
	unsigned stream_gen;    /* bumps on every ScreenStreamStart/Stop */
	int stream_live;
	unsigned cfg_gen;       /* bumps on every ScreenStreamSetAVCC */
	const uint8_t *avcc;    /* latest avcC (valid for the current cfg_gen) */
	int avcc_len;
	void *car;              /* live car handle, or 0 */
	unsigned car_gen;       /* bumps on every car handle start */
	int car_w, car_h, car_fps;  /* carplay_reverse_get_video_parameters */
	int killed;             /* web page switch (persist.cpthru.off=1) */
	int kf_new;             /* car keyframe requests since the last frame */
	unsigned stock_sent;    /* stock encoder frames let through (counter) */
};

struct cp_stats {
	unsigned in, pushed, dropped, multi_vcl, push_err, kf_car, kf_phone;
	unsigned bytes, nal_hist[32], stock;
};

struct cp {
	struct cp_ops o;
	struct cp_in in;
	enum cp_state st;
	unsigned seen_stream_gen, seen_cfg_gen, seen_car_gen;
	/* config of the current generation */
	uint8_t *hdr_all; int hdr_all_len;   /* every SPS/PPS, Annex-B */
	uint8_t *hdr_pt; int hdr_pt_len;     /* SC SPS SC PPS, if shape is ok */
	int cfg_w, cfg_h, cfg_ok_shape, cfg_profile, cfg_level;
	unsigned delivered_car_gen, delivered_cfg_gen;
	enum cp_state after_sync;            /* CP_WAIT_IDR or CP_RESYNC */
	uint32_t sync_t0, sync_try;          /* SYNC_CONFIG retry timing */
	uint32_t idr_t0, idr_rereq_done;     /* WAIT_IDR / RESYNC deadline */
	uint32_t last_idr_req;
	uint32_t tl_t0; int tl_counted;
	uint32_t kf_ring[8]; int kf_n;       /* car keyframe times, rolling 10 s */
	int fallbacks, failed;
	unsigned tl_car_gen;                 /* car handle the transport was lost on */
	uint32_t idle_t0;                    /* candidate frames waiting in IDLE */
	unsigned fb_cfg_gen;                 /* config generation fed to the transcoder */
	int stream_candidate;                /* decided at stream start: switch off, no marker (REV-01) */
	uint32_t fb_t0, fb_rereq; int fb_fed, fb_done;
	void *sr;                            /* last ScreenRecord seen */
	uint8_t *buf; int bufcap;            /* push copy (push_frame encrypts in place) */
	int owned;                           /* core's view; the gate is set via ops.set_owned */
	struct cp_stats s, s_prev;
	uint32_t stats_t0;
	const char *reason;                  /* last state change */
	const char *last_fb; uint32_t last_fb_t;
	float in_fps, pt_fps, stock_fps, kbps;
};

void cp_init(struct cp *c, const struct cp_ops *ops);
/* One frame from sdDongle (Annex-B access unit). */
void cp_frame(struct cp *c, void *sr, char *buf, int len);
/* Apply cp_in changes without a frame (state only; never calls orig). */
void cp_poll(struct cp *c);
const char *cp_state_name(enum cp_state s);

/* Parsing helpers, exposed for tests. cp_nal_split fills at most max
 * entries but returns the total NAL count. */
int cp_nal_split(const uint8_t *b, int n, int *off, int *len, int max);
int cp_sps_size(const uint8_t *sps, int n, int *w, int *h, int *profile, int *level);
/* avcC -> Annex-B; returns 0 ok. *pt is set (malloc) only for 1 SPS + 1 PPS
 * with 4-byte lengths. */
int cp_avcc_to_annexb(const uint8_t *a, int n, uint8_t **all, int *all_len,
		      uint8_t **pt, int *pt_len, const uint8_t **sps, int *sps_len);
#endif
