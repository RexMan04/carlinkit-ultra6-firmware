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
		var total = Math.ceil(b.length / 10240), state = {sent: false};
		if (NAMES.indexOf(info.name) < 0) throw Error("Refused: unexpected staged name.");
		try {
			for (var chunk = 0; chunk < total; chunk++) {
				var last = chunk === total - 1;
				var suffix = chunk === 0 ? ".0" : last ? ":" + info.md5 + ".2" : ".1";
				var form = new FormData();
				form.append("chunk", new Blob([b.subarray(chunk * 10240, (chunk + 1) * 10240)],
					{type: "application/octet-stream"}), info.name + suffix);
				progress(chunk / total, "Uploading " + (chunk + 1) + "/" + total + " \u00b7 " + Math.round(chunk / total * 100) + "%");
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
	/* {kind: "ok", state} | {kind: "absent"} (404: firmware without the
	 * gateway) | {kind: "unavailable"} (timeout, other errors). Only "absent"
	 * may ever lead to the stock install request. */
	async function gateway() {
		try {
			var r = await get(GATEWAY + "?op=state", 8000);
			if (r.status === 200 && r.json && r.json.ok) return {kind: "ok", state: r.json};
			if (r.status === 404) return {kind: "absent"};
		} catch (e) { /* unavailable */ }
		return {kind: "unavailable"};
	}
	async function gatewayState() { var g = await gateway(); return g.kind === "ok" ? g.state : null; }
	/* What the adapter runs now. Each part is "valid", "absent" (HTTP 404) or
	 * "unknown" (timeout, other status, unparsable), never guessed. Project
	 * releases are recognised only by a fresh release file; a shim ID alone is
	 * never treated as a release match. */
	async function running() {
		var v = await get("/cgi-bin/getversion.cgi", 4000, true);
		if (v.status !== 200) throw Error("no response");
		var sys = (/system_version:([^\n]*)/.exec(v.text) || [])[1] || "unknown";
		var out = {system: sys.trim(), release: null, releaseState: "unknown", shim: null, shimState: "unknown", uptime: null};
		try {
			var rel = await get("/cpthru-release.json", 4000);
			if (rel.status === 404) out.releaseState = "absent";
			else if (rel.status === 200 && rel.json && rel.json.format === "carlinkit-ultra6-release" &&
				/^[0-9a-f]{12}$/.test(rel.json.release_id || "")) { out.release = rel.json; out.releaseState = "valid"; }
		} catch (e) { /* unknown */ }
		try {
			var st = await get("/cgi-bin/cpthru_status.cgi", 6000);
			if (st.status === 404) out.shimState = "absent";
			else if (st.status === 200 && st.json) {
				out.shim = st.json.build || (st.json.status && st.json.status.build) || null;
				out.shimState = out.shim ? "valid" : "absent";
				if (typeof st.json.now_ms === "number") out.uptime = st.json.now_ms;
			}
		} catch (e) { /* unknown */ }
		return out;
	}
	function describe(now, want) {
		var what = now.releaseState === "valid" ? now.release.version + " (" + now.release.release_id + ")" :
			now.releaseState === "absent" && now.shimState === "valid" ? "older build (shim " + now.shim + ")" :
			now.releaseState === "absent" && now.shimState === "absent" ? "stock firmware" : "unidentified firmware";
		var match = null;
		if (want && want.kind === "project") {
			if (now.releaseState === "valid") match = now.release.release_id === want.release_id;
			else if (now.releaseState === "absent") match = false;
		} else if (want && want.kind === "stock") {
			if (now.releaseState === "valid" || now.shimState === "valid") match = false;
			else if (now.releaseState === "absent" && now.shimState === "absent") match = true;
		} else if (want && want.kind === "legacy") {
			if (now.releaseState === "valid") match = false;
			else if (now.releaseState === "absent" && now.shimState === "valid") match = now.shim === want.shim;
			else if (now.releaseState === "absent" && now.shimState === "absent") match = false;
		}
		return {text: what, match: match};
	}
	function sameIdentity(a, b) {
		return !!(a && b && a.releaseState === b.releaseState && a.shimState === b.shimState &&
			(a.release && a.release.release_id) === (b.release && b.release.release_id) && a.shim === b.shim);
	}

	/* ---- UI ---- */
	var CSS = ".fw{display:grid;gap:12px;min-width:0}.fw>*{min-width:0}" +
		".fw .fw-row{display:flex;align-items:center;gap:12px;min-width:0}" +
		".fw .fw-pick{position:relative;overflow:hidden;flex:none}" +
		".fw .fw-pick input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}" +
		".fw .fw-fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted,#666)}" +
		".fw .fw-id b{display:block;font-size:17px}.fw .fw-id span{color:var(--muted,#666);font-size:14px}" +
		".fw details{font-size:13px}.fw summary{cursor:pointer;color:var(--muted,#666)}" +
		".fw table{width:100%;border-collapse:collapse;margin-top:6px}" +
		".fw th{text-align:left;font-weight:500;color:var(--muted,#666);padding:3px 8px 3px 0;vertical-align:top;width:30%}" +
		".fw td{padding:3px 0;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace;font-size:12px}" +
		".fw progress{width:100%;height:6px;appearance:none;-webkit-appearance:none;border:0;border-radius:3px;background:var(--hair,#e5e5e5)}" +
		".fw progress::-webkit-progress-bar{background:var(--hair,#e5e5e5);border-radius:3px}" +
		".fw progress::-webkit-progress-value{background:var(--accent,#0a84ff);border-radius:3px}" +
		".fw .fw-btn{display:block;width:100%;padding:13px;font:inherit;font-size:16px;font-weight:600;border-radius:12px;border:0;" +
		"background:var(--fill,#eee);color:var(--fg,#111);cursor:pointer;text-align:center;line-height:1.2}" +
		".fw .fw-btn.go{background:var(--accent,#0a84ff);color:var(--on-accent,#fff)}" +
		".fw .fw-btn.danger{background:var(--bad,#d70015);color:#fff}" +
		".fw .fw-btn.small{display:inline-block;width:auto;padding:8px 14px;font-size:15px}" +
		".fw .fw-btn:disabled{opacity:.4;cursor:default}.fw [hidden]{display:none!important}" +
		".fw .fw-msg{margin:0;font-size:15px}.fw .fw-msg:empty{display:none}" +
		".fw .fw-msg.bad{color:var(--bad,#d70015)}.fw .fw-msg.ok{color:var(--ok,#248a3d)}" +
		".fw .fw-confirm{display:grid;gap:10px;padding:12px;border-radius:12px;background:var(--fill,#eee)}" +
		".fw .fw-confirm p{margin:0;font-weight:600}.fw .fw-confirm div{display:grid;grid-template-columns:1fr 1fr;gap:10px}";

	var busy = false, installed = false;
	function mount(el, ctx) {
		ctx = ctx || {};
		if (!document.getElementById("fw-css")) {
			var st = document.createElement("style"); st.id = "fw-css"; st.textContent = CSS; document.head.appendChild(st);
		}
		el.classList.add("fw");
		el.innerHTML =
			'<div class="fw-row"><label class="fw-btn small fw-pick">Choose file<input type="file" class="fw-file" aria-label="Firmware file"></label>' +
			'<span class="fw-fname">No file selected</span></div>' +
			'<div class="fw-id" hidden><b></b><span></span></div>' +
			'<details class="fw-more" hidden><summary>Details</summary><table class="fw-info"><tbody></tbody></table></details>' +
			'<progress class="fw-bar" max="1" value="0" hidden></progress>' +
			'<p class="fw-msg" role="status"></p>' +
			'<button type="button" class="fw-btn go fw-up" disabled>Upload</button>' +
			'<button type="button" class="fw-btn fw-reuse" hidden>Use copy on adapter</button>' +
			'<button type="button" class="fw-btn go fw-inst" hidden>Install</button>' +
			'<div class="fw-confirm" hidden><p></p><div><button type="button" class="fw-btn fw-no">Cancel</button>' +
			'<button type="button" class="fw-btn danger fw-yes">Install</button></div></div>';
		var q = function (c) { return el.querySelector("." + c); };
		var input = q("fw-file"), fname = q("fw-fname"), idb = q("fw-id"), more = q("fw-more"), info = q("fw-info"),
			bar = q("fw-bar"), msg = q("fw-msg"), up = q("fw-up"), reuse = q("fw-reuse"), inst = q("fw-inst"),
			confirmBox = q("fw-confirm"), yes = q("fw-yes"), no = q("fw-no");
		var bytes = null, rep = null, verified = false, attempted = false, staged = [], gw = null;

		function say(t, tone) { msg.textContent = t || ""; msg.className = "fw-msg" + (tone ? " " + tone : ""); }
		function setBusy(b) { busy = b; if (ctx.onBusy) ctx.onBusy(b); }
		function rows(list) {
			var tb = info.tBodies[0]; tb.textContent = "";
			list.forEach(function (r) {
				var tr = document.createElement("tr"), th = document.createElement("th"), td = document.createElement("td");
				th.textContent = r[0]; td.textContent = r[1]; tr.appendChild(th); tr.appendChild(td); tb.appendChild(tr);
			});
			more.hidden = !list.length;
		}
		function prog(f, t) { bar.hidden = false; bar.value = f; if (t) say(t + " " + Math.round(f * 100) + "%"); }
		function lock(all) { input.disabled = all; up.disabled = true; reuse.hidden = true; inst.hidden = true; confirmBox.hidden = true; }
		function other() { return ctx.busyOthers ? ctx.busyOthers() : null; }

		input.onchange = async function () {
			if (busy || installed) return;
			var why = other();
			if (why) { say(why, "bad"); input.value = ""; return; }
			bytes = rep = null; verified = false; attempted = false; rows([]); lock(false); idb.hidden = true;
			up.textContent = "Upload"; up.hidden = false;
			var file = input.files && input.files[0];
			fname.textContent = file ? file.name : "No file selected";
			if (!file) { say(""); return; }
			setBusy(true); input.disabled = true;
			try {
				say("Checking...");
				bytes = new Uint8Array(await file.arrayBuffer());
				rep = await analyze(bytes, function (f) { prog(f, "Checking"); });
			} catch (e) {
				rep = {ok: false, error: "Could not read the file: " + (e.message || e)};
			} finally { setBusy(false); input.disabled = false; bar.hidden = true; }
			var list = [["Size", rep.size + " bytes"]];
			if (rep.ok) {
				if (rep.release_id) list.push(["Release ID", rep.release_id]);
				if (rep.shim) list.push(["Shim", rep.shim]);
				list.push(["Base", "202610121756C (checked)"], ["Staged as", rep.name]);
			}
			if (rep.sha256) list.push(["SHA-256", rep.sha256], ["MD5", rep.md5]);
			rows(list);
			if (!rep.ok) { say("Not accepted: " + rep.error, "bad"); bytes = null; return; }
			idb.hidden = false;
			idb.querySelector("b").textContent = rep.kind === "stock" ? "Stock firmware" : rep.version ? rep.version : rep.label;
			idb.querySelector("span").textContent = rep.kind === "stock" ? "Rollback · removes project features · untested" :
				rep.kind === "legacy" ? rep.label : rep.label;
			say(rep.kind === "stock" ? "" : "Ready to upload", rep.kind === "stock" ? "" : "ok");
			up.disabled = false;
			var copy = staged.filter(function (s) { return s.name === rep.name && s.size === rep.size; })[0];
			reuse.hidden = !(gw && copy);
		};

		up.onclick = async function () {
			if (!rep || !rep.ok || busy || attempted || installed) return;
			var why = other();
			if (why) { say(why, "bad"); return; }
			attempted = true; setBusy(true); lock(true);
			try {
				await upload(bytes, rep, function (f, t) { bar.hidden = false; bar.value = f; say(t); });
				verified = true;
				say("Uploaded and verified · not installed", "ok");
				up.hidden = true; inst.hidden = false; inst.disabled = false;
			} catch (e) {
				say("Upload failed: " + e.message, "bad");
				attempted = false; up.disabled = false; up.textContent = "Upload again";
			} finally { setBusy(false); input.disabled = false; bar.hidden = true; refreshStaged(); }
		};

		reuse.onclick = async function () {
			if (!rep || !rep.ok || busy || installed || !gw) return;
			var why = other();
			if (why) { say(why, "bad"); return; }
			setBusy(true); lock(true); say("Checking adapter copy...");
			try {
				var r = await get(GATEWAY + "?op=verify&name=" + encodeURIComponent(rep.name) + "&size=" + rep.size, 90000);
				if (r.json && r.json.ok && r.json.md5 === rep.md5 && r.json.size === rep.size) {
					verified = true; say("Adapter copy verified · not installed", "ok");
					up.hidden = true; inst.hidden = false; inst.disabled = false;
				} else { say("Adapter copy doesn't match. Upload instead.", "bad"); up.disabled = false; up.hidden = false; }
			} catch (e) { say("Couldn't check the adapter copy. Upload instead.", "bad"); up.disabled = false; up.hidden = false; }
			finally { setBusy(false); input.disabled = false; }
		};

		inst.onclick = function () {
			if (!verified || installed || busy) return;
			var why = other();
			if (why) { say(why, "bad"); return; }
			confirmBox.querySelector("p").textContent = "Install " + (rep.kind === "stock" ? "stock firmware" : rep.version || rep.label) +
				"? The adapter will restart.";
			confirmBox.hidden = false; inst.hidden = true;
		};
		no.onclick = function () { confirmBox.hidden = true; inst.hidden = false; };
		yes.onclick = async function () {
			if (!verified || installed || busy) return;
			confirmBox.hidden = true;
			installed = true; setBusy(true); lock(true); input.disabled = true;
			function back(t) { installed = false; setBusy(false); verified = true; inst.hidden = false; inst.disabled = false; input.disabled = false; say(t, "bad"); }
			say("Preparing...");
			var g = await gateway();
			if (g.kind === "unavailable" || (ctx.builtin && g.kind !== "ok")) return back("Not installed: the adapter didn't answer. Try again.");
			var before = null;
			try { before = await running(); } catch (e) { before = null; }
			var want = {kind: rep.kind, label: rep.version || rep.label, release_id: rep.release_id || null, shim: rep.shim || null,
				name: rep.name, md5: rep.md5, t: Date.now(), before: before};
			if (g.kind === "ok") {
				var r = null;
				try { r = await get(GATEWAY + "?op=install&name=" + encodeURIComponent(rep.name) + "&size=" + rep.size + "&md5=" + rep.md5, 120000); }
				catch (e) { r = null; }
				if (r && r.json && r.json.ok === false && r.json.phase === "rejected") {
					verified = false; up.disabled = false; up.hidden = false; up.textContent = "Upload again";
					back("Install refused: " + r.json.error + ". Nothing changed.");
					inst.hidden = true;
					return;
				}
				if (!(r && r.json && r.json.ok)) {
					store(PENDING, want);
					say(r && r.json && r.json.phase === "install-started" ? "Install already in progress" : "No answer to the install request", "bad");
					return watch(want);
				}
			} else {
				/* Confirmed older firmware (no gateway, HTTP 404): one stock request.
				 * The stock installer answers only when it finishes or the adapter
				 * restarts, so only a quick explicit refusal counts as "not started". */
				var refused = await Promise.race([
					fetch("/cgi-bin/submition.cgi?filename=" + rep.name + "&", {cache: "no-store"})
						.then(function (x) { return x.text(); }).then(function (t) { return /refused/.test(t) ? t : null; }, function () { return null; }),
					new Promise(function (r) { setTimeout(function () { r(null); }, 3000); })
				]);
				if (refused) return back("Install refused by the adapter.");
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
		/* Done only when the adapter positively reports what was installed AND
		 * there is evidence it restarted: an observed outage, a changed
		 * identity, or a lower uptime. Unknown identity keeps the page waiting. */
		async function watch(want) {
			if (watching) return;
			watching = true; installed = true; setBusy(true); lock(true); input.disabled = true;
			var t0 = want.t || Date.now(), down = false, okRun = 0, before = want.before || null;
			say("Installing... keep power on", "bad");
			for (;;) {
				var secs = Math.round((Date.now() - t0) / 1000), now = null;
				var late = secs > 600 ? " · over 10 min, keep waiting" : "";
				try { now = await running(); } catch (e) { now = null; }
				if (!now) {
					down = true; okRun = 0;
					say("Restarting... " + secs + " s" + late, "bad");
				} else {
					var d = describe(now, want);
					var restarted = down || (before && !sameIdentity(before, now) && d.match === true) ||
						(before && before.uptime !== null && now.uptime !== null && now.uptime < before.uptime);
					if (d.match === true && restarted) {
						if (++okRun >= 2) {
							say("Installed " + d.text + (now.releaseState === "valid" ? "" : " · reload the page"), "ok");
							store(PENDING, null);
							if (okRun >= 20) break;
						}
					} else if (d.match === false && restarted) {
						okRun = 0; say("Back online, running " + d.text + late, "bad");
					} else if (restarted) {
						okRun = 0; say("Back online · identifying..." + late, "bad");
					} else {
						okRun = 0; say("Installing... " + secs + " s · keep power on" + late, "bad");
					}
				}
				await new Promise(function (r) { setTimeout(r, 3000); });
			}
			watching = false; setBusy(false);
		}

		(async function init() {
			var g = await gateway();
			gw = g.kind === "ok" ? g.state : null;
			if (gw) staged = gw.staged || [];
			var want = load(PENDING);
			if (gw && gw.phase === "install-started") return watch(want || {kind: "unknown", label: "firmware", t: Date.now()});
			if (want && Date.now() - want.t < 3600000) {
				try {
					var d = describe(await running(), want);
					if (d.match === null) { say("Last install: identifying... reload in a moment", "bad"); return; }
					say(d.match ? "Installed " + d.text : "Last install not running · now " + d.text, d.match ? "ok" : "bad");
					store(PENDING, null);
				} catch (e) { /* offline: keep the record */ }
			}
		})();
	}

	var api = {md5: md5, sha256: sha256, analyze: analyze, cpioItems: cpioItems, manifestAt: manifestAt, upload: upload,
		describe: describe, sameIdentity: sameIdentity, STOCK: STOCK, KNOWN: KNOWN, NAMES: NAMES, PROJECT_NAME: PROJECT_NAME, MAGIC: MAGIC};
	if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
	api.mount = mount;
	api.busy = function () { return busy; };
	api.installing = function () { return installed; };
	root.CPFW = api;
})(typeof window !== "undefined" ? window : this);
