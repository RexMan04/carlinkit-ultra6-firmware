// node test for the pure parts of web/cpthru_diag.js: timing display
// (fresh/stale/missing/unavailable), the debug-ZIP preflight, text bounds.
// Run from anywhere: node web/test_diag_view.js
const D = require("./cpthru_diag.js");
let fails = 0, n = 0;
function check(c, msg) { n++; if (!c) { fails++; console.log("FAIL " + msg); } }
const rows = (v) => Object.fromEntries(v.rows);
const stat = (avg, max, cnt) => ({n: cnt, avg, max, sum: Math.round(avg * cnt)});
const win = (o) => Object.assign({seq: 7, gen: 2, t0: 94000, len_ms: 5000, calls: 40, first: 0, v_ok: 40, v_fail: 0,
	v_gate: 0, c_ok: 0, c_fail: 0, c_gate: 0, slow16: 0, slow33: 0, slow100: 0,
	cb: stat(2.5, 9, 40), iv: stat(125, 140, 39), gap: stat(122.4, 138, 39), lk: stat(0, 1, 40), par: stat(0, 0, 40),
	plk: stat(0.2, 3, 40), vsend: stat(1.5, 7, 40), csend: stat(0, 0, 0), orig: stat(0, 0, 0), res: stat(1, 2, 40),
	pub: stat(0, 0, 0)}, o);
const info = (ret, stock, ovr) => ({calls: 1, last_mono_ms: 900, stock, returned: ret, override: ovr});
const timing = (o) => Object.assign({v: 1, build: "abc", up_ms: 100000, mono_ms: 99000, available: 1, clock_res_ms: 1,
	window_ms: 5000, ring_max: 24, gen: 2, seq: 7,
	info: {VIDEO_WIDTH: info(1920, 800, 1), VIDEO_HEIGHT: info(720, 480, 1), VIDEO_FPS: info(60, 30, 1)},
	windows: [win({seq: 6}), win({})]}, o);
const st = {up_ms: 100000, state: "PASSTHRU", in_fps: 8, pt_fps: 8, stock_fps: 0, kbps: 900, fallbacks: 0, push_err: 0, build: "abc"};

const view = d => D.timingView(Object.assign({link: {stream: 1}}, d));

// fresh window: measured rates and requested mode, clearly labelled
let v = view({now_ms: 101000, status: st, timing: timing({}), timing_error: null});
let r = rows(v);
check(!v.stale && v.available, "fresh timing");
check(r["Received from phone (measured)"] === "8.0 fps over 5.0 s", "received rate: " + r["Received from phone (measured)"]);
check(r["Pass-through sends (measured)"] === "8.0 fps", "forwarded rate: " + r["Pass-through sends (measured)"]);
const mode = r["Display mode requested (last value returned by sd_get_info_int)"];
check(/^1920x720 @ 60 fps \(shim override; stock 800x480 @ 30\)/.test(mode), "requested mode labelled: " + mode);
check(r["Hook time per frame"] === "2.5 ms avg, 9 ms max", "hook time row");
check(r["Idle between frames"] === "122.4 ms avg, 138 ms max", "gap row");
check(/1 ms resolution/.test(r["Clock"]), "clock resolution stated");

// stale: rates hidden, history kept
v = view({now_ms: 140000, status: st, timing: timing({}), timing_error: null});
r = rows(v);
check(v.stale && !r["Received from phone (measured)"] && /hidden/.test(r["Measured rates"]) && /2 windows/.test(r["Measured rates"]),
	"stale rates hidden: " + r["Measured rates"]);
check(/shim override/.test(r["Display mode requested (last value returned by sd_get_info_int)"]), "mode still shown when stale");

// missing, malformed, unavailable, not queried
v = view({now_ms: 1, status: null, timing: null, timing_error: "missing"});
check(/not published yet/.test(rows(v)["Timing"]), "missing timing");
v = view({now_ms: 1, status: null, timing: null, timing_error: "malformed"});
check(/malformed/.test(rows(v)["Timing"]), "malformed timing named");
v = view({now_ms: 1, timing: timing({available: 0, windows: []})});
check(/clock helper/.test(rows(v)["Timing"]), "unavailable clock");
v = view({now_ms: 100500, timing: timing({info: {VIDEO_WIDTH: {calls: 0, last_mono_ms: null, stock: null, returned: null, override: null},
	VIDEO_HEIGHT: {calls: 0}, VIDEO_FPS: {calls: 0}}})});
check(/not queried/.test(rows(v)["Display mode requested (last value returned by sd_get_info_int)"]), "mode not queried");
v = view({now_ms: 100500, timing: timing({windows: []})});
check(/no complete 5 s window/.test(rows(v)["Measured rates"]), "no window yet");
v = view({now_ms: 100500, timing: timing({info: {VIDEO_WIDTH: info(800, 800, 0), VIDEO_HEIGHT: info(480, 480, 0), VIDEO_FPS: info(30, 30, 0)}})});
check(/\(stock value\)/.test(rows(v)["Display mode requested (last value returned by sd_get_info_int)"]), "stock value labelled");
v = view({now_ms: 101000, timing: timing({windows: [win({len_ms: 0, calls: 0, v_ok: 0})]})});
check(rows(v)["Received from phone (measured)"].indexOf("?") === 0, "zero-length window never divides by zero");

// Window-end freshness, stream generation, wrap and stock-path distinction.
v = view({now_ms: 101000, timing: timing({windows: [win({t0: 1000})]})});
check(v.stale, "old window republished now is historical");
v = view({now_ms: 101000, timing: timing({gen: 3})});
check(v.stale, "previous stream generation is historical");
v = view({now_ms: 101000, timing: timing({}), link: {stream: 0}});
check(v.stale, "stopped stream hides rates");
v = view({now_ms: 2500, timing: timing({up_ms: 2000, mono_ms: 1000,
    windows: [win({t0: 4294963296, len_ms: 5000})]})});
check(!v.stale, "window end across uint32 wrap remains fresh");
v = view({now_ms: 101000, status: {...st, state: "TRANSCODE", stock_fps: 8},
    timing: timing({windows: [win({v_ok: 0})]})});
check(rows(v)["Pass-through sends (measured)"] === "0.0 fps" &&
    rows(v)["Stock sends (separate status sample)"] === "8.0 fps", "stock sends separately labelled");
v = view({now_ms: 101000, timing: {v: 1, available: 1, windows: [null]}});
check(v.stale && /invalid timing/.test(rows(v).Timing), "malformed optional timing hidden");
const malformedSummary = D.systemText({created: "x", complete: false, stock: {error: "test"}, warnings: [],
    status_before: {timing: {v: 1, available: 1, windows: [null]}}, status_after: null});
check(/invalid timing data omitted/.test(malformedSummary), "bad timing cannot break debug bundle text");

// preflight
const snap = (u, nosave) => ({nosave: nosave === undefined ? "" : nosave, udisk: Object.assign({free_bytes: 50e6,
	log_bytes: 3e6, leftover_zip: false, leftover_zip_bytes: null}, u)});
let p = D.preflight(snap({}));
check(p.ok && p.need_bytes === 3e6 + 4 * 1048576 && !p.warnings.length, "enough space");
p = D.preflight(snap({free_bytes: 3e6 + 4 * 1048576 - 1}));
check(!p.ok && /not enough free space/.test(p.reason), "low space stops before minizip");
p = D.preflight(snap({free_bytes: 3e6 + 4 * 1048576}));
check(p.ok, "exactly logs + 4 MiB is enough");
p = D.preflight(snap({free_bytes: null}));
check(!p.ok && /could not be read/.test(p.reason), "unreadable free space stops");
p = D.preflight(null);
check(!p.ok && /snapshot/.test(p.reason), "no snapshot stops");
p = D.preflight(snap({}, "1"));
check(p.ok && /Log saving is OFF/.test(p.warnings.join(" ")), "nosave=1 warning");
p = D.preflight(snap({}, null));
check(/could not be read/.test(p.warnings.join(" ")), "unreadable nosave warned");
p = D.preflight(snap({leftover_zip: true, leftover_zip_bytes: 2097152}));
check(/leftover .*2\.0 MiB.*does not delete/.test(p.warnings.join(" ")), "leftover ZIP reported, not deleted");
p = D.preflight(snap({log_bytes: 30e6, free_bytes: 100e6}));
check(p.ok && /probably exceed/.test(p.warnings.join(" ")), "likely oversize reported");

// text bounds and names
const big = D.cap("x".repeat(300 * 1024));
check(big.truncated && big.text.length <= 256 * 1024, "text capped at 256 KiB");
check(!D.cap("small").truncated, "small text untouched");
const d = new Date(2026, 10, 3, 9, 5, 7);
check(D.bundleName(true, d) === "carlinkit-debug-20261103-090507.zip", "complete name");
check(D.bundleName(false, d) === "carlinkit-diagnostics-only-20261103-090507.zip", "partial name");
const sys = D.systemText({created: "x", complete: false, stock: {error: "preflight"}, warnings: ["w1"],
	snapshot: {nosave: "1", build: "abc", config: {platform: "v553", custom: "yunlianAm", version: "202610121756C"},
		udisk: {free_bytes: 1, log_bytes: 2, leftover_zip: false},
		cpu: [{name: "cpu", total: 400, user: 100, nice: 0, system: 50, idle: 240, iowait: 10, irq: 0, softirq: 0},
			{name: "cpu0", total: 200, user: 50, nice: 0, system: 25, idle: 120, iowait: 5, irq: 0, softirq: 0},
			{name: "cpu1", total: 200, user: 50, nice: 0, system: 25, idle: 120, iowait: 5, irq: 0, softirq: 0}],
		net: [], sdDongle: {pid: 5, same_process: true, threads_seen: 2, threads: [{tid: 6, name: "enc", utime: 30, stime: 10}]}},
	status_before: {now_ms: 1, timing: timing({})}, status_after: null});
check(/DIAGNOSTICS ONLY/.test(sys) && /NOT SAVED/.test(sys) && /WARNING: w1/.test(sys), "system text flags");
check(/6 enc: 40 ticks \(20% of one core\)/.test(sys), "thread share of one core: " + (sys.match(/6 enc.*/) || [""])[0]);
check(/status_after: unavailable/.test(sys) && /#7 stream 2/.test(sys), "missing optional data + timing history");
check(/UNREDACTED/.test(D.readme(true)) && /DIAGNOSTICS ONLY/.test(D.readme(false)), "readme");
check(D.NEUTRALIZED.join() === "GetZipFile,UploadZipFile,queryDeviceVersion,cahudsoejhu", "neutralized set");
check(D.ORDER.join() === "stock-logs.zip,status.json,system.txt,manifest.json,README.txt", "bundle order");

console.log((n - fails) + "/" + n + " diagnostics view checks passed");
process.exit(fails ? 1 : 0);
