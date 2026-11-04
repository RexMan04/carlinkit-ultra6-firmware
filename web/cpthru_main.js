/* Main page (MAINPAGE_PLAN.md): tabs for status, settings + presets, update
 * (cpthru_fw.js) and tools (debug ZIP from cpthru_diag.js, recovery, device).
 * Pure parts (settings table, preset file parsing, status view) are exported
 * for node tests. */
(function (root) {
	"use strict";
	var STALE_MS = 7000;
	function opts(list, fmt) { return list.map(function (v) { return [String(v), fmt(v)]; }); }
	var NEXT = "Next connection", RESTART = "After restart";
	/* Every key here is in cpthru_set.cgi's allowlist with exactly these values.
	 * Toggles: on/off are the stored values for the switch positions. */
	var SETTINGS = [
		{key: "persist.cpthru.off", group: "video", label: "Pass-through", hint: NEXT, def: "0", type: "toggle", on: "0", off: "1",
			opts: [["0", "On"], ["1", "Off (stock processing)"]]},
		{key: "persist.suding.wl.audio.latency", group: "audio", label: "Audio delay", hint: NEXT, def: "0", type: "select",
			opts: [["0", "Phone decides"]].concat(opts([300, 400, 500, 600, 700, 800, 900, 1000], function (v) { return v + " ms"; }))},
		{key: "persist.sys.carplay.audio.media.samplerate", group: "audio", label: "Audio stream", hint: RESTART, def: null, type: "select",
			opts: [["44100", "44.1 kHz (CD)"], ["48000", "48 kHz (DVD)"]]},
		{key: "persist.sys.wifi.channel", group: "conn", label: "Hotspot channel", hint: RESTART, def: null, type: "select",
			opts: opts([36, 40, 44, 48, 149, 153, 157, 161], function (v) { return String(v); })},
		{key: "persist.sys.boot.delay", group: "conn", label: "Startup delay", hint: "Next power-on", def: "0", type: "select",
			opts: opts([0, 5, 10, 15, 20, 30, 40, 50, 60], function (v) { return v + " s"; })},
		{key: "persist.sys.headunit.gps.disable", group: "conn", label: "Car GPS to iPhone", hint: NEXT, def: "0", type: "toggle", on: "0", off: "1",
			opts: [["0", "On"], ["1", "Off"]]},
		{key: "persist.suding.wireless.carplay.force.display", group: "conn", label: "Force display", hint: NEXT, def: "0", type: "toggle", on: "1", off: "0",
			opts: [["0", "Off"], ["1", "On"]]}
	];
	var KEYS = SETTINGS.map(function (s) { return s.key; });
	function byKey(k) { return SETTINGS.filter(function (s) { return s.key === k; })[0]; }
	function allowed(k, v) { var s = byKey(k); return !!s && s.opts.some(function (o) { return o[0] === String(v); }); }

	/* Settings file (export/import). Returns {presets, errors}. */
	function cleanSettings(obj, errors, where) {
		var out = {};
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) { errors.push(where + ": not a settings list"); return out; }
		Object.keys(obj).forEach(function (k) {
			if (allowed(k, obj[k])) out[k] = String(obj[k]);
			else errors.push(k + "=" + JSON.stringify(obj[k]).slice(0, 40));
		});
		return out;
	}
	function parseFile(text) {
		var d, errors = [], presets = [];
		try { d = JSON.parse(text); } catch (e) { return {presets: [], errors: ["not a JSON file"]}; }
		if (!d || d.format !== "carlinkit-ultra6-settings" || d.schema !== 1) return {presets: [], errors: ["not a settings file"]};
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
		if (age > STALE_MS) return ["No frames " + Math.round(age / 1000) + " s", "warn"];
		switch (st.state) {
		case "PASSTHRU": return ["Pass-through", "ok"];
		case "SYNC_CONFIG": case "WAIT_IDR": case "RESYNC": return ["Syncing", ""];
		case "TRANSPORT_LOST": return ["Car link lost", "warn"];
		case "FALLBACK": return ["Switching to stock", ""];
		case "TRANSCODE":
			if (st.off) return ["Stock", ""];
			if (st.marker) return ["Stock (auto-disabled)", "warn"];
			if (st.last_fallback) return ["Stock (fell back)", "warn"];
			return ["Stock", ""];
		default: return ["Waiting", ""];
		}
	}
	function view(d) {
		var st = d.status, ln = d.link, now = d.now_ms, rows = [], mode, tiles = {out: null, in: null, kbps: null, fb: null, outLabel: "To car (fps)"};
		if (!st && !ln) mode = ["Idle", ""];
		else if (ln && !ln.stream) mode = ["No video", ""];
		else if (!st) mode = ["Starting", ""];
		else mode = modeOf(st, now);
		var live = st && ln && ln.stream && now - st.up_ms <= STALE_MS;
		if (live) {
			var pt = st.state === "PASSTHRU";
			tiles.out = (pt ? st.pt_fps : st.stock_fps).toFixed(1);
			tiles.outLabel = "To car (fps" + (pt ? "" : ", stock") + ")";
			tiles.in = st.in_fps.toFixed(1);
			tiles.kbps = String(Math.round(st.kbps));
		}
		var markers = d.markers || [], build = d.build || (st && st.build) || "";
		var disabled = build && markers.indexOf(build) >= 0;
		if (st) {
			tiles.fb = String(st.fallbacks);
			rows.push(["Car requested", st.car.indexOf("0x0") === 0 ? "unknown" : st.car]);
			rows.push(["Phone stream", st.phone.indexOf("0x0") === 0 ? "unknown" : st.phone]);
			rows.push(["Last fallback", st.last_fallback ?
				st.last_fallback + " (" + ago(now - (st.up_ms - (st.t_ms - st.last_fallback_t_ms))) + ")" : "None"]);
		}
		rows.push(["Auto-disabled", disabled ? "Yes, until a new build is installed" : "No"]);
		if (ln) rows.push(["Last event", ln.event + " (" + ago(now - ln.up_ms) + ")"]);
		if (st) rows.push(["Updated", ago(now - st.up_ms)]);
		return {mode: mode[0], tone: mode[1], rows: rows, tiles: tiles, autoDisabled: !!disabled};
	}

	if (typeof module !== "undefined" && module.exports) {
		module.exports = {SETTINGS: SETTINGS, KEYS: KEYS, allowed: allowed, parseFile: parseFile, view: view};
		return;
	}

	/* ---- DOM ---- */
	var $ = function (id) { return document.getElementById(id); };
	var values = {}, saving = false, presetsMem = [], toastTimer = null;
	function toast(t, bad) {
		var el = $("toast"); el.textContent = t; el.className = bad ? "bad" : "";
		clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.textContent = ""; }, bad ? 6000 : 3500);
	}
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
		if (root.CPFW && (root.CPFW.busy() || root.CPFW.installing())) return "Firmware update in progress";
		if (root.CPDiag && root.CPDiag.busy()) return "Debug ZIP in progress";
		if (saving) return "Saving...";
		return null;
	}

	/* ---- confirm sheet ---- */
	var sheetDone = null;
	function sheet(title, items, okText, opt) {
		opt = opt || {};
		$("sh-title").textContent = title;
		var ul = $("sh-list"); ul.textContent = "";
		(items || []).forEach(function (t) { var li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
		var inp = $("sh-input"); inp.hidden = !opt.input; inp.value = ""; inp.placeholder = opt.input || "";
		$("sh-yes").textContent = okText || "OK";
		$("sh-yes").className = "btn " + (opt.danger ? "danger" : "go");
		$("sheet").hidden = false;
		if (opt.input) inp.focus();
		return new Promise(function (r) { sheetDone = r; });
	}
	function closeSheet(ok) {
		$("sheet").hidden = true;
		var r = sheetDone; sheetDone = null;
		if (r) r(ok ? ($("sh-input").hidden ? true : $("sh-input").value.trim()) : false);
	}

	/* ---- settings ---- */
	async function readSettings() {
		try {
			var d = JSON.parse(await get("/cgi-bin/cpthru_settings.cgi", 20000));
			values = d.values || {};
			if (!d.ok) toast("Some settings could not be read", true);
		} catch (e) { toast("Couldn't read settings", true); }
		renderSettings(); renderPresets();
	}
	async function setOne(key, value) {
		try {
			var d = JSON.parse(await get("/cgi-bin/cpthru_set.cgi?key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(value), 10000));
			if (d.ok && d.value === String(value)) { values[key] = d.value; return null; }
			return d.error || "not saved";
		} catch (e) { return "adapter not reachable"; }
	}
	/* Writes pairs one by one; returns {done: [labels], bad: [label: error], when}. */
	async function saveMany(pairs) {
		saving = true; renderSettings();
		var bad = [], done = [], when = {};
		for (var i = 0; i < pairs.length; i++) {
			var st = byKey(pairs[i][0]), err = await setOne(pairs[i][0], pairs[i][1]);
			if (err) bad.push(st.label + ": " + err); else { done.push(st.label); when[st.hint] = 1; }
		}
		saving = false;
		await readSettings();
		return {done: done, bad: bad, when: Object.keys(when)};
	}
	function rowState(key, text, tone) {
		var el = document.querySelector('[data-state="' + key + '"]');
		if (el) { el.textContent = text; el.className = "state" + (tone ? " " + tone : ""); }
	}
	async function change(s, value) {
		var why = blocked();
		if (why) { toast(why, true); renderSettings(); return; }
		rowState(s.key, "...", "");
		var r = await saveMany([[s.key, value]]);
		if (r.bad.length) { rowState(s.key, "!", "bad"); toast("Not saved: " + r.bad[0], true); }
		else { rowState(s.key, "✓", "ok"); toast("Saved · " + s.hint.toLowerCase()); setTimeout(function () { rowState(s.key, ""); }, 2500); }
	}
	function shown(s) { var v = values[s.key]; return v === "" || v === undefined ? s.def : v; }
	function renderSettings() {
		SETTINGS.forEach(function (s) {
			var row = document.getElementById("st-" + s.key);
			if (!row) {
				row = document.createElement("div"); row.className = "row"; row.id = "st-" + s.key;
				var name = document.createElement("div"); name.className = "name";
				name.innerHTML = "<span></span><small></small>";
				name.firstChild.textContent = s.label; name.lastChild.textContent = s.hint;
				var ctl = document.createElement("div"); ctl.className = "ctl";
				var state = document.createElement("span"); state.className = "state"; state.setAttribute("data-state", s.key);
				ctl.appendChild(state);
				if (s.type === "toggle") {
					var lab = document.createElement("label"); lab.className = "sw";
					lab.innerHTML = '<input type="checkbox" role="switch"><span></span>';
					lab.firstChild.setAttribute("aria-label", s.label);
					lab.firstChild.onchange = function () { change(s, this.checked ? s.on : s.off); };
					ctl.appendChild(lab);
				} else {
					var sel = document.createElement("select"); sel.setAttribute("aria-label", s.label);
					var unset = document.createElement("option"); unset.value = ""; unset.textContent = "Default"; unset.disabled = true;
					sel.appendChild(unset);
					s.opts.forEach(function (o) { var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
					sel.onchange = function () { if (this.value) change(s, this.value); };
					ctl.appendChild(sel);
				}
				row.appendChild(name); row.appendChild(ctl);
				$("set-" + s.group).appendChild(row);
			}
			var v = shown(s), known = values[s.key] !== undefined;
			if (s.type === "toggle") {
				var cb = row.querySelector("input"); cb.checked = v === s.on; cb.disabled = saving || !known;
			} else {
				var se = row.querySelector("select"); se.value = v === null ? "" : v; se.disabled = saving || !known;
			}
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
	/* Saved settings as explicit values; unset ones as their known default.
	 * Settings with no known default are left out and listed in `omitted`. */
	function snapshotSettings() {
		var o = {}, omitted = [];
		SETTINGS.forEach(function (st) {
			var v = values[st.key];
			if (v !== undefined && v !== "") o[st.key] = v;
			else if (v === "" && st.def !== null) o[st.key] = st.def;
			else omitted.push(st.label);
		});
		return {settings: o, omitted: omitted};
	}
	function label(k, v) {
		var st = byKey(k), o = st && st.opts.filter(function (x) { return x[0] === v; })[0];
		return o ? o[1] : "default";
	}
	function diffOf(p) {
		return Object.keys(p.settings).filter(function (k) {
			return allowed(k, p.settings[k]) && values[k] !== p.settings[k] && !(values[k] === "" && byKey(k).def === p.settings[k]);
		}).map(function (k) { return {key: k, from: values[k], to: p.settings[k]}; });
	}
	function renderPresets() {
		var sel = $("preset-sel"), list = loadPresets(), cur = sel.value;
		sel.textContent = "";
		if (!list.length) { var o = document.createElement("option"); o.value = ""; o.textContent = "None saved"; sel.appendChild(o); }
		list.forEach(function (p, i) { var op = document.createElement("option"); op.value = String(i); op.textContent = p.name; sel.appendChild(op); });
		if (cur && +cur < list.length) sel.value = cur;
		$("preset-apply").disabled = $("preset-del").disabled = !list.length;
	}
	function addPresets(add) {
		var list = loadPresets();
		add.forEach(function (p) {
			var name = p.name, n = 2;
			while (list.some(function (q) { return q.name === name; })) name = p.name + " (" + n++ + ")";
			list.push({name: name, settings: p.settings});
		});
		return savePresets(list.slice(-20));
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
			$("mode").textContent = "Offline"; $("mode").className = "pill warn";
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
		} catch (e) { /* unknown */ }
		try { rel = JSON.parse(await get("/cpthru-release.json")); } catch (e) { rel = null; }
		var ver = rel ? rel.version : "unknown";
		$("ident").textContent = ver + " · " + (kv.system_version || "");
		$("fw-now").textContent = ver;
		tb.textContent = "";
		[["Release", rel ? rel.version + " (" + rel.release_id + ")" : "unknown"], ["Shim", rel ? rel.shim_build : "unknown"],
			["System", kv.system_version], ["Product", kv.product_Model], ["Platform", (kv.platform || "?") + " / " + (kv.custom || "?")],
			["Serial", kv.uuid], ["Car", [kv.get_manufacturer, kv.get_model, kv.get_srcVersion].filter(Boolean).join(" ")],
			["Activated", kv.isActivate === "1" ? "Yes" : kv.isActivate ? "No (needs stock firmware)" : "unknown"]
		].forEach(function (r) { tr(tb, r[0], r[1] || "unknown"); });
	}

	/* ---- tabs ---- */
	function showTab() {
		var t = (location.hash || "#status").slice(1);
		if (!document.getElementById("tab-" + t)) t = "status";
		["status", "settings", "update", "tools"].forEach(function (n) {
			$("tab-" + n).hidden = n !== t;
			document.querySelector('[data-tab="' + n + '"]').setAttribute("aria-selected", n === t ? "true" : "false");
		});
	}

	async function confirmAndSave(title, pairs, okText) {
		var why = blocked();
		if (why) { toast(why, true); return; }
		if (!(await sheet(title, pairs.map(function (p) { return byKey(p[0]).label + ": " + label(p[0], p[1]); }), okText))) return;
		var r = await saveMany(pairs);
		toast(r.bad.length ? "Not saved: " + r.bad.join(", ") : "Saved · " + r.when.join(", ").toLowerCase(), !!r.bad.length);
	}

	function start() {
		window.addEventListener("hashchange", showTab); showTab();
		$("sh-yes").onclick = function () { closeSheet(true); };
		$("sh-no").onclick = function () { closeSheet(false); };
		$("sheet").onclick = function (e) { if (e.target === this) closeSheet(false); };
		renderSettings(); renderPresets();

		$("rc-stock").onclick = function () { confirmAndSave("Switch to stock video processing?", [["persist.cpthru.off", "1"]], "Switch"); };
		$("rc-reset").onclick = function () {
			confirmAndSave("Reset project settings?", [["persist.cpthru.off", "0"], ["persist.suding.wl.audio.latency", "0"]], "Reset");
		};
		$("rc-factory").onclick = async function () {
			if (blocked()) { toast(blocked(), true); return; }
			if (!(await sheet("Factory reset?", ["Clears stock settings and paired phones", "The adapter restarts"], "Reset", {danger: true}))) return;
			saving = true;
			try {
				var t = await get("/cgi-bin/factoryreset.cgi?wifi_channel=36&delayTimer=0&", 15000);
				if (/refused/.test(t)) { saving = false; toast("Refused: " + t.replace(/^[\s\S]*refused: /, "").replace(/ \(fail\)\s*$/, ""), true); return; }
			} catch (e) { /* the adapter restarts and may drop the reply */ }
			toast("Restarting... reconnect in about a minute");
		};
		$("preset-apply").onclick = async function () {
			var why = blocked();
			if (why) { toast(why, true); return; }
			var p = loadPresets()[+$("preset-sel").value];
			if (!p) return;
			var d = diffOf(p);
			if (!d.length) { toast("Already matches “" + p.name + "”"); return; }
			if (!(await sheet("Apply “" + p.name + "”?", d.map(function (x) {
				return byKey(x.key).label + ": " + label(x.key, x.from) + " → " + label(x.key, x.to);
			}), "Apply"))) return;
			var again = diffOf(p);
			if (JSON.stringify(again) !== JSON.stringify(d)) { toast("Settings changed; review again", true); return; }
			var r = await saveMany(d.map(function (x) { return [x.key, x.to]; }));
			toast(r.bad.length ? "Not saved: " + r.bad.join(", ") : "Applied · " + r.when.join(", ").toLowerCase(), !!r.bad.length);
		};
		$("preset-save").onclick = async function () {
			var snap = snapshotSettings();
			if (!Object.keys(snap.settings).length) { toast("Settings not loaded", true); return; }
			var name = await sheet("Save preset", snap.omitted.length ? ["Not included: " + snap.omitted.join(", ")] : [], "Save", {input: "Name"});
			if (!name) return;
			var ok = addPresets([{name: name.slice(0, 40), settings: snap.settings}]);
			renderPresets(); $("preset-sel").value = String(loadPresets().length - 1);
			toast(ok ? "Saved “" + name + "”" : "Saved for this visit only (Safari storage off)", !ok);
		};
		$("preset-del").onclick = async function () {
			var i = +$("preset-sel").value, list = loadPresets(), p = list[i];
			if (!p || !(await sheet("Delete “" + p.name + "”?", [], "Delete", {danger: true}))) return;
			list.splice(i, 1); savePresets(list); renderPresets(); toast("Deleted");
		};
		$("cfg-export").onclick = function () {
			var d = {format: "carlinkit-ultra6-settings", schema: 1, exported: new Date().toISOString(),
				current: snapshotSettings().settings, presets: loadPresets()};
			var a = $("cfg-dl"), url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], {type: "application/json"}));
			a.href = url; a.download = "carlinkit-settings-" + d.exported.slice(0, 10) + ".json"; a.click();
			setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
		};
		$("cfg-import").onchange = async function () {
			var f = this.files && this.files[0];
			this.value = "";
			if (!f) return;
			if (f.size > 65536) { toast("Not a settings file", true); return; }
			var r = parseFile(await f.text());
			if (!r.presets.length) { toast("Nothing imported: " + (r.errors[0] || "no valid settings"), true); return; }
			addPresets(r.presets); renderPresets();
			toast("Imported " + r.presets.length + " preset" + (r.presets.length > 1 ? "s" : "") +
				(r.errors.length ? " · skipped " + r.errors.join(", ") : ""), !!r.errors.length);
		};
		if (/ndroid/.test(navigator.userAgent)) {
			var row = document.createElement("div"); row.className = "row";
			row.innerHTML = '<div class="name">Android Auto P2P</div><button type="button" class="btn small">Switch</button>';
			row.querySelector("button").onclick = async function () {
				if (blocked()) { toast(blocked(), true); return; }
				if (!(await sheet("Switch to P2P?", [], "Switch"))) return;
				get("/cgi-bin/switch_p2p.cgi").then(function () { toast("Switched to P2P"); }, function () { toast("Sent; connection may drop"); });
			};
			$("set-conn").appendChild(row);
		}
		if (root.CPFW) root.CPFW.mount($("fw-panel"), {
			builtin: true,
			busyOthers: function () {
				if (root.CPDiag && root.CPDiag.busy()) return "Wait for the debug ZIP";
				if (saving) return "Wait for settings to save";
				return null;
			},
			onBusy: function () { renderSettings(); }
		});
		else $("fw-panel").textContent = "Updater failed to load.";
		readSettings();
		device();
		refresh();
		setInterval(refresh, 2000);
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})(typeof window !== "undefined" ? window : this);
