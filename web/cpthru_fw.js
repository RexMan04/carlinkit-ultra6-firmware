/* Firmware updater for the Carlinkit Mini Ultra 6 project page (and, bundled
 * into the first-install bookmark, for the stock or older pages).
 *
 * Choose an SWU -> phone-side check (archive structure, per-part checksums,
 * stock 202610121756C base parts, identity) -> upload with the stock 10 KiB
 * protocol, verified by the adapter's own MD5 check -> a separate, explicit
 * Install firmware button -> reconnect watcher that reports what the adapter
 * runs afterwards. Upload success is never reported as installed.
 *
 * On project firmware (0.2+) installs go through /cgi-bin/cpthru_update.cgi,
 * which locks, re-checks the staged copy and starts the stock installer once
 * per boot. Pure parts are exported for node tests. */
(function (root) {
	"use strict";
	/* ---- MD5 and SHA-256, incremental, on Uint8Array (no crypto.subtle on http) ---- */
	function Hasher(block, init, out) {
		var st = init.slice(), buf = new Uint8Array(64), used = 0, total = 0;
		var w = new Int32Array(64), view = new DataView(buf.buffer);
		this.update = function (b) {
			var i = 0, n = b.length;
			total += n;
			if (used) {
				var k = Math.min(64 - used, n);
				buf.set(b.subarray(0, k), used); used += k; i = k;
				if (used < 64) return this;
				block(st, view, 0, w); used = 0;
			}
			var bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
			for (; i + 64 <= n; i += 64) block(st, bv, i, w);
			if (i < n) { buf.set(b.subarray(i), 0); used = n - i; }
			return this;
		};
		this.hex = function () {
			var bits = total * 8, pad = new Uint8Array((used < 56 ? 56 : 120) - used + 8);
			pad[0] = 0x80;
			var pv = new DataView(pad.buffer), L = pad.length;
			out(pv, L, bits);
			this.update(pad);
			return st;
		};
	}
	var MD5S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21], MD5K = [];
	for (var i0 = 0; i0 < 64; i0++) MD5K[i0] = (Math.abs(Math.sin(i0 + 1)) * 4294967296) | 0;
	function md5block(s, v, o, x) {
		for (var j = 0; j < 16; j++) x[j] = v.getInt32(o + j * 4, true);
		var a = s[0], b = s[1], c = s[2], d = s[3], f, g, t;
		for (var i = 0; i < 64; i++) {
			if (i < 16) { f = (b & c) | (~b & d); g = i; }
			else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
			else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
			else { f = c ^ (b | ~d); g = (7 * i) & 15; }
			t = d; d = c; c = b;
			var r = MD5S[(i >> 4) * 4 + (i & 3)], y = (a + f + MD5K[i] + x[g]) | 0;
			b = (b + ((y << r) | (y >>> (32 - r)))) | 0;
			a = t;
		}
		s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
	}
	var SHAK = [];
	(function () {
		var n = 2, k = 0;
		function frac(x) { return ((x - Math.floor(x)) * 4294967296) | 0; }
		while (k < 64) {
			var p = true;
			for (var q = 2; q * q <= n; q++) if (n % q === 0) { p = false; break; }
			if (p) SHAK[k++] = frac(Math.cbrt(n));
			n++;
		}
	})();
	function shablock(s, v, o, w) {
		for (var j = 0; j < 16; j++) w[j] = v.getInt32(o + j * 4, false);
		for (j = 16; j < 64; j++) {
			var a1 = w[j - 15], b1 = w[j - 2];
			var s0 = ((a1 >>> 7) | (a1 << 25)) ^ ((a1 >>> 18) | (a1 << 14)) ^ (a1 >>> 3);
			var s1 = ((b1 >>> 17) | (b1 << 15)) ^ ((b1 >>> 19) | (b1 << 13)) ^ (b1 >>> 10);
			w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
		}
		var a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
		for (j = 0; j < 64; j++) {
			var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			var t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHAK[j] + w[j]) | 0;
			var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
		s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0; s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
	}
	function hex32(x, le) {
		var s = "";
		for (var i = 0; i < 4; i++) {
			var byte = le ? (x >>> (8 * i)) & 255 : (x >>> (24 - 8 * i)) & 255;
			s += (byte < 16 ? "0" : "") + byte.toString(16);
		}
		return s;
	}
	function md5() {
		var h = new Hasher(md5block, [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476], function (pv, L, bits) {
			pv.setUint32(L - 8, bits >>> 0, true); pv.setUint32(L - 4, Math.floor(bits / 4294967296), true);
		});
		var fin = h.hex;
		h.hex = function () { return fin.call(h).map(function (x) { return hex32(x, true); }).join(""); };
		return h;
	}
	function sha256() {
		var h = new Hasher(shablock, [0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0,
			0x1f83d9ab, 0x5be0cd19], function (pv, L, bits) {
			pv.setUint32(L - 8, Math.floor(bits / 4294967296), false); pv.setUint32(L - 4, bits >>> 0, false);
		});
		var fin = h.hex;
		h.hex = function () { return fin.call(h).map(function (x) { return hex32(x, false); }).join(""); };
		return h;
	}

	/* ---- firmware image check ---- */
	var STOCK = {
		size: 27578368, md5: "8cda8cf273d665c80b2a4b217b9bdf44",
		sha256: "6e56e9a7952b7c39081258d9be37cbc0ba81801596da2018bc373ea9d404b30a",
		order: ["sw-description", "recovery", "kernel", "rootfs", "cpio_item_md5"], rootfsMax: 18219008,
		items: {"sw-description": "82efef568f247fb60bc4560b96c7f7cf", recovery: "80c8c7d96692af826621cdd4f05c1a3c",
			kernel: "79254fa379047c9cd4e020e12ddd76d9"}
	};
	/* Whole images identified by SHA-256, each with the staged name it was
	 * proven with. Project builds from 0.2 on carry a release manifest and are
	 * always staged as PROJECT_NAME: a file never chooses its own name. */
	var KNOWN = [
		{sha256: STOCK.sha256, kind: "stock", name: "v5_202610121756_STOCK_rollback.swu",
			label: "Stock firmware 202610121756C (rollback)"},
		{sha256: "c406489a8653a851597b0ec9109abda73a9fffd8b71a910b88d8e8ba5c218ade", kind: "legacy", shim: "32a85e24338a",
			name: "v5_202610121756_passthru.swu", label: "Original pass-through test (shim 32a85e24338a)"},
		{sha256: "dac8c1a57f9f948885f164e1224936b767ec5486974c73b3b2bcc5dfcea44d3b", kind: "legacy", shim: "1b93a4b1163f",
			name: "v5_202610121756_passthru_diag.swu", label: "Diagnostics test 0.1.0-diagnostics.1 (shim 1b93a4b1163f)"}
	];
	var PROJECT_NAME = "cpthru.swu";
	var NAMES = [PROJECT_NAME].concat(KNOWN.map(function (k) { return k.name; }));
	var MAGIC = "CPTHRU-RELEASE\n", SLICE = 1048576;

	function ascii(b, s, e) { var t = ""; for (var i = s; i < e; i++) t += String.fromCharCode(b[i]); return t; }
	function zeros(b, s, e) { for (var i = s; i < e; i++) if (b[i]) return false; return true; }
	function u32le(b, o) { return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0; }
	function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

	/* SVR4 "crc" cpio (070702) headers -> [{name, start, size, check}] */
	function cpioItems(b) {
		var i = 0, items = [];
		for (;;) {
			if (i + 110 > b.length) throw Error("The file ends inside an archive header.");
			var h = ascii(b, i, i + 110);
			if (h.slice(0, 6) !== "070702") throw Error("Not an SWU firmware archive (bad header at byte " + i + ").");
			var f = [];
			for (var k = 0; k < 13; k++) {
				var x = h.slice(6 + 8 * k, 14 + 8 * k);
				if (!/^[0-9A-Fa-f]{8}$/.test(x)) throw Error("Damaged archive header.");
				f.push(parseInt(x, 16));
			}
			var nsz = f[11], size = f[6];
			if (nsz < 2 || nsz > 64 || i + 110 + nsz > b.length) throw Error("Damaged archive entry name.");
			var name = ascii(b, i + 110, i + 110 + nsz - 1);
			if (b[i + 110 + nsz - 1] !== 0) throw Error("Damaged archive entry name.");
			var start = (i + 110 + nsz + 3) & ~3;
			if (name === "TRAILER!!!") return {items: items, end: start};
			if (start + size > b.length) throw Error("The file is truncated (" + name + ").");
			items.push({name: name, start: start, size: size, check: f[12]});
			i = (start + size + 3) & ~3;
			if (items.length > 16) throw Error("Too many archive entries.");
		}
	}

	function manifestAt(rootfs) {
		if (ascii(rootfs, 0, 4) !== "hsqs") return {error: "The rootfs is not a squashfs image."};
		var used = u32le(rootfs, 40);
		if (u32le(rootfs, 44) !== 0 || used < 96 || used > rootfs.length) return {error: "The rootfs size field is invalid."};
		var at = Math.ceil(used / 4096) * 4096;
		if (!zeros(rootfs, used, Math.min(at, rootfs.length))) return {error: "Unexpected data after the rootfs."};
		if (at + MAGIC.length > rootfs.length || ascii(rootfs, at, at + MAGIC.length) !== MAGIC) {
			return zeros(rootfs, used, rootfs.length) ? {none: true} : {error: "Unexpected data after the rootfs."};
		}
		var s = at + MAGIC.length, e = s;
		while (e < rootfs.length && e < s + 4096 && rootfs[e] !== 10) e++;
		if (rootfs[e] !== 10) return {error: "The release manifest is damaged."};
		if (!zeros(rootfs, e + 1, rootfs.length)) return {error: "Unexpected data after the release manifest."};
		var m;
		try { m = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(rootfs.subarray(s, e))); }
		catch (x) { return {error: "The release manifest is not valid JSON."}; }
		if (!m || m.format !== "carlinkit-ultra6-release" || m.schema !== 1 || m.base !== "v5_202610121756" ||
			typeof m.version !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(m.version) ||
			typeof m.release_id !== "string" || !/^[0-9a-f]{12}$/.test(m.release_id) ||
			typeof m.shim_build !== "string" || !/^[0-9a-f]{12}$/.test(m.shim_build) ||
			typeof m.label !== "string" || m.label.length > 80)
			return {error: "The release manifest is not for this adapter or is incomplete."};
		return {manifest: m};
	}

	/* bytes -> image report. Checks the archive structure, every entry's
	 * checksum and MD5, that the base parts match the stock base this project
	 * supports, and what the image is. Checksums prove the file is intact and
	 * built on that base; they do not prove who made it. */
	async function analyze(b, progress) {
		progress = progress || function () {};
		var r = {size: b.length};
		if (b.length < 4096 || b.length > 33554432) return fail("Wrong size for this adapter's firmware (" + b.length + " bytes).");
		var cp;
		try { cp = cpioItems(b); } catch (e) { return fail(e.message); }
		if (!zeros(b, cp.end, b.length) || b.length - cp.end > 1024) return fail("Unexpected data after the archive.");
		var names = cp.items.map(function (x) { return x.name; });
		if (names.join(",") !== STOCK.order.join(",")) return fail("Unexpected archive contents: " + names.join(", ") + ".");
		var whole = md5(), strong = sha256(), done = 0, total = b.length * 2;
		for (var o = 0; o < b.length; o += SLICE) {
			var part = b.subarray(o, o + SLICE);
			whole.update(part); strong.update(part);
			done += part.length; progress(done / total, "Checking file"); await tick();
		}
		r.md5 = whole.hex(); r.sha256 = strong.hex();
		var item = {};
		for (var n = 0; n < cp.items.length; n++) {
			var it = cp.items[n], h = md5(), sum = 0;
			for (o = it.start; o < it.start + it.size; o += SLICE) {
				var p = b.subarray(o, Math.min(o + SLICE, it.start + it.size));
				h.update(p);
				for (var q = 0; q < p.length; q++) sum += p[q];
				sum %= 4294967296;
				done += p.length; progress(done / total, "Checking file"); await tick();
			}
			if (sum !== it.check) return fail("The " + it.name + " part is damaged (archive checksum).");
			item[it.name] = {md5: h.hex(), bytes: b.subarray(it.start, it.start + it.size)};
		}
		var listed = {}, lines = ascii(item.cpio_item_md5.bytes, 0, item.cpio_item_md5.bytes.length).split("\n");
		lines.forEach(function (l) { var m = /^([0-9a-f]{32}) {2}([a-z_-]+)$/.exec(l); if (m) listed[m[2]] = m[1]; });
		for (n = 0; n < 4; n++) {
			var nm = STOCK.order[n];
			if (listed[nm] !== item[nm].md5) return fail("The " + nm + " part does not match the image's own MD5 list.");
		}
		for (nm in STOCK.items) {
			if (item[nm].md5 !== STOCK.items[nm])
				return fail("The " + nm + " part differs from stock 202610121756C. This image is for another model or base firmware.");
		}
		var rootfs = item.rootfs.bytes;
		if (rootfs.length > STOCK.rootfsMax) return fail("The rootfs is larger than the stock partition image.");
		var known = KNOWN.filter(function (k) { return k.sha256 === r.sha256; })[0];
		var mf = manifestAt(rootfs);
		if (known) {
			r.kind = known.kind; r.label = known.label; r.name = known.name; r.shim = known.shim || null;
		} else if (mf.manifest) {
			var m = mf.manifest;
			r.kind = "project"; r.name = PROJECT_NAME; r.label = m.label; r.version = m.version;
			r.release_id = m.release_id; r.shim = m.shim_build;
		} else {
			return fail(mf.error || "The rootfs differs from stock but has no project release manifest, so it is not a known build.");
		}
		r.ok = true;
		progress(1, "Checked");
		return r;
		function fail(msg) { r.ok = false; r.error = msg; return r; }
	}

	/* ---- upload: the stock protocol, exactly (10 KiB, sequential, no retry) ---- */
	async function upload(b, info, progress) {
		var total = Math.ceil(b.length / 10240), started = Date.now(), state = {sent: false};
		if (NAMES.indexOf(info.name) < 0) throw Error("Refused: unexpected staged name.");
		try {
			for (var chunk = 0; chunk < total; chunk++) {
				var last = chunk === total - 1;
				var suffix = chunk === 0 ? ".0" : last ? ":" + info.md5 + ".2" : ".1";
				var form = new FormData();
				form.append("chunk", new Blob([b.subarray(chunk * 10240, (chunk + 1) * 10240)],
					{type: "application/octet-stream"}), info.name + suffix);
				progress(chunk / total, "Uploading " + (chunk + 1) + "/" + total + ", " +
					Math.round((Date.now() - started) / 1000) + " s");
				var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 30000), text;
				try {
					state.sent = true;
					var res = await fetch("/cgi-bin/downfile.cgi", {method: "POST", body: form, redirect: "error", signal: ctl.signal});
					if (res.status !== 200) throw Error("Upload HTTP " + res.status + ".");
					text = await res.text();
				} finally { clearTimeout(timer); }
				var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); });
				var exact = function (l) { return lines.filter(function (v) { return v === l; }).length === 1; };
				if (/fail|invalid|could not|error|no valid|refused/i.test(text) ||
					!exact("write data------success") ||
					!exact("result is /mnt/UDISK/swupdate/" + info.name) ||
					lines.filter(function (l) { return l.indexOf("result is ") === 0; }).length !== 1 ||
					(last && (!exact("file check success") || !exact("md5_str is " + info.md5))) ||
					(!last && lines.some(function (l) { return l.indexOf("file check ") === 0; }))) {
					var why = /refused[^\n]*/i.exec(text);
					throw Error(why ? why[0] : "The adapter rejected the transfer or checksum. Storage may be full.");
				}
			}
			progress(1, "Uploaded and verified");
		} catch (e) {
			e.sent = state.sent;
			throw e;
		}
	}

	/* ---- install request and reconnect watcher ---- */
	var GATEWAY = "/cgi-bin/cpthru_update.cgi", PENDING = "cpthru.pendingInstall";
	function store(k, v) {
		try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
	}
	function load(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
	async function get(url, ms, asText) {
		var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, ms);
		try {
			var r = await fetch(url + (url.indexOf("?") < 0 ? "?" : "&") + "_=" + Date.now(),
				{cache: "no-store", redirect: "error", signal: ctl.signal});
			var t = await r.text();
			return {status: r.status, text: t, json: asText ? null : (function () { try { return JSON.parse(t); } catch (e) { return null; } })()};
		} finally { clearTimeout(timer); }
	}
	async function gatewayState() {
		try { var r = await get(GATEWAY + "?op=state", 8000); return r.status === 200 && r.json && r.json.ok ? r.json : null; }
		catch (e) { return null; }
	}
	/* What the adapter runs now. Project releases are recognised only by a
	 * fresh release file; a shim ID alone is never treated as a release match. */
	async function running() {
		var v = await get("/cgi-bin/getversion.cgi", 4000, true);
		if (v.status !== 200) throw Error("no response");
		var sys = (/system_version:([^\n]*)/.exec(v.text) || [])[1] || "unknown";
		var out = {system: sys.trim(), release: null, shim: null};
		try {
			var rel = await get("/cpthru-release.json", 4000);
			if (rel.status === 200 && rel.json && rel.json.format === "carlinkit-ultra6-release") out.release = rel.json;
		} catch (e) { /* older build */ }
		if (!out.release) {
			try {
				var st = await get("/cgi-bin/cpthru_status.cgi", 6000);
				if (st.status === 200 && st.json) out.shim = st.json.build || (st.json.status && st.json.status.build) || null;
			} catch (e) { /* stock */ }
		}
		return out;
	}
	function describe(now, want) {
		var what = now.release ? "project release " + now.release.version + " (release ID " + now.release.release_id + ")" :
			now.shim ? "an older project build without a release file (shim " + now.shim + ")" :
			"stock firmware (no project files found)";
		var match = null;
		if (want) {
			if (want.kind === "project") match = !!(now.release && now.release.release_id === want.release_id);
			else if (want.kind === "stock") match = !now.release && !now.shim;
			else if (want.kind === "legacy") match = !now.release && now.shim === want.shim ? true : (now.release ? false : null);
		}
		return {text: "The adapter reports " + what + ", system version " + now.system + ".", match: match};
	}

	/* ---- UI ---- */
	var CSS = ".fw{display:grid;gap:12px;min-width:0}.fw>*{min-width:0}.fw .fw-pick{display:grid;gap:6px;font-weight:600}.fw table{width:100%;border-collapse:collapse;font-size:14px}" +
		".fw th{text-align:left;font-weight:500;color:var(--muted,#555);padding:4px 8px 4px 0;vertical-align:top;width:38%}" +
		".fw td{padding:4px 0;overflow-wrap:anywhere}.fw progress{width:100%;height:14px}" +
		".fw .fw-btn{display:block;width:100%;padding:14px;font:inherit;font-size:17px;font-weight:700;border-radius:8px;" +
		"border:2px solid var(--line,#111);background:var(--bg,#fff);color:var(--fg,#111);box-shadow:3px 3px 0 var(--shadow,#111);" +
		"height:auto;line-height:1.3;white-space:normal;cursor:pointer;text-align:center}" +
		".fw .fw-btn.go{background:var(--accent,#111);color:var(--on-accent,#fff)}" +
		".fw .fw-btn.danger{background:var(--warn-soft,#ffe6d5);border-color:var(--warn,#9a3412);color:var(--warn,#9a3412)}" +
		".fw .fw-btn:disabled{opacity:.45;cursor:default;box-shadow:none}.fw .fw-btn[hidden],.fw [hidden]{display:none}" +
		".fw input[type=file]{width:100%;max-width:100%;min-width:0;font-size:15px}.fw .fw-msg{margin:0;font-weight:600}" +
		".fw .fw-msg.bad{color:var(--bad,#b91c1c)}.fw .fw-msg.ok{color:var(--ok,#166534)}.fw .fw-note{margin:0;font-size:13px;color:var(--muted,#555)}";

	var busy = false, installed = false, ctxRef = null;
	function mount(el, ctx) {
		ctx = ctxRef = ctx || {};
		if (!document.getElementById("fw-css")) {
			var st = document.createElement("style"); st.id = "fw-css"; st.textContent = CSS; document.head.appendChild(st);
		}
		el.classList.add("fw");
		el.innerHTML =
			'<label class="fw-pick">Firmware file (.swu) <input type="file" class="fw-file"></label>' +
			'<table hidden class="fw-info"><tbody></tbody></table>' +
			'<progress class="fw-bar" max="1" value="0" hidden></progress>' +
			'<p class="fw-msg" role="status">Choose an SWU saved in Files. Nothing is sent until you tap Upload.</p>' +
			'<button type="button" class="fw-btn go fw-up" disabled>Upload and verify</button>' +
			'<button type="button" class="fw-btn fw-reuse" hidden>Use the copy already on the adapter</button>' +
			'<button type="button" class="fw-btn danger fw-inst" hidden>Install firmware</button>' +
			'<p class="fw-note fw-help">Keep Safari open on this page during upload and install. Upload only copies and checks the file; ' +
			'nothing changes until you tap Install firmware. Turn off Low Power Mode and set Auto-Lock to Never while updating.</p>';
		var q = function (c) { return el.querySelector("." + c); };
		var input = q("fw-file"), info = q("fw-info"), bar = q("fw-bar"), msg = q("fw-msg"),
			up = q("fw-up"), reuse = q("fw-reuse"), inst = q("fw-inst");
		var bytes = null, rep = null, verified = false, attempted = false, staged = [], armed = false, gw = null;

		function say(t, tone) { msg.textContent = t; msg.className = "fw-msg" + (tone ? " " + tone : ""); }
		function setBusy(b) { busy = b; if (ctx.onBusy) ctx.onBusy(b); }
		function rows(list) {
			var tb = info.tBodies[0]; tb.textContent = "";
			list.forEach(function (r) {
				var tr = document.createElement("tr"), th = document.createElement("th"), td = document.createElement("td");
				th.textContent = r[0]; td.textContent = r[1]; tr.appendChild(th); tr.appendChild(td); tb.appendChild(tr);
			});
			info.hidden = !list.length;
		}
		function prog(f, t) { bar.hidden = false; bar.value = f; if (t) say(t); }
		function lock(all) {
			input.disabled = all; up.disabled = true; reuse.hidden = true; inst.hidden = true;
		}
		function other() { return ctx.busyOthers ? ctx.busyOthers() : null; }

		input.onchange = async function () {
			if (busy || installed) return;
			var why = other();
			if (why) { say("Not checked: " + why, "bad"); input.value = ""; return; }
			bytes = rep = null; verified = false; attempted = false; rows([]); lock(false);
			var file = input.files && input.files[0];
			if (!file) { say("Choose an SWU saved in Files."); return; }
			setBusy(true); input.disabled = true;
			try {
				say("Reading " + file.name + "...");
				bytes = new Uint8Array(await file.arrayBuffer());
				rep = await analyze(bytes, prog);
			} catch (e) {
				rep = {ok: false, error: "Could not read the file: " + (e.message || e)};
			} finally { setBusy(false); input.disabled = false; bar.hidden = true; }
			var list = [["File", file.name], ["Size", (rep.size / 1048576).toFixed(2) + " MiB (" + rep.size + " bytes)"]];
			if (rep.ok) {
				list.push(["Identified as", rep.label]);
				if (rep.version) list.push(["Version", rep.version], ["Release ID", rep.release_id]);
				if (rep.shim) list.push(["Shim build", rep.shim]);
				list.push(["Model/base check", "Passed: Mini Ultra 6, stock 202610121756C base"], ["Staged as", rep.name]);
			}
			if (rep.sha256) list.push(["SHA-256", rep.sha256], ["MD5", rep.md5]);
			rows(list);
			if (!rep.ok) { say("Not accepted: " + rep.error, "bad"); bytes = null; return; }
			say(rep.kind === "stock" ? "Valid stock firmware. Installing it removes this page and all project features; " +
				"stock rollback has not been tested on an adapter yet." : "Valid image. Tap Upload and verify.", rep.kind === "stock" ? "bad" : "ok");
			up.disabled = false;
			var copy = staged.filter(function (s) { return s.name === rep.name && s.size === rep.size; })[0];
			reuse.hidden = !(gw && copy);
		};

		up.onclick = async function () {
			if (!rep || !rep.ok || busy || attempted || installed) return;
			var why = other();
			if (why) { say("Not started: " + why, "bad"); return; }
			attempted = true; setBusy(true); lock(true);
			try {
				await upload(bytes, rep, prog);
				verified = true;
				say("Uploaded and verified: the adapter's copy matches (MD5 " + rep.md5 + "). NOT installed yet.", "ok");
				inst.hidden = false; inst.disabled = false;
			} catch (e) {
				say((e.sent ? "Upload stopped. The adapter's staged copy is incomplete; do not install it. " : "Nothing uploaded. ") +
					e.message + " Tap Upload again to restart from the beginning.", "bad");
				attempted = false; up.disabled = false; up.textContent = "Upload again";
			} finally { setBusy(false); input.disabled = false; bar.hidden = true; refreshStaged(); }
		};

		reuse.onclick = async function () {
			if (!rep || !rep.ok || busy || installed || !gw) return;
			var why = other();
			if (why) { say("Not checked: " + why, "bad"); return; }
			setBusy(true); lock(true); say("Asking the adapter to checksum its staged copy...");
			try {
				var r = await get(GATEWAY + "?op=verify&name=" + encodeURIComponent(rep.name) + "&size=" + rep.size, 90000);
				if (r.json && r.json.ok && r.json.md5 === rep.md5 && r.json.size === rep.size) {
					verified = true;
					say("The adapter's staged copy matches this file (MD5 " + rep.md5 + "). NOT installed yet.", "ok");
					inst.hidden = false; inst.disabled = false;
				} else {
					say("The adapter's staged copy does not match" + (r.json && r.json.error ? " (" + r.json.error + ")" : "") +
						". Upload the file instead.", "bad");
					up.disabled = false;
				}
			} catch (e) { say("Could not check the staged copy: " + e.message + ". Upload the file instead.", "bad"); up.disabled = false; }
			finally { setBusy(false); input.disabled = false; }
		};

		inst.onclick = async function () {
			if (!verified || installed || busy) return;
			var why = other();
			if (why) { say("Not started: " + why, "bad"); return; }
			if (!armed) {
				armed = true; inst.textContent = "Tap again to install " + rep.label;
				setTimeout(function () { if (armed && !installed) { armed = false; inst.textContent = "Install firmware"; } }, 5000);
				return;
			}
			installed = true; setBusy(true); lock(true); input.disabled = true;
			var want = {kind: rep.kind, label: rep.label, release_id: rep.release_id || null, shim: rep.shim || null,
				name: rep.name, md5: rep.md5, t: Date.now()};
			say("Sending the install request...");
			if (gw) {
				var r = null;
				try { r = await get(GATEWAY + "?op=install&name=" + encodeURIComponent(rep.name) + "&size=" + rep.size + "&md5=" + rep.md5, 120000); }
				catch (e) { r = null; }
				if (r && r.json && r.json.ok === false && r.json.phase === "rejected") {
					installed = false; setBusy(false); armed = false; inst.textContent = "Install firmware";
					say("Install refused before anything started: " + r.json.error + ". Nothing was changed.", "bad");
					verified = false; up.disabled = false; up.textContent = "Upload again"; input.disabled = false;
					return;
				}
				if (!(r && r.json && r.json.ok)) {
					store(PENDING, want);
					say("The adapter's answer to the install request was lost, so it may or may not be installing. " +
						"Do not tap anything; this page keeps watching.", "bad");
					return watch(want);
				}
			} else {
				/* First install from the bookmark on stock or older firmware: one stock request. */
				fetch("/cgi-bin/submition.cgi?filename=" + rep.name + "&", {cache: "no-store"}).catch(function () {});
			}
			store(PENDING, want);
			watch(want);
		};

		async function refreshStaged() {
			if (!gw) return;
			var s = await gatewayState();
			staged = s && Array.isArray(s.staged) ? s.staged : [];
		}

		var watching = false;
		async function watch(want) {
			if (watching) return;
			watching = true; installed = true; setBusy(true); lock(true); input.disabled = true;
			var t0 = want.t || Date.now(), down = false, okRun = 0, lastNote = "";
			say("Installing " + want.label + ". Keep the adapter powered and this page open. It restarts on its own, " +
				"possibly more than once.", "bad");
			for (;;) {
				var secs = Math.round((Date.now() - t0) / 1000), now = null;
				try { now = await running(); } catch (e) { now = null; }
				if (!now) {
					down = true; okRun = 0;
					say("Adapter restarting or busy (" + secs + " s since the install request). Keep power on. " +
						"If Safari loses the Wi-Fi, rejoin the adapter's hotspot; this page reconnects by itself." +
						(secs > 600 ? " It has been over 10 minutes: keep power on and wait; do not unplug." : ""), "bad");
				} else if (!down) {
					var s = gw ? await gatewayState() : null;
					var log = s && s.log && s.log.length ? " Installer: " + s.log[s.log.length - 1] : "";
					if (log !== lastNote) lastNote = log;
					say("Install requested " + secs + " s ago; the adapter has not restarted yet." + lastNote, "bad");
				} else if (++okRun >= 2) {
					var d = describe(now, want);
					say((d.match === true ? "Done: the adapter is back and runs what you installed. " :
						d.match === false ? "The adapter is back, but it does not report what you installed. " :
						"The adapter is back. ") + d.text +
						(now.release ? "" : " Reload the page to see its own settings page."), d.match === false ? "bad" : "ok");
					store(PENDING, null);
					if (okRun >= 20) break;
				}
				await new Promise(function (r) { setTimeout(r, 3000); });
			}
			watching = false; setBusy(false);
		}

		(async function init() {
			gw = await gatewayState();
			if (gw) staged = gw.staged || [];
			var want = load(PENDING);
			if (gw && gw.phase === "install-started") {
				return watch(want || {kind: "unknown", label: "the staged firmware", t: Date.now()});
			}
			if (want && Date.now() - want.t < 3600000) {
				try {
					var d = describe(await running(), want);
					say("Last install request (" + want.label + "): " + (d.match === true ? "the adapter now runs it. " :
						d.match === false ? "the adapter does NOT report it. " : "") + d.text, d.match === false ? "bad" : "ok");
				} catch (e) { /* offline */ }
				store(PENDING, null);
			}
		})();
	}

	var api = {md5: md5, sha256: sha256, analyze: analyze, cpioItems: cpioItems, manifestAt: manifestAt, upload: upload,
		describe: describe, STOCK: STOCK, KNOWN: KNOWN, NAMES: NAMES, PROJECT_NAME: PROJECT_NAME, MAGIC: MAGIC};
	if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
	api.mount = mount;
	api.busy = function () { return busy; };
	api.installing = function () { return installed; };
	root.CPFW = api;
})(typeof window !== "undefined" ? window : this);
