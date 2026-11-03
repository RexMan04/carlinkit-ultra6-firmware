/* Main page (MAINPAGE_PLAN.md): live status, verified settings, presets,
 * recovery, device info; the updater (cpthru_fw.js) and debug ZIP
 * (cpthru_diag.js) mount into their own cards. Pure parts (view, settings
 * table, preset validation) are exported for node tests. */
(function (root) {
	"use strict";
	var STALE_MS = 7000;
	function opts(list, fmt) { return list.map(function (v) { return [String(v), fmt(v)]; }); }
	/* Every key here is in cpthru_set.cgi's allowlist with exactly these values. */
	var SETTINGS = [
		{key: "persist.cpthru.off", group: "video", label: "CarPlay video", def: "0",
			opts: [["0", "Pass-through"], ["1", "Stock processing"]], when: "the next time CarPlay connects",
			note: "Pass-through sends the iPhone's video straight to the car. Stock processing re-encodes it on the adapter " +
				"(fixed 30 fps). AirPlay and automatic fallback always use stock processing."},
		{key: "persist.suding.wl.audio.latency", group: "audio", label: "Audio delay", def: "0",
			opts: [["0", "Phone decides"]].concat(opts([300, 400, 500, 600, 700, 800, 900, 1000], function (v) { return v + " ms"; })),
			when: "the next time CarPlay connects",
			note: "How much audio the adapter buffers. Lower feels snappier but can crackle when Wi-Fi hiccups. 300 ms is the " +
				"lowest the firmware accepts (the stock menu stopped at 400)."},
		{key: "persist.sys.carplay.audio.media.samplerate", group: "audio", label: "Audio stream mode", def: null,
			opts: [["44100", "CD 44.1 kHz"], ["48000", "DVD 48 kHz"]], when: "after the adapter restarts",
			note: "The stock Audio Stream Mode setting (sample rate of media audio sent to the car)."},
		{key: "persist.sys.wifi.channel", group: "conn", label: "Hotspot channel", def: null,
			opts: opts([36, 40, 44, 48, 149, 153, 157, 161], function (v) { return String(v); }), when: "after the adapter restarts",
			note: "5 GHz channel of the adapter's hotspot. Try another one if other Wi-Fi in the car interferes. After the " +
				"restart the iPhone reconnects on the new channel."},
		{key: "persist.sys.boot.delay", group: "conn", label: "Startup delay", def: "0",
			opts: opts([0, 5, 10, 15, 20, 30, 40, 50, 60], function (v) { return v + " s"; }), when: "the next time the adapter powers on",
			note: "Wait before talking to the car after power-on. Raise it if the car only recognises the adapter after " +
				"unplugging and replugging; about the time the car screen needs to finish starting."},
		{key: "persist.sys.headunit.gps.disable", group: "conn", label: "Car GPS to iPhone", def: "0",
			opts: [["0", "On"], ["1", "Off"]], when: "the next time CarPlay connects",
			note: "Sends the car's GPS position to the iPhone."},
		{key: "persist.suding.wireless.carplay.force.display", group: "conn", label: "Force display", def: "0",
			opts: [["0", "Off"], ["1", "On"]], when: "the next time CarPlay connects",
			note: "The stock Force Display switch. The vendor does not document what it changes; leave it off unless the " +
				"car screen stays blank."}
	];
	var KEYS = SETTINGS.map(function (s) { return s.key; });
	function byKey(k) { return SETTINGS.filter(function (s) { return s.key === k; })[0]; }
	function allowed(k, v) { var s = byKey(k); return !!s && s.opts.some(function (o) { return o[0] === String(v); }); }
	function shown(s, v) { return v === "" || v === undefined || v === null ? s.def : String(v); }

	/* Settings file (export/import). Returns {presets, errors}. */
	function cleanSettings(obj, errors, where) {
		var out = {};
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) { errors.push(where + ": not a settings list"); return out; }
		Object.keys(obj).forEach(function (k) {
			if (allowed(k, obj[k])) out[k] = String(obj[k]);
			else errors.push(where + ": ignored " + k + "=" + JSON.stringify(obj[k]).slice(0, 40));
		});
		return out;
	}
	function parseFile(text) {
		var d, errors = [], presets = [];
		try { d = JSON.parse(text); } catch (e) { return {presets: [], errors: ["not a JSON file"]}; }
		if (!d || d.format !== "carlinkit-ultra6-settings" || d.schema !== 1) return {presets: [], errors: ["not a settings file from this page"]};
		if (Array.isArray(d.presets)) d.presets.slice(0, 20).forEach(function (p, i) {
			var name = typeof p.name === "string" ? p.name.slice(0, 40).trim() : "";
			var s = cleanSettings(p.settings, errors, "preset " + (name || i + 1));
			if (name && Object.keys(s).length) presets.push({name: name, settings: s});
		});
		if (d.current) {
			var c = cleanSettings(d.current, errors, "current settings");
			if (Object.keys(c).length) presets.push({name: "Imported " + String(d.exported || "").slice(0, 10), settings: c});
		}
		return {presets: presets, errors: errors};
	}

	/* Status CGI JSON -> display model (same rules as the reviewed /cpthru.html). */
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
		case "PASSTHRU": return ["Pass-through active", "ok"];
		case "SYNC_CONFIG": case "WAIT_IDR": case "RESYNC": return ["Syncing with the car", "info"];
		case "TRANSPORT_LOST": return ["Car link lost, waiting for it to restart", "warn"];
		case "FALLBACK": return ["Switching to stock", "info"];
		case "TRANSCODE":
			if (st.off) return ["Stock processing (pass-through switched off)", "info"];
			if (st.marker) return ["Stock (pass-through auto-disabled after failures)", "warn"];
			if (st.last_fallback) return ["Stock (fell back)", "warn"];
			return ["Stock processing", "info"];
		default: return ["Waiting for the phone and car", "info"];
		}
	}
	function view(d) {
		var st = d.status, ln = d.link, now = d.now_ms, rows = [], mode, tiles = {out: null, in: null, kbps: null, fb: null, outLabel: "Video to car (fps)"};
		if (!st && !ln) mode = ["No CarPlay session since boot", "info"];
		else if (ln && !ln.stream) mode = ["No CarPlay video right now", "info"];
		else if (!st) mode = ["Starting", "info"];
		else mode = modeOf(st, now);
		var live = st && ln && ln.stream && now - st.up_ms <= STALE_MS;
		if (live) {
			var pt = st.state === "PASSTHRU";
			tiles.out = (pt ? st.pt_fps : st.stock_fps).toFixed(1);
			tiles.outLabel = "Video to car (fps, " + (pt ? "pass-through" : "stock") + ")";
			tiles.in = st.in_fps.toFixed(1);
			tiles.kbps = String(Math.round(st.kbps));
		}
		var markers = d.markers || [], build = d.build || (st && st.build) || "";
		var disabled = build && markers.indexOf(build) >= 0;
		rows.push(["Auto-disabled after failures", disabled ? "Yes: pass-through stays off until a new build is installed" :
			markers.length ? "No (markers from older builds are ignored)" : "No"]);
		if (st) {
			tiles.fb = String(st.fallbacks);
			rows.push(["Car screen asked for", st.car.indexOf("0x0") === 0 ? "unknown" : st.car]);
			rows.push(["Phone stream", st.phone.indexOf("0x0") === 0 ? "unknown" : st.phone]);
			rows.push(["Last fallback", st.last_fallback ?
				st.last_fallback + " (" + ago(now - (st.up_ms - (st.t_ms - st.last_fallback_t_ms))) + ")" : "none"]);
			rows.push(["Status updated", ago(now - st.up_ms)]);
		}
		if (ln) rows.push(["Last connection event", ln.event + " (" + ago(now - ln.up_ms) + ")"]);
		if (build) rows.push(["Shim build", build]);
		return {mode: mode[0], tone: mode[1], rows: rows, tiles: tiles, autoDisabled: !!disabled};
	}

	if (typeof module !== "undefined" && module.exports) {
		module.exports = {SETTINGS: SETTINGS, KEYS: KEYS, allowed: allowed, parseFile: parseFile, view: view};
		return;
	}

	/* ---- DOM ---- */
	var $ = function (id) { return document.getElementById(id); };
	var values = {}, saving = false, armed = null, armTimer = null, presetsMem = [];
	function msg(t, tone) { var m = $("msg"); m.textContent = t || ""; m.className = "callout" + (tone === "bad" ? " warn" : ""); }
	function tr(tb, a, b) {
		var r = document.createElement("tr"), th = document.createElement("th"), td = document.createElement("td");
		th.textContent = a; td.textContent = b; r.appendChild(th); r.appendChild(td); tb.appendChild(r);
	}
	async function get(url, ms) {
		var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, ms || 8000);
		try {
			var r = await fetch(url, {cache: "no-store", redirect: "error", signal: ctl.signal});
			if (r.status !== 200) throw Error("HTTP " + r.status);
			return await r.text();
		} finally { clearTimeout(timer); }
	}
	function blocked() {
		if (root.CPFW && (root.CPFW.busy() || root.CPFW.installing())) return "a firmware upload or install is in progress.";
		if (root.CPDiag && root.CPDiag.busy()) return "the debug ZIP is being prepared.";
		if (saving) return "a setting is being saved.";
		return null;
	}
	function arm(id) {
		if (armed === id) { clearTimeout(armTimer); armed = null; return true; }
		armed = id; clearTimeout(armTimer);
		armTimer = setTimeout(function () { armed = null; renderAll(); }, 4000);
		renderAll();
		return false;
	}

	/* ---- settings ---- */
	async function readSettings() {
		try {
			var d = JSON.parse(await get("/cgi-bin/cpthru_settings.cgi", 20000));
			values = d.values || {};
			if (!d.ok) msg("Some saved settings could not be read; they show as unknown.", "bad");
		} catch (e) { msg("Could not read the saved settings: " + e.message, "bad"); }
		renderAll();
	}
	async function setOne(key, value) {
		try {
			var d = JSON.parse(await get("/cgi-bin/cpthru_set.cgi?key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(value), 10000));
			if (d.ok && d.value === String(value)) { values[key] = d.value; return null; }
			return d.error || "the adapter reported " + d.value;
		} catch (e) { return "can't reach the adapter"; }
	}
	async function saveMany(pairs, label) {
		var why = blocked();
		if (why) { msg("Not saved: " + why, "bad"); return; }
		saving = true; renderAll();
		var bad = [], done = [];
		for (var i = 0; i < pairs.length; i++) {
			var err = await setOne(pairs[i][0], pairs[i][1]);
			(err ? bad : done).push(byKey(pairs[i][0]).label + (err ? " (" + err + ")" : ""));
		}
		saving = false;
		await readSettings();
		var when = {};
		pairs.forEach(function (p) { when[byKey(p[0]).when] = 1; });
		if (!bad.length) msg(label + ": saved " + done.join(", ") + ". Takes effect " + Object.keys(when).join("; or ") + ".");
		else msg(label + ": " + (done.length ? "saved " + done.join(", ") + "; " : "") + "NOT saved " + bad.join(", ") + ".", "bad");
	}
	function renderSettings() {
		SETTINGS.forEach(function (s) {
			var box = $("st-" + s.key);
			if (!box) {
				box = document.createElement("div"); box.className = "setting"; box.id = "st-" + s.key;
				box.innerHTML = '<div class="head"><h3></h3><span class="saved"></span></div><div class="chips"></div><p class="note"></p>';
				box.querySelector("h3").textContent = s.label;
				box.querySelector(".note").textContent = s.note + " Takes effect " + s.when + ".";
				s.opts.forEach(function (o) {
					var b = document.createElement("button"); b.type = "button"; b.className = "chip";
					b.onclick = function () {
						var why = blocked();
						if (why) { msg("Not saved: " + why, "bad"); return; }
						if (shown(s, values[s.key]) === o[0] && values[s.key] !== "") return;
						if (arm(s.key + "=" + o[0])) saveMany([[s.key, o[0]]], s.label);
					};
					box.querySelector(".chips").appendChild(b);
				});
				$("set-" + s.group).appendChild(box);
			}
			var cur = values[s.key], sel = shown(s, cur);
			var chips = box.querySelectorAll(".chip");
			s.opts.forEach(function (o, i) {
				var b = chips[i], id = s.key + "=" + o[0];
				b.textContent = armed === id ? "Tap again to save" : o[1];
				b.className = "chip" + (sel === o[0] ? " sel" : "") + (armed === id ? " armed" : "");
				b.disabled = saving;
			});
			var lab = box.querySelector(".saved");
			lab.textContent = cur === undefined ? "Unknown" : cur === "" ? (s.def === null ? "Not set (adapter default)" : "Default") : "Saved";
			lab.className = "saved" + (cur === undefined ? " bad" : "");
		});
	}

	/* ---- presets ---- */
	function loadPresets() {
		try { var p = JSON.parse(localStorage.getItem("cpthru.presets") || "[]"); return Array.isArray(p) ? p : []; }
		catch (e) { return presetsMem; }
	}
	function savePresets(p) {
		presetsMem = p;
		try { localStorage.setItem("cpthru.presets", JSON.stringify(p)); return true; } catch (e) { return false; }
	}
	function currentSettings() {
		var o = {};
		KEYS.forEach(function (k) { if (values[k] !== undefined && values[k] !== "") o[k] = values[k]; });
		return o;
	}
	function renderPresets() {
		var box = $("preset-list"), list = loadPresets();
		box.textContent = "";
		if (!list.length) { var p = document.createElement("p"); p.className = "note"; p.textContent = "No presets saved on this phone yet."; box.appendChild(p); }
		list.forEach(function (p, i) {
			var row = document.createElement("div"), name = document.createElement("span"),
				apply = document.createElement("button"), del = document.createElement("button");
			row.className = "preset";
			name.textContent = p.name + " (" + Object.keys(p.settings).length + " settings)";
			apply.type = del.type = "button";
			apply.className = "btn" + (armed === "pa" + i ? " armed" : "");
			del.className = "btn" + (armed === "pd" + i ? " armed" : "");
			apply.textContent = armed === "pa" + i ? "Tap again" : "Apply";
			del.textContent = armed === "pd" + i ? "Tap again" : "Delete";
			apply.disabled = del.disabled = saving;
			apply.onclick = function () {
				var why = blocked();
				if (why) { msg("Not applied: " + why, "bad"); return; }
				if (!arm("pa" + i)) return;
				var pairs = Object.keys(p.settings).filter(function (k) { return allowed(k, p.settings[k]) && values[k] !== p.settings[k]; })
					.map(function (k) { return [k, p.settings[k]]; });
				if (!pairs.length) { msg("Preset \"" + p.name + "\" already matches the saved settings."); renderAll(); return; }
				saveMany(pairs, "Preset \"" + p.name + "\"");
			};
			del.onclick = function () {
				if (!arm("pd" + i)) return;
				var l = loadPresets(); l.splice(i, 1); savePresets(l); msg("Deleted preset \"" + p.name + "\"."); renderAll();
			};
			row.appendChild(name); row.appendChild(apply); row.appendChild(del); box.appendChild(row);
		});
	}
	function addPresets(add) {
		var list = loadPresets();
		add.forEach(function (p) {
			var name = p.name, n = 2;
			while (list.some(function (q) { return q.name === name; })) name = p.name + " (" + n++ + ")";
			list.push({name: name, settings: p.settings});
		});
		list = list.slice(-20);
		return savePresets(list);
	}

	/* ---- status ---- */
	var statusPending = false;
	async function refresh() {
		if (statusPending || (root.CPFW && root.CPFW.busy())) return;
		statusPending = true;
		try {
			var d = JSON.parse(await get("/cgi-bin/cpthru_status.cgi", 6000));
			var m = view(d);
			$("mode").textContent = m.mode; $("mode").className = "pill " + m.tone;
			$("s-out").textContent = m.tiles.out || "–"; $("s-out-l").textContent = m.tiles.outLabel;
			$("s-in").textContent = m.tiles.in || "–";
			$("s-kbps").textContent = m.tiles.kbps || "–";
			$("s-fb").textContent = m.tiles.fb || "–";
			var tb = $("rows"); tb.textContent = "";
			m.rows.forEach(function (r) { tr(tb, r[0], r[1]); });
			if (root.CPDiag) root.CPDiag.status(d);
		} catch (e) {
			$("mode").textContent = "Status unavailable"; $("mode").className = "pill warn";
			["s-out", "s-in", "s-kbps", "s-fb"].forEach(function (id) { $(id).textContent = "–"; });
			$("rows").textContent = "";
			if (root.CPDiag) root.CPDiag.status(null);
		} finally { statusPending = false; }
	}

	/* ---- device ---- */
	async function device() {
		var tb = $("dev"), rel = null, kv = {};
		try {
			var t = await get("/cgi-bin/getversion.cgi");
			t.split("\n").forEach(function (l) { var i = l.indexOf(":"); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
		} catch (e) { /* shown as unknown */ }
		try { rel = JSON.parse(await get("/cpthru-release.json")); } catch (e) { rel = null; }
		var relText = rel ? rel.version + " (release ID " + rel.release_id + ")" : "unknown";
		$("ident").textContent = "Project release " + relText + " on system " + (kv.system_version || "unknown") + ".";
		$("fw-now").textContent = "Installed now: project release " + relText + ", shim " + (rel ? rel.shim_build : "unknown") +
			", system " + (kv.system_version || "unknown") + ".";
		tb.textContent = "";
		[["Project release", relText], ["Shim build", rel ? rel.shim_build : "unknown"],
			["System version", kv.system_version], ["Product", kv.product_Model], ["Platform / custom", (kv.platform || "?") + " / " + (kv.custom || "?")],
			["Protocol version", kv.protocol_version], ["Serial", kv.uuid],
			["Car (as reported)", [kv.get_manufacturer, kv.get_model, kv.get_srcVersion].filter(Boolean).join(" ")],
			["Activated", kv.isActivate === "1" ? "Yes" : kv.isActivate ? "No: activation needs the stock firmware page" : "unknown"]
		].forEach(function (r) { tr(tb, r[0], r[1] || "unknown"); });
	}

	function renderAll() { renderSettings(); renderPresets(); renderRecovery(); }
	function renderRecovery() {
		[["rc-stock", "Use stock video processing"], ["rc-reset", "Reset project settings"], ["rc-factory", "Factory reset and restart"]]
			.forEach(function (b) {
				var el = $(b[0]);
				el.textContent = armed === b[0] ? "Tap again to confirm" : b[1];
				el.classList.toggle("armed", armed === b[0]);
				el.disabled = saving;
			});
	}

	function start() {
		renderAll();
		$("rc-stock").onclick = function () { if (!blocked() && arm("rc-stock")) saveMany([["persist.cpthru.off", "1"]], "Stock video processing"); else if (blocked()) msg("Not saved: " + blocked(), "bad"); };
		$("rc-reset").onclick = function () {
			if (blocked()) { msg("Not saved: " + blocked(), "bad"); return; }
			if (arm("rc-reset")) saveMany([["persist.cpthru.off", "0"], ["persist.suding.wl.audio.latency", "0"]], "Reset project settings");
		};
		$("rc-factory").onclick = async function () {
			if (blocked()) { msg("Not started: " + blocked(), "bad"); return; }
			if (!arm("rc-factory")) return;
			saving = true; renderAll();
			try {
				var t = await get("/cgi-bin/factoryreset.cgi?wifi_channel=36&delayTimer=0&", 15000);
				if (/refused/.test(t)) { saving = false; msg("Factory reset refused: " + t.replace(/^[\s\S]*refused: /, ""), "bad"); renderAll(); return; }
			} catch (e) { /* the adapter restarts and may drop the reply */ }
			msg("Factory reset sent. The adapter is restarting; rejoin its Wi-Fi and reload this page in about a minute.");
		};
		$("preset-save").onclick = function () {
			var name = $("preset-name").value.trim().slice(0, 40), s = currentSettings();
			if (!name) { msg("Type a name for the preset first.", "bad"); return; }
			if (!Object.keys(s).length) { msg("No saved settings to store yet.", "bad"); return; }
			var ok = addPresets([{name: name, settings: s}]);
			$("preset-name").value = "";
			msg(ok ? "Saved preset \"" + name + "\" on this phone." : "Preset kept for this visit only: Safari would not store it (private mode?). Export a file to keep it.", ok ? "" : "bad");
			renderAll();
		};
		$("cfg-export").onclick = function () {
			var d = {format: "carlinkit-ultra6-settings", schema: 1, exported: new Date().toISOString(),
				current: currentSettings(), presets: loadPresets()};
			var a = $("cfg-dl"), url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], {type: "application/json"}));
			a.href = url; a.download = "carlinkit-settings-" + d.exported.slice(0, 10) + ".json"; a.click();
			setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
			msg("Exported the saved settings and " + d.presets.length + " preset(s). Choose Save to Files if Safari asks.");
		};
		$("cfg-import").onchange = async function () {
			var f = this.files && this.files[0];
			this.value = "";
			if (!f) return;
			if (f.size > 65536) { msg("Not imported: that file is too large to be a settings file.", "bad"); return; }
			var r = parseFile(await f.text());
			if (!r.presets.length) { msg("Nothing imported: " + (r.errors[0] || "no valid settings in the file") + ".", "bad"); return; }
			addPresets(r.presets);
			msg("Imported " + r.presets.length + " preset(s): " + r.presets.map(function (p) { return p.name; }).join(", ") +
				". Nothing was changed on the adapter; tap Apply on a preset to use it." +
				(r.errors.length ? " Skipped: " + r.errors.join("; ") + "." : ""), r.errors.length ? "bad" : "");
			renderAll();
		};
		if (/ndroid/.test(navigator.userAgent)) {
			var b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = "Switch to P2P (Android)";
			b.onclick = function () {
				if (blocked()) { msg("Not sent: " + blocked(), "bad"); return; }
				if (!arm("p2p")) { b.textContent = "Tap again to switch"; return; }
				b.textContent = "Switch to P2P (Android)";
				get("/cgi-bin/switch_p2p.cgi").then(function () { msg("Switch to P2P sent (stock Android Auto option)."); },
					function () { msg("Switch to P2P sent; the connection may have dropped while switching."); });
			};
			$("set-conn").appendChild(b);
		}
		if (root.CPFW) root.CPFW.mount($("fw-panel"), {
			busyOthers: function () {
				if (root.CPDiag && root.CPDiag.busy()) return "wait until the debug ZIP is ready.";
				if (saving) return "wait until the setting is saved.";
				return null;
			},
			onBusy: function () { renderAll(); }
		});
		else $("fw-panel").textContent = "Updater unavailable: cpthru_fw.js did not load.";
		readSettings();
		device();
		refresh();
		setInterval(refresh, 2000);
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})(typeof window !== "undefined" ? window : this);
