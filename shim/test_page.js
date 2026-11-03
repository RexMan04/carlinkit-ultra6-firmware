// node test for web/cpthru.js view() (WEBUI_PLAN.md: page logic tests).
const {view} = require("../web/cpthru.js");
let fails = 0, n = 0;
function check(c, msg) { n++; if (!c) { fails++; console.log("FAIL " + msg); } }
const base = {t_ms: 50000, state: "PASSTHRU", reason: "IDR delivered", off: 0, marker: 0, in_fps: 59.8,
	pt_fps: 59.6, stock_fps: 0, kbps: 8000, car: "1920x720@60", phone: "1920x720 p100/l42", fallbacks: 0,
	failed: 0, last_fallback: "", last_fallback_t_ms: 0, multi_vcl: 0, push_err: 0, kf_car: 0, kf_phone: 1,
	build: "abc", up_ms: 100000};
const S = (o) => Object.assign({}, base, o);
const set = {off: "0", latency: "400"};
const live = {up_ms: 90000, stream: 1, session: 1, car: 1, event: "car video start"};
const rows = (m) => Object.fromEntries(m.rows);

let m = view({now_ms: 1000, status: null, link: null, settings: {off: "", latency: ""}});
check(m.mode === "No CarPlay session since boot" && m.on && m.latency === 0, "no session, unset latency = phone decides (REV-04)");
check(rows(m)["Auto-disabled after failures"] === "No", "marker row always shown (REV-03)");
m = view({now_ms: 1000, build: "abc", markers: ["abc"], status: null, link: {up_ms: 900, stream: 0, session: 0, car: 0, event: "x"}, settings: {off: "1", latency: ""}});
check(m.autoDisabled && rows(m)["Auto-disabled after failures"].startsWith("Yes"), "marker shown with stream stopped and switch off (REV-03)");
m = view({now_ms: 1000, build: "new", markers: ["old"], status: null, link: null, settings: {off: "", latency: ""}});
check(!m.autoDisabled && rows(m)["Auto-disabled after failures"].indexOf("older") > 0, "old-build marker ignored");

m = view({now_ms: 101000, status: S({}), link: live, settings: set});
check(m.mode === "Pass-through" && m.tone === "good", "live pass-through");
check(rows(m)["Video to car"] === "59.6 fps (pass-through)", "pass-through fps row: " + rows(m)["Video to car"]);

m = view({now_ms: 110000, status: S({}), link: live, settings: set});
check(m.mode.startsWith("Stale") && !rows(m)["Video to car"], "stale after 7 s, fps hidden");

m = view({now_ms: 101000, status: S({}), link: Object.assign({}, live, {stream: 0, event: "screen stream stop"}), settings: set});
check(m.mode === "No CarPlay video right now" && !rows(m)["Video to car"] && rows(m)["Car screen"] === "1920x720@60",
	"stream stopped after PASSTHRU: disconnected, history kept (WEB-01)");

m = view({now_ms: 101000, status: S({state: "TRANSCODE", reason: "picture recovered", pt_fps: 0, stock_fps: 29.9,
	last_fallback: "car keyframe storm", last_fallback_t_ms: 20000, fallbacks: 1}), link: live, settings: set});
check(m.mode === "Stock (fell back)" && rows(m)["Video to car"] === "29.9 fps (transcoded)", "transcode after fallback (WEB-02)");
check(rows(m)["Last fallback"].startsWith("car keyframe storm (31 s ago"), "fallback cause and age (WEB-03): " + rows(m)["Last fallback"]);

m = view({now_ms: 101000, status: S({state: "TRANSCODE", off: 1, pt_fps: 0, stock_fps: 30}), link: live, settings: {off: "1", latency: "300"}});
check(m.mode === "Stock (pass-through switched off)" && !m.on && m.latency === 300, "switch off, 300 ms");

m = view({now_ms: 101000, status: S({state: "TRANSCODE", marker: 1, last_fallback: "x", last_fallback_t_ms: 1}), link: live, settings: set});
check(m.mode.indexOf("auto-disabled") > 0, "fail marker shown");

console.log((n - fails) + "/" + n + " page checks passed");
process.exit(fails ? 1 : 0);
