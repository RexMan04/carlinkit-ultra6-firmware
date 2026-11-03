/* CarPlay pass-through page (WEBUI_PLAN.md). view() is pure: status JSON in,
 * display model out, so node can test it (test_page.js). The rest is DOM. */
var STALE_MS = 7000;
var LATENCIES = [0, 300, 400, 500, 600, 700, 800, 900, 1000];

function ago(ms) {
	var s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return s + " s ago";
	if (s < 5400) return Math.round(s / 60) + " min ago";
	return Math.round(s / 3600) + " h ago";
}

function modeOf(st, now) {
	var age = now - st.up_ms;
	if (age > STALE_MS) return ["Stale: no frames for " + Math.round(age / 1000) + " s", "warn"];
	switch (st.state) {
	case "PASSTHRU": return ["Pass-through", "good"];
	case "SYNC_CONFIG": case "WAIT_IDR": case "RESYNC": return ["Syncing with the car", "busy"];
	case "TRANSPORT_LOST": return ["Car link lost, waiting for it to restart", "warn"];
	case "FALLBACK": return ["Switching to stock", "busy"];
	case "TRANSCODE":
		if (st.off) return ["Stock (pass-through switched off)", "plain"];
		if (st.marker) return ["Stock (pass-through auto-disabled after failures)", "warn"];
		if (st.last_fallback) return ["Stock (fell back)", "warn"];
		return ["Stock", "plain"];
	default: return ["Waiting for the phone and car", "busy"];
	}
}

function view(d) {
	var st = d.status, ln = d.link, now = d.now_ms, rows = [], mode;
	if (!st && !ln) {
		mode = ["No CarPlay session since boot", "plain"];
	} else if (ln && !ln.stream) {
		mode = ["No CarPlay video right now", "plain"];
	} else if (!st) {
		mode = ["Starting", "busy"];
	} else {
		mode = modeOf(st, now);
	}
	var live = st && ln && ln.stream && now - st.up_ms <= STALE_MS;
	if (live) {
		var pt = st.state === "PASSTHRU";
		rows.push(["Video to car", (pt ? st.pt_fps : st.stock_fps).toFixed(1) + " fps (" +
			(pt ? "pass-through" : "transcoded") + ")"]);
		rows.push(["From the phone", st.in_fps.toFixed(1) + " fps, " + Math.round(st.kbps) + " kbps"]);
	}
	if (st) {
		rows.push(["Car screen", st.car.indexOf("0x0") === 0 ? "unknown" : st.car]);
		rows.push(["Phone stream", st.phone.indexOf("0x0") === 0 ? "unknown" : st.phone]);
		rows.push(["Last fallback", st.last_fallback ?
			st.last_fallback + " (" + ago(now - (st.up_ms - (st.t_ms - st.last_fallback_t_ms))) + ")" : "none"]);
		rows.push(["Fallbacks this boot", String(st.fallbacks)]);
		rows.push(["Status updated", ago(now - st.up_ms)]);
		rows.push(["Build", st.build]);
	}
	if (ln) rows.push(["Last connection event", ln.event + " (" + ago(now - ln.up_ms) + ")"]);
	/* REV-03: shown whatever the connection state, stream or switch */
	var markers = d.markers || [], build = d.build || (st && st.build) || "";
	var disabled = build && markers.indexOf(build) >= 0;
	rows.unshift(["Auto-disabled after failures", disabled ?
		"Yes: pass-through stays off until a new build is flashed" :
		markers.length ? "No (markers from older builds are ignored)" : "No"]);
	if (!st && build) rows.push(["Build", build]);
	/* REV-04: unset means the phone decides (the firmware's default) */
	var lat = parseInt(d.settings.latency, 10);
	return {
		mode: mode[0], tone: mode[1], rows: rows, autoDisabled: !!disabled,
		on: d.settings.off !== "1",
		latency: isNaN(lat) ? 0 : lat
	};
}

if (typeof module !== "undefined") module.exports = {view: view, LATENCIES: LATENCIES};

/* ---- DOM ---- */
if (typeof document !== "undefined") (function () {
	var armed = null, last = null;
	function $(id) { return document.getElementById(id); }
	function text(el, t) { el.textContent = t; }
	function label(v) { return v === 0 ? "Phone decides (default)" : v + " ms"; }

	function render(m) {
		var badge = $("mode");
		text(badge, m.mode);
		badge.className = "badge " + m.tone;
		var tb = $("rows");
		tb.textContent = "";
		m.rows.forEach(function (r) {
			var tr = document.createElement("tr"), a = document.createElement("th"), b = document.createElement("td");
			text(a, r[0]); text(b, r[1]);
			tr.appendChild(a); tr.appendChild(b); tb.appendChild(tr);
		});
		["on", "off"].forEach(function (k) {
			var el = $("pt-" + k), sel = (k === "on") === m.on;
			el.className = "chip" + (sel ? " sel" : "") + (armed === "pt-" + k ? " armed" : "");
		});
		var box = $("lat");
		if (!box.children.length) {
			LATENCIES.forEach(function (v) {
				var b = document.createElement("button");
				b.id = "lat-" + v;
				b.onclick = function () { tap("lat-" + v, "persist.suding.wl.audio.latency", v); };
				box.appendChild(b);
			});
		}
		LATENCIES.forEach(function (v) {
			var b = $("lat-" + v);
			text(b, armed === "lat-" + v ? "Tap again" : label(v));
			b.className = "chip" + (v === m.latency ? " sel" : "") + (armed === "lat-" + v ? " armed" : "");
		});
		text($("pt-on"), armed === "pt-on" ? "Tap again" : "On");
		text($("pt-off"), armed === "pt-off" ? "Tap again" : "Off (stock)");
	}

	function refresh() {
		fetch("cgi-bin/cpthru_status.cgi", {cache: "no-store"}).then(function (r) { return r.json(); })
			.then(function (d) { last = view(d); render(last); text($("err"), ""); })
			.catch(function () { text($("err"), "Can't reach the adapter."); });
	}

	/* Two taps to change anything (no confirm() popups). */
	function tap(id, key, value) {
		if (armed !== id) {
			armed = id;
			if (last) render(last);
			setTimeout(function () { if (armed === id) { armed = null; if (last) render(last); } }, 4000);
			return;
		}
		armed = null;
		fetch("cgi-bin/cpthru_set.cgi?key=" + encodeURIComponent(key) + "&value=" + value, {cache: "no-store"})
			.then(function (r) { return r.json(); })
			.then(function (d) {
				text($("msg"), d.ok ? "Saved. Takes effect the next time CarPlay connects." : "Not saved: " + d.error);
				refresh();
			})
			.catch(function () { text($("msg"), "Not saved: can't reach the adapter."); });
	}

	$("pt-on").onclick = function () { tap("pt-on", "persist.cpthru.off", 0); };
	$("pt-off").onclick = function () { tap("pt-off", "persist.cpthru.off", 1); };
	function set(key, value) {
		return fetch("cgi-bin/cpthru_set.cgi?key=" + key + "&value=" + value, {cache: "no-store"})
			.then(function (r) { return r.json(); })
			.then(function (d) { return d.ok && d.value === String(value); })
			.catch(function () { return false; });
	}
	/* REV-02: report exactly what was saved */
	$("reset").onclick = function () {
		if (armed !== "reset") { armed = "reset"; text($("reset"), "Tap again to reset both"); return; }
		armed = null;
		text($("reset"), "Reset both to defaults");
		Promise.all([set("persist.cpthru.off", 0), set("persist.suding.wl.audio.latency", 0)])
			.then(function (ok) {
				text($("msg"), ok[0] && ok[1] ? "Reset: pass-through on, audio delay back to phone decides." :
					"Reset incomplete: pass-through " + (ok[0] ? "reset" : "NOT reset") +
					", audio delay " + (ok[1] ? "reset" : "NOT reset") + ".");
				refresh();
			});
	};
	refresh();
	setInterval(refresh, 2000);
	window.addEventListener("pv-refresh", refresh); /* preview page only */
})();
