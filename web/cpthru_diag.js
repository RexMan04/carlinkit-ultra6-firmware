/* Diagnostics panel and debug-ZIP collector for the passthru_diag TEST build
 * (NEXT_TEST_PLAN.md B). Loaded on the stock main page (/index.html, after
 * every stock script, so before window.onload runs) and on /cpthru.html.
 *
 * On the stock page it first neutralizes the stock automatic log export
 * (GetZipFile/UploadZipFile), the vendor version query (queryDeviceVersion)
 * and the periodic telemetry (cahudsoejhu). Everything else on the stock page
 * keeps working; while a debug ZIP is being prepared, settings, firmware and
 * reboot actions are refused.
 *
 * The vendor log exporter (/cgi-bin/minizip.cgi) only runs after the owner
 * taps Prepare, never on page load. Its ZIP is kept as opaque bytes (never
 * inflated, recompressed or decoded as text) and wrapped with status, system
 * and manifest files in a STORE-only phone-side ZIP. Nothing is uploaded.
 *
 * Pure helpers are exported for node (web/test_diag_view.js); the DOM part
 * runs only in a browser. */
(function (root) {
	"use strict";
	var L = {
		zip: 25 * 1024 * 1024, margin: 4 * 1024 * 1024, text: 256 * 1024, json: 1024 * 1024,
		status_ms: 6000, snapshot_ms: 15000, zip_ms: 90000, stale_ms: 12000, poll_ms: 4000
	};
	var URLS = {
		status: "/cgi-bin/cpthru_status.cgi", snapshot: "/cgi-bin/cpthru_snapshot.cgi",
		minizip: "/cgi-bin/minizip.cgi?logID=local&"
	};
	var NEUTRALIZED = ["GetZipFile", "UploadZipFile", "queryDeviceVersion", "cahudsoejhu"];
	/* Stock settings / firmware / reboot / vendor actions: refused while preparing. */
	var GUARDED = ["funQuality", "funAudioDelay", "funmediaDelay", "funmediawifi", "FactoryReset",
		"toggleButton", "toggleButon", "toggleBtton", "toggleBluetoothPhone", "sendBluetoothPhoneRequest",
		"closeBluetoothPhone", "autodisplayselect", "sendRequest", "switchP2P", "btnaddEv",
		"downloadAliFile", "uploadChunks", "program", "LogCommit", "nloatn"];
	var ORDER = ["stock-logs.zip", "status.json", "system.txt", "manifest.json", "README.txt"];

	/* ---- pure helpers ---------------------------------------------------- */

	function isNum(x) { return typeof x === "number" && isFinite(x); }
	function mib(b) { return isNum(b) ? (b / 1048576).toFixed(1) + " MiB" : "unknown"; }
	function secs(ms) {
		var s = Math.max(0, Math.round(ms / 1000));
		return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h";
	}
	function fps(count, len) { return isNum(count) && isNum(len) && len > 0 ? count * 1000 / len : null; }
	function f1(x) { return isNum(x) ? x.toFixed(1) : "?"; }
	function val(x) { return isNum(x) ? String(x) : "?"; }
	function stat(s) {
		return s && isNum(s.n) && s.n > 0 && isNum(s.avg) && isNum(s.max) ?
			s.avg.toFixed(1) + " ms avg, " + s.max + " ms max" : "none measured";
	}
	function mx(s) { return s && isNum(s.max) && s.n > 0 ? String(s.max) : "0"; }
	function uint(x) { return isNum(x) && x >= 0 && x <= 4294967295 && Math.floor(x) === x; }
	function elapsed(now, then) { return ((now - then) % 4294967296 + 4294967296) % 4294967296; }
	function validWindow(w) {
		return w && typeof w === "object" &&
			["seq", "gen", "t0", "len_ms", "calls", "v_ok", "v_fail", "v_gate", "slow33", "slow100"].every(function (k) { return uint(w[k]); }) &&
			["cb", "iv", "gap", "lk", "par", "plk", "vsend", "csend", "orig", "res", "pub"].every(function (k) {
				var s = w[k]; return s && uint(s.n) && uint(s.max) && isNum(s.avg) && s.avg >= 0 && s.avg <= 4294967295;
			});
	}
	function timingIssue(t) {
		return t && (typeof t !== "object" || t.v !== 1 || !Array.isArray(t.windows) || t.windows.length > 24 ||
			!t.windows.every(validWindow)) ? "invalid timing data omitted" : null;
	}
	function windows(t) { return t && !timingIssue(t) && Array.isArray(t.windows) ? t.windows : []; }
	function lastWin(t) { var w = windows(t); return w.length ? w[w.length - 1] : null; }

	/* Last values the shim returned from sd_get_info_int: what the adapter
	 * asked for, not proof of what the phone was told. */
	function displayMode(t, age) {
		var i = t && t.info, w = i && i.VIDEO_WIDTH, h = i && i.VIDEO_HEIGHT, f = i && i.VIDEO_FPS;
		if (!w || !h || !f) return "unknown";
		if (!w.calls || !h.calls || !f.calls || !isNum(w.returned) || !isNum(h.returned) || !isNum(f.returned))
			return "not queried since the adapter started";
		var s = w.returned + "x" + h.returned + " @ " + f.returned + " fps";
		s += w.override || h.override || f.override ?
			" (shim override; stock " + val(w.stock) + "x" + val(h.stock) + " @ " + val(f.stock) + ")" : " (stock value)";
		if (isNum(f.last_mono_ms) && isNum(t.mono_ms))
				s += ", " + secs(elapsed(t.mono_ms, f.last_mono_ms) + (isNum(age) ? age : 0)) + " ago";
		return s;
	}

	/* Status CGI JSON -> display rows. Rates only from a fresh window. */
	function timingView(d) {
		var rows = [], t = d && d.timing, v = {rows: rows, available: false, stale: true, latest: null};
		if (d && d.status && typeof d.status.state === "string")
			rows.push(["Adapter mode (core status)", d.status.state]);
		if (!t || typeof t !== "object") {
			rows.push(["Timing", d && d.timing_error && d.timing_error !== "missing" ?
				"unavailable (timing file " + d.timing_error + ")" :
				"not published yet (no CarPlay video since the adapter started)"]);
			return v;
		}
		if (t.available !== 1) {
			rows.push(["Timing", "unavailable: the firmware clock helper was not found"]);
			return v;
		}
		if (timingIssue(t)) { rows.push(["Timing", timingIssue(t)]); return v; }
		v.available = true;
		var age = isNum(d.now_ms) && uint(t.up_ms) ? elapsed(d.now_ms, t.up_ms) : null;
		rows.push(["Display mode requested (last value returned by sd_get_info_int)", displayMode(t, age)]);
		var w = lastWin(t);
		if (!w) {
			rows.push(["Measured rates", "no complete 5 s window yet"]);
			return v;
		}
		v.latest = w;
		var windowAge = age !== null && uint(t.mono_ms) ? age + elapsed(t.mono_ms, (w.t0 + w.len_ms) >>> 0) : null;
		if (!d.link || !d.link.stream || w.gen !== t.gen || windowAge === null || windowAge > L.stale_ms) {
			rows.push(["Measured rates", "hidden: the last window ended " +
				(windowAge === null ? "at an unknown time" : secs(windowAge) + " ago") +
				" (historical or disconnected). The last " +
				windows(t).length + " windows are kept for the debug ZIP."]);
			return v;
		}
		v.stale = false;
		rows.push(["Received from phone (measured)", f1(fps(w.calls, w.len_ms)) + " fps over " +
			f1(w.len_ms / 1000) + " s"]);
		rows.push(["Pass-through sends (measured)", f1(fps(w.v_ok, w.len_ms)) + " fps" +
			(w.v_fail || w.v_gate ? " (" + w.v_fail + " failed, " + w.v_gate + " not sent)" : "")]);
		if (d.status && uint(d.status.up_ms) && elapsed(d.now_ms, d.status.up_ms) <= L.stale_ms)
			rows.push(["Stock sends (separate status sample)", f1(d.status.stock_fps) + " fps"]);
		rows.push(["Hook time per frame", stat(w.cb)]);
		rows.push(["Car send time (video)", stat(w.vsend) + "; >=33 ms: " + w.slow33 + ", >=100 ms: " + w.slow100]);
		rows.push(["Idle between frames", stat(w.gap)]);
		rows.push(["Lock waits (max)", "frame start " + mx(w.lk) + " ms, car send " + mx(w.plk) + " ms"]);
		rows.push(["Unsplit hook time", stat(w.res)]);
		rows.push(["Clock", "1 ms resolution; window " + w.seq + ", stream " + w.gen]);
		return v;
	}

	/* Snapshot -> may the stock exporter run? Needs free >= logs + 4 MiB. */
	function preflight(s) {
		var out = {ok: false, reason: "", warnings: [], free_bytes: null, log_bytes: null, need_bytes: null};
		if (!s || typeof s !== "object") {
			out.reason = "the system snapshot could not be read, so free space is unknown";
			return out;
		}
		var u = s.udisk || {};
		if (s.nosave === "1")
			out.warnings.push("Log saving is OFF on this adapter (persist.console.log.nosave=1): the stock " +
				"log ZIP will not contain sdDongle or kernel logs from this boot.");
		else if (s.nosave !== "" && s.nosave !== "0")
			out.warnings.push("The log-saving setting (persist.console.log.nosave) could not be read.");
		if (u.leftover_zip === true)
			out.warnings.push("A leftover /mnt/UDISK/local.zip (" + mib(u.leftover_zip_bytes) + ") from an " +
				"earlier export exists. This page does not delete it.");
		if (isNum(u.log_bytes) && u.log_bytes > L.zip)
			out.warnings.push("The log directory is " + mib(u.log_bytes) + "; the stock ZIP will probably " +
				"exceed the " + mib(L.zip) + " download limit.");
		if (!isNum(u.free_bytes) || !isNum(u.log_bytes)) {
			out.reason = "free space or log directory size could not be read";
			return out;
		}
		out.free_bytes = u.free_bytes;
		out.log_bytes = u.log_bytes;
		out.need_bytes = u.log_bytes + L.margin;
		if (u.free_bytes < out.need_bytes) {
			out.reason = "not enough free space on /mnt/UDISK: need " + mib(out.need_bytes) +
				" (logs + 4 MiB), have " + mib(u.free_bytes);
			return out;
		}
		out.ok = true;
		return out;
	}

	function cap(text, limit) {
		limit = limit || L.text;
		text = String(text);
		return text.length <= limit ? {text: text, truncated: false} :
			{text: text.slice(0, limit - 64) + "\n[truncated by the phone at " + limit + " characters]\n", truncated: true};
	}

	function pad(n) { return (n < 10 ? "0" : "") + n; }
	function stamp(d) {
		return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) +
			pad(d.getMinutes()) + pad(d.getSeconds());
	}
	function bundleName(complete, d) {
		return (complete ? "carlinkit-debug-" : "carlinkit-diagnostics-only-") + stamp(d) + ".zip";
	}

	function cpuLines(s) {
		var out = [], cpu = s && Array.isArray(s.cpu) ? s.cpu : [];
		var cores = cpu.filter(function (c) { return /^cpu\d+$/.test(c.name); }).length || 1;
		var all = cpu.filter(function (c) { return c.name === "cpu"; })[0];
		cpu.forEach(function (c) {
			var busy = c.total - c.idle - c.iowait;
			out.push("  " + c.name + ": " + (c.total > 0 ? (busy * 100 / c.total).toFixed(0) + "% busy" : "no ticks") +
				" (user " + c.user + ", system " + c.system + ", irq " + (c.irq + c.softirq) + ", iowait " + c.iowait +
				" of " + c.total + " ticks)");
		});
		var sd = s && s.sdDongle;
		if (!sd) {
			out.push("  sdDongle: not found");
		} else {
			out.push("  sdDongle pid " + sd.pid + ", same process in both samples: " + (sd.same_process ? "yes" : "NO (restarted?)") +
				", threads seen " + sd.threads_seen);
			var per = all && all.total > 0 ? all.total / cores : 0;
			(Array.isArray(sd.threads) ? sd.threads.slice() : [])
				.sort(function (a, b) { return (b.utime + b.stime) - (a.utime + a.stime); })
				.forEach(function (t) {
					var ticks = t.utime + t.stime;
					out.push("    " + t.tid + " " + t.name + ": " + ticks + " ticks" +
						(per ? " (" + (ticks * 100 / per).toFixed(0) + "% of one core)" : ""));
				});
		}
		return out;
	}

	function timingTable(t) {
		var out = [];
		if (timingIssue(t)) return ["  " + timingIssue(t)];
		windows(t).forEach(function (w) {
			out.push("  #" + w.seq + " stream " + w.gen + " len " + w.len_ms + " ms: in " + f1(fps(w.calls, w.len_ms)) +
				" fps, pass-through sends " + f1(fps(w.v_ok, w.len_ms)) + " fps; cb " + stat(w.cb) + "; send " + stat(w.vsend) +
				" (>=33 ms " + w.slow33 + "); gap " + stat(w.gap) + "; lock max " + mx(w.lk) + "/" + mx(w.plk) + " ms");
		});
		return out;
	}

	/* Human-readable summary (system.txt). r = collected results. */
	function systemText(r) {
		var s = r.snapshot || null, st = r.status_after || r.status_before || null, u = (s && s.udisk) || {};
		var c = (s && s.config) || {}, lines = [];
		lines.push("Carlinkit Mini Ultra 6 diagnostics: " + (r.complete ? "complete bundle" :
			"DIAGNOSTICS ONLY (stock logs not included)"));
		lines.push("Created (phone clock): " + r.created);
		lines.push("Adapter: platform " + (c.platform || "?") + ", custom " + (c.custom || "?") + ", version " + (c.version || "?"));
		lines.push("Shim build: " + ((s && s.build) || (st && st.build) || "unknown"));
		lines.push("Log saving (persist.console.log.nosave): " + (s ? (s.nosave === null ? "unreadable" :
			s.nosave === "" ? "unset (logs saved)" : JSON.stringify(s.nosave) + (s.nosave === "1" ? " = NOT SAVED" : "")) : "unknown"));
		lines.push("Storage: free " + mib(u.free_bytes) + ", log dir " + mib(u.log_bytes) + ", leftover local.zip: " +
			(u.leftover_zip === true ? "yes (" + mib(u.leftover_zip_bytes) + ")" : u.leftover_zip === false ? "no" : "unknown"));
		if (s && s.mem_kb) lines.push("Memory (kB): " + Object.keys(s.mem_kb).map(function (k) { return k + " " + s.mem_kb[k]; }).join(", "));
		if (s && Array.isArray(s.loadavg)) lines.push("Load average: " + s.loadavg.join(" "));
		if (s && Array.isArray(s.sample_up_cs)) lines.push("CPU sample (adapter uptime, 1/100 s): " + s.sample_up_cs.join(" -> "));
		lines = lines.concat(cpuLines(s));
		if (s && Array.isArray(s.net)) s.net.forEach(function (n) {
			lines.push("  net " + n.if + ": +" + n.delta.rx_bytes + " B rx, +" + n.delta.tx_bytes + " B tx in the sample; drops rx " +
				n.rx_drop + " tx " + n.tx_drop + ", errors rx " + n.rx_errs + " tx " + n.tx_errs);
		});
		["status_before", "status_after"].forEach(function (k) {
			var d = r[k];
			if (!d) { lines.push(k + ": unavailable"); return; }
			lines.push(k + " (adapter uptime " + d.now_ms + " ms):");
			timingView(d).rows.forEach(function (row) { lines.push("  " + row[0] + ": " + row[1]); });
			if (d.status) lines.push("  core: in " + d.status.in_fps + " fps, out " + d.status.pt_fps + " fps, stock " +
				d.status.stock_fps + " fps, " + d.status.kbps + " kbps, fallbacks " + d.status.fallbacks + ", push errors " + d.status.push_err);
		});
		var t = (r.status_after && r.status_after.timing) || (r.status_before && r.status_before.timing);
		if (t && (windows(t).length || timingIssue(t))) {
			lines.push("Timing history (oldest first, 1 ms clock; cb = hook time, gap = idle between frames):");
			lines = lines.concat(timingTable(t));
		}
		lines.push("Stock logs: " + (r.complete ? "included as stock-logs.zip (" + r.stock.bytes + " bytes, " +
			r.stock.entries + " entries)" : "NOT included: " + r.stock.error));
		r.warnings.forEach(function (w) { lines.push("WARNING: " + w); });
		return lines.join("\n") + "\n";
	}

	function readme(complete) {
		return [
			"Carlinkit Mini Ultra 6 pass-through diagnostics (TEST build, not a fix)",
			"",
			complete ? "This bundle is complete: it includes the adapter's own log ZIP." :
				"DIAGNOSTICS ONLY: the adapter's stock log ZIP could not be collected; see manifest.json stock_logs.error.",
			"",
			"Files:",
			complete ? "  stock-logs.zip  exact bytes from /cgi-bin/minizip.cgi?logID=local& (not inflated or recompressed;\n" +
				"                  the phone only checked the ZIP structure, not CRCs)" : "  (no stock-logs.zip)",
			"  status.json     shim status + timing before and after the CPU sample",
			"  system.txt      readable summary: version, storage, CPU/threads over 1 s, network, timing history",
			"  manifest.json   collection order, times, sizes, build, warnings, missing optional data",
			"  README.txt      this file",
			"",
			"Notes:",
			"  - Timing uses the adapter's 1 ms clock. 'Unsplit hook time' is wall time not split further; it is",
			"    not a CPU measurement. Rates are frames counted over each ~5 s window.",
			"  - The display mode is the last value the shim returned from sd_get_info_int, not proof of what",
			"    the phone was told.",
			"  - The adapter logs are UNREDACTED and may contain device, phone or network identifiers.",
			"    Share this file deliberately. Nothing was uploaded anywhere by the page.",
			""
		].join("\n");
	}

	if (typeof module !== "undefined" && module.exports)
		module.exports = {timingView: timingView, preflight: preflight, systemText: systemText, displayMode: displayMode,
			cap: cap, bundleName: bundleName, readme: readme, LIMITS: L, URLS: URLS, ORDER: ORDER,
			NEUTRALIZED: NEUTRALIZED, GUARDED: GUARDED};
	if (typeof document === "undefined") return;

	/* ---- browser --------------------------------------------------------- */

	var busy = false, stockUpdateActive = false, blobURL = null, realFetch = root.fetch;
	var stockPage = typeof root.GetZipFile === "function" && typeof root.queryDeviceVersion === "function";
	var notice = function () {};

	/* 1. Disable the stock automatic log export, vendor version query and
	 * telemetry before window.onload calls them (the stock onload itself runs
	 * unchanged). */
	NEUTRALIZED.forEach(function (n) {
		if (typeof root[n] !== "function") return;
		root[n] = function () {
			root.CPDiagNeutralized = (root.CPDiagNeutralized || 0) + 1;
			if (n === "queryDeviceVersion") {
				var r = document.getElementById("result");
				if (r) r.textContent = "Online version check is disabled in this diagnostic test build.";
			}
		};
	});

	/* 2. While preparing: refuse stock settings/firmware/reboot actions, and
	 * any other page request except the read-only status CGI. */
	GUARDED.forEach(function (n) {
		var f = root[n];
		if (typeof f !== "function") return;
		root[n] = function () {
			if (busy) { notice(); return undefined; }
			if (["downloadAliFile", "uploadChunks", "program", "btnaddEv"].indexOf(n) >= 0) stockUpdateActive = true;
			return f.apply(this, arguments);
		};
	});
	function allowedWhileBusy(u) {
		try { return new URL(String(u), location.href).pathname === URLS.status; } catch (e) { return false; }
	}
	if (typeof realFetch === "function") {
		root.fetch = function (input) {
			if (busy && !allowedWhileBusy(input && input.url ? input.url : input)) {
				notice();
				return Promise.reject(new TypeError("Blocked while the debug ZIP is being prepared"));
			}
			return realFetch.apply(this, arguments);
		};
	}
	if (root.XMLHttpRequest) {
		var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function (m, u) {
			this.cpdBlocked = busy && !allowedWhileBusy(u);
			return xo.apply(this, arguments);
		};
		XMLHttpRequest.prototype.send = function () {
			if (this.cpdBlocked) { notice(); return undefined; }
			return xs.apply(this, arguments);
		};
	}

	function tagged(code, msg) { var e = new Error(msg); e.code = code; return e; }

	async function readCapped(r, limit, ctl) {
		var cl = r.headers.get("content-length");
		if (cl !== null && /^\d+$/.test(cl) && Number(cl) > limit) {
			ctl.abort();
			throw tagged("oversize", "larger than " + mib(limit) + " (Content-Length " + cl + ")");
		}
		if (r.body && typeof r.body.getReader === "function") {
			var rd = r.body.getReader(), parts = [], n = 0;
			for (;;) {
				var x = await rd.read();
				if (x.done) break;
				n += x.value.byteLength;
				if (n > limit) {
					try { rd.cancel().catch(function () {}); } catch (e) { /* ignore */ }
					ctl.abort();
					throw tagged("oversize", "more than " + mib(limit));
				}
				parts.push(x.value);
			}
			var out = new Uint8Array(n), o = 0;
			parts.forEach(function (p) { out.set(p, o); o += p.byteLength; });
			return out;
		}
		var all = new Uint8Array(await r.arrayBuffer());
		if (all.byteLength > limit) throw tagged("oversize", "more than " + mib(limit));
		return all;
	}

	/* GET with a hang guard covering headers and body. Never throws. */
	async function getJSON(url, ms) {
		var ctl = new AbortController(), timedOut = false;
		var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, ms);
		try {
			var r = await realFetch(url, {cache: "no-store", redirect: "error", signal: ctl.signal});
			if (r.status !== 200) return {ok: false, error: "HTTP " + r.status};
			var text = new TextDecoder().decode(await readCapped(r, L.json, ctl));
			return {ok: true, value: JSON.parse(text)};
		} catch (e) {
			return {ok: false, error: timedOut ? "no answer within " + ms / 1000 + " s" :
				e && e.code ? e.message : "failed (" + ((e && e.message) || e) + ")"};
		} finally {
			clearTimeout(timer);
		}
	}

	async function fetchStockZip() {
		var ctl = new AbortController(), timedOut = false;
		var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, L.zip_ms);
		try {
			var r;
			try {
				r = await realFetch(URLS.minizip, {cache: "no-store", redirect: "error", signal: ctl.signal});
			} catch (e) {
				throw timedOut ? tagged("timeout", "no answer within " + L.zip_ms / 1000 + " s") :
					tagged("network", "request failed or was redirected");
			}
			if (r.status !== 200 || r.redirected) {
				ctl.abort();
				throw tagged("http", "HTTP " + r.status);
			}
			try {
				return await readCapped(r, L.zip, ctl);
			} catch (e) {
				if (e && e.code) throw e;
				throw timedOut ? tagged("timeout", "download did not finish within " + L.zip_ms / 1000 + " s") :
					tagged("network", "download interrupted");
			}
		} finally {
			clearTimeout(timer);
		}
	}

	/* Structure only, with the adapter's own JSZip: no inflation, no CRC. */
	async function checkZip(bytes) {
		if (!bytes.length) throw tagged("missing", "the exporter returned no data");
		if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
			throw tagged("malformed", "the exporter's answer is not a ZIP");
		var names = [];
		try {
			var z = await root.JSZip.loadAsync(bytes, {checkCRC32: false});
			z.forEach(function (p, f) { if (!f.dir) names.push(p); });
		} catch (e) {
			throw tagged("malformed", "ZIP structure is invalid (" + ((e && e.message) || e) + ")");
		}
		return {entries: names.length, names: names.slice(0, 200)};
	}

	function sha256(bytes) {
		var C = root.CryptoJS;
		if (!C && root.CPFW) { try { return root.CPFW.sha256().update(bytes).hex(); } catch (e) { return null; } }
		try {
			return C && C.SHA256 && C.lib && C.lib.WordArray ? C.SHA256(C.lib.WordArray.create(bytes)).toString() : null;
		} catch (e) { return null; }
	}

	function utf8len(s) { return new TextEncoder().encode(s).length; }

	/* ---- DOM ------------------------------------------------------------- */

	function mount(el) {
		var poll = el.getAttribute("data-poll") !== "0";
		if (el.getAttribute("data-compact") === "1") el.innerHTML =
			'<button type="button" class="cpd-prepare">Prepare debug ZIP</button>' +
			'<div class="cpd-warn" role="alert"></div><p class="cpd-state" role="status"></p>' +
			'<a class="cpd-download" style="display:none">Download debug ZIP</a>' +
			'<details class="cpd-timing"><summary>Frame timing</summary><table class="cpd-rows"><tbody></tbody></table></details>';
		else el.innerHTML =
			'<p class="cpd-intro" style="margin:0 0 .6em">For the 8 fps test: keep the car parked, show a moving map or ' +
			'scroll a list on the car screen for about 30 seconds, then tap <b>Prepare debug ZIP</b>. The adapter keeps the ' +
			'last ~2 minutes of timing, so it is fine if the motion stops while you switch to Safari.</p>' +
			'<table class="cpd-rows" style="width:100%;border-collapse:collapse;font-size:14px"><tbody></tbody></table>' +
			'<div class="cpd-warn" role="alert" style="color:var(--warn-fg,#874708);font-weight:600;margin:.6em 0"></div>' +
			'<button type="button" class="cpd-prepare" style="display:block;width:100%;padding:14px;margin:.6em 0;font-size:17px;' +
			'border-radius:8px;border:1px solid #3d84bc;background:#3d84bc;color:#fff;height:auto;line-height:normal">' +
			'Prepare debug ZIP</button>' +
			'<p class="cpd-state" role="status" style="margin:.4em 0">Nothing collected yet. Opening this page never collects logs.</p>' +
			'<a class="cpd-download" style="display:none;padding:14px;margin:.6em 0;font-size:17px;text-align:center;' +
			'border-radius:8px;border:2px solid var(--good-fg,#1b6631);color:var(--good-fg,#1b6631);text-decoration:none;font-weight:600">Download debug ZIP</a>' +
			'<p class="cpd-note" style="font-size:13px;color:var(--muted,#5f6b76);margin:.4em 0">Use one phone and one tab at a time: the ' +
			'adapter\'s log exporter has no lock. The ZIP holds unredacted adapter logs that may include device or phone ' +
			'identifiers; share it deliberately. Nothing is uploaded. The stock automatic log upload, ' +
			'online version check and usage reporting are switched off.</p>';
		var $ = function (c) { return el.querySelector("." + c); };
		var tbody = $("cpd-rows").tBodies[0], warn = $("cpd-warn"), btn = $("cpd-prepare"),
			state = $("cpd-state"), link = $("cpd-download");
		var say = function (t) { state.textContent = t; };
		if (el.getAttribute("data-compact") === "1") say("");
		notice = function () { say("Please wait: the debug ZIP is being prepared. Settings and updates are paused until it is ready."); };

		function rows(d) {
			tbody.textContent = "";
			timingView(d).rows.forEach(function (r) {
				var tr = document.createElement("tr"), th = document.createElement("th"), td = document.createElement("td");
				th.textContent = r[0];
				td.textContent = r[1];
				th.style.cssText = "text-align:left;font-weight:500;color:var(--muted,#5f6b76);padding:3px 8px 3px 0;vertical-align:top;width:45%";
				td.style.cssText = "padding:3px 0;overflow-wrap:anywhere";
				tr.appendChild(th); tr.appendChild(td); tbody.appendChild(tr);
			});
		}
		var polling = false;
		async function refresh() {
			if (busy || polling) return;
			polling = true;
			var r = await getJSON(URLS.status, L.status_ms);
			polling = false;
			if (r.ok) rows(r.value);
			else { tbody.textContent = ""; say("Status unavailable: " + r.error); }
		}
		CPDiag.status = function (d) {
			if (busy) return;
			if (d) rows(d);
			else { tbody.textContent = ""; say("Status unavailable: reconnect to the adapter to refresh measurements."); }
		};
		if (poll) {
			refresh();
			setInterval(refresh, L.poll_ms);
		}

		function clearLink() {
			if (blobURL) URL.revokeObjectURL(blobURL);
			blobURL = null;
			link.removeAttribute("href");
			link.style.display = "none";
		}
		root.addEventListener("pagehide", clearLink);

		btn.addEventListener("click", function () { prepare(); });

		async function prepare() {
			if (busy) return; /* double taps */
			var upgrade = document.getElementById("download_btn"), progress = document.getElementById("download-bar");
			if (document.getElementById("carlinkit-local-upload") || stockUpdateActive || root.program_filename ||
				(root.CPFW && (root.CPFW.busy() || root.CPFW.installing())) ||
				(upgrade && upgrade.disabled) || (progress && (progress.value > 0 || getComputedStyle(progress).display !== "none"))) {
				say("Not started: a firmware upload or update helper is active. Finish the update before collecting logs on a fresh page.");
				return;
			}
			busy = true;
			btn.disabled = true;
			btn.textContent = "Preparing...";
			el.setAttribute("data-state", "preparing");
			clearLink();
			warn.textContent = "";
			var t0 = Date.now(), created = new Date();
			var r = {created: created.toISOString(), steps: [], warnings: [], missing: [], complete: false,
				status_before: null, snapshot: null, status_after: null, stock: {included: false, error: null}};
			function step(name, res) {
				r.steps.push({step: name, phone_ms: Date.now() - t0, ok: !!(res && res.ok),
					error: res && !res.ok ? res.error : null});
			}
			try {
				say("1/5 Reading status...");
				var a = await getJSON(URLS.status, L.status_ms);
				step("status_before", a);
				if (a.ok) r.status_before = a.value; else r.missing.push("status_before: " + a.error);
				say("2/5 Measuring CPU for 1 second...");
				var b = await getJSON(URLS.snapshot, L.snapshot_ms);
				step("snapshot", b);
				if (b.ok) r.snapshot = b.value; else r.missing.push("snapshot: " + b.error);
				say("3/5 Reading status again...");
				var c = await getJSON(URLS.status, L.status_ms);
				step("status_after", c);
				if (c.ok) r.status_after = c.value; else r.missing.push("status_after: " + c.error);
				if (r.snapshot && Array.isArray(r.snapshot.missing))
					r.snapshot.missing.forEach(function (m) { r.missing.push("snapshot." + m); });
				[r.status_before, r.status_after].forEach(function (d, i) {
					if (d && !d.timing) r.missing.push((i ? "status_after" : "status_before") + ".timing: " + (d.timing_error || "null"));
					else if (d && timingIssue(d.timing)) r.missing.push((i ? "status_after" : "status_before") + ".timing: " + timingIssue(d.timing));
				});

				var pf = preflight(r.snapshot);
				r.preflight = pf;
				r.warnings = pf.warnings.slice();
				warn.textContent = r.warnings.join(" ");
				var bytes = null;
				if (!pf.ok) {
					r.stock.error = "not attempted: " + pf.reason;
					r.stock.code = "preflight";
					step("minizip", {ok: false, error: r.stock.error});
				} else {
					say("4/5 Asking the adapter to zip its logs (can take a while)...");
					try {
						bytes = await fetchStockZip();
						step("minizip_download", {ok: true});
						var info = await checkZip(bytes);
						step("minizip_check", {ok: true});
						r.stock = {included: true, error: null, bytes: bytes.length, entries: info.entries,
							names: info.names, sha256: sha256(bytes)};
						if (!info.entries) r.warnings.push("The stock log ZIP has no files in it.");
						if (r.stock.sha256 === null) r.missing.push("stock_logs.sha256: no hash function available");
						r.complete = true;
					} catch (e) {
						bytes = null;
						r.stock = {included: false, code: e.code || "error", error: (e.code || "error") + ": " + e.message};
						if (e.code === "timeout")
							r.stock.note = "The phone stopped waiting; the adapter may still be compressing. Wait a minute before trying again.";
						step("minizip", {ok: false, error: r.stock.error});
					}
				}

				say("5/5 Building the ZIP on the phone...");
				var z = new root.JSZip(), files = [];
				var add = function (name, data) {
					z.file(name, data, {binary: typeof data !== "string", compression: "STORE", date: created});
					files.push({name: name, bytes: typeof data === "string" ? utf8len(data) : data.length});
				};
				if (r.complete) add("stock-logs.zip", bytes);
				var sj = cap(JSON.stringify({note: "status CGI JSON before and after the 1 s CPU sample, plus the snapshot",
					status_before: r.status_before, snapshot: r.snapshot, status_after: r.status_after}, null, 1));
				var sx = cap(systemText(r));
				if (sj.truncated) r.warnings.push("status.json was truncated at 256 KiB.");
				if (sx.truncated) r.warnings.push("system.txt was truncated at 256 KiB.");
				add("status.json", sj.text);
				add("system.txt", sx.text);
				var rd = readme(r.complete);
				var manifest = {
					format: "carlinkit-ultra6-debug-bundle", version: 1,
					kind: r.complete ? "complete" : "diagnostics-only", complete: r.complete,
					created_phone: r.created, page: location.pathname,
					build: (r.snapshot && r.snapshot.build) || (r.status_before && r.status_before.build) || null,
					adapter_config: r.snapshot ? r.snapshot.config : null,
					order: ORDER.filter(function (n) { return r.complete || n !== "stock-logs.zip"; }),
					files: files.concat([{name: "README.txt", bytes: utf8len(rd)}]),
					files_note: "sizes of every file except manifest.json itself", steps: r.steps,
					stock_logs: r.complete ? {included: true, bytes: r.stock.bytes, entries: r.stock.entries,
						names: r.stock.names, sha256: r.stock.sha256,
						source: URLS.minizip, note: "exact bytes; not inflated, recompressed or CRC-checked"} :
						{included: false, error: r.stock.error, code: r.stock.code || null, note: r.stock.note || null},
					preflight: r.preflight, warnings: r.warnings, missing: r.missing, limits: L, unredacted: true
				};
				var mj = cap(JSON.stringify(manifest, null, 1));
				add("manifest.json", mj.text);
				add("README.txt", rd);
				var blob = await z.generateAsync({type: "blob", compression: "STORE", mimeType: "application/zip"});
				blobURL = URL.createObjectURL(blob);
				link.href = blobURL;
				link.download = bundleName(r.complete, created);
				link.textContent = r.complete ? "Download debug ZIP" : "Download diagnostics-only ZIP (no stock logs)";
				link.style.display = "block";
				el.setAttribute("data-state", r.complete ? "ready" : "ready-partial");
				say(r.complete ? "Ready (" + mib(blob.size) + "). Tap Download, then save it in Files." :
					"Stock logs NOT collected: " + r.stock.error + (r.stock.note ? " " + r.stock.note : "") +
					". A diagnostics-only ZIP (" + mib(blob.size) + ") is ready instead.");
			} catch (e) {
				el.setAttribute("data-state", "failed");
				say("Could not build the ZIP: " + ((e && e.message) || e) + ". Nothing was uploaded. You can try again.");
			} finally {
				busy = false;
				btn.disabled = false;
				btn.textContent = "Prepare debug ZIP again";
			}
		}
	}

	var CPDiag = root.CPDiag = {busy: function () { return busy; }, status: function () {}, stockPage: stockPage};
	function start() {
		var el = document.getElementById("cpd-panel");
		if (el && root.JSZip) mount(el);
		else if (el) el.textContent = "Diagnostics unavailable: JSZip did not load.";
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})(typeof window !== "undefined" ? window : this);
