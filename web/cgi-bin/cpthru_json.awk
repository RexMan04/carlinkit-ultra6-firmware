# Bounded timing JSON schema check for cpthru_status.cgi. POSIX/busybox awk.
# Keep number tokens as strings: awk doubles cannot compare uint64 limits.
function ws() { while (p <= n && index(" \t\r\n", substr(s, p, 1))) p++ }
function str(   c, start) {
	if (substr(s, p, 1) != "\"") return 0
	start = ++p
	for (; p <= n; p++) {
		c = substr(s, p, 1)
		if (c == "\"") { p++; token = substr(s, start, p - start - 1); return 1 }
		if (c == "\\" || c ~ /[[:cntrl:]]/) return 0
	}
	return 0
}
function num() {
	if (!match(substr(s, p, 64), /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/) || RLENGTH <= 0) return 0
	token = substr(s, p, RLENGTH); p += RLENGTH
	return 1
}
function val(d,   c, id) {
	if (d > 32 || nodes >= 4096) return 0
	id = ++nodes
	ws(); c = substr(s, p, 1)
	if (c == "{") return obj(d, id)
	if (c == "[") return arr(d, id)
	if (c == "\"") {
		if (!str()) return 0
		kind[id] = "string"; atom[id] = token; return id
	}
	if (substr(s, p, 4) == "null") { p += 4; kind[id] = "null"; return id }
	if (substr(s, p, 4) == "true") { p += 4; kind[id] = "boolean"; return id }
	if (substr(s, p, 5) == "false") { p += 5; kind[id] = "boolean"; return id }
	if (!num()) return 0
	kind[id] = "number"; atom[id] = token; return id
}
function obj(d, id,   c, key, child) {
	kind[id] = "object"; p++; ws()
	if (substr(s, p, 1) == "}") { p++; return id }
	for (;;) {
		ws()
		if (!str()) return 0
		key = token
		if ((id SUBSEP key) in member) return 0
		ws()
		if (substr(s, p, 1) != ":") return 0
		p++; child = val(d + 1)
		if (!child) return 0
		member[id, key] = child
		ws(); c = substr(s, p, 1); p++
		if (c == "}") return id
		if (c != ",") return 0
	}
}
function arr(d, id,   c, child) {
	kind[id] = "array"; p++; ws()
	if (substr(s, p, 1) == "]") { p++; return id }
	for (;;) {
		child = val(d + 1)
		if (!child) return 0
		count[id]++; member[id, count[id]] = child
		ws(); c = substr(s, p, 1); p++
		if (c == "]") return id
		if (c != ",") return 0
	}
}
function bounded(raw, limit,   left, right) {
	if (raw !~ /^(0|[1-9][0-9]*)$/) return 0
	if (length(raw) != length(limit)) return length(raw) < length(limit)
	left = "x" raw; right = "x" limit
	return left <= right
}
function uint(id, limit) { return kind[id] == "number" && bounded(atom[id], limit) }
function u32(id) { return uint(id, "4294967295") }
function eq(id, wanted) { return u32(id) && atom[id] == wanted }
function nullable_u32(id) { return kind[id] == "null" || u32(id) }
function nullable_i32(id,   raw) {
	if (kind[id] == "null") return 1
	if (kind[id] != "number") return 0
	raw = atom[id]
	if (substr(raw, 1, 1) == "-") return bounded(substr(raw, 2), "2147483648")
	return bounded(raw, "2147483647")
}
function uint_fields(id, names,   fields, total, i) {
	if (kind[id] != "object") return 0
	total = split(names, fields, " ")
	for (i = 1; i <= total; i++) if (!u32(member[id, fields[i]])) return 0
	return 1
}
function stat(id,   a, raw) {
	if (!uint_fields(id, "n max") || !uint(member[id, "sum"], "18446744073709551615")) return 0
	a = member[id, "avg"]; raw = atom[a]
	# The writer emits one fixed decimal digit, never exponent/NaN/Infinity.
	if (kind[a] != "number" || raw !~ /^(0|[1-9][0-9]*)\.[0-9]$/) return 0
	return bounded(substr(raw, 1, length(raw) - 2), "18446744073709551615")
}
function window(id,   fields, total, i) {
	if (!uint_fields(id, "seq gen t0 len_ms calls first v_ok v_fail v_gate c_ok c_fail c_gate slow16 slow33 slow100")) return 0
	total = split("cb iv gap lk par plk vsend csend orig res pub", fields, " ")
	for (i = 1; i <= total; i++) if (!stat(member[id, fields[i]])) return 0
	return 1
}
function info_record(id,   flag) {
	if (!uint_fields(id, "calls") || !nullable_u32(member[id, "last_mono_ms"]) ||
	    !nullable_i32(member[id, "stock"]) || !nullable_i32(member[id, "returned"])) return 0
	flag = member[id, "override"]
	return kind[flag] == "null" || eq(flag, 0) || eq(flag, 1)
}
function timing(id,   windows, field, fields, total, i, child) {
	if (!uint_fields(id, "gen seq") || !eq(member[id, "v"], 1) ||
	    !eq(member[id, "clock_res_ms"], 1) || !eq(member[id, "window_ms"], 5000) ||
	    !eq(member[id, "ring_max"], 24)) return 0
	child = member[id, "available"]
	if (!eq(child, 0) && !eq(child, 1)) return 0
	windows = member[id, "windows"]
	if (kind[windows] != "array" || count[windows] > 24) return 0
	if (eq(child, 0) && count[windows] != 0) return 0
	for (i = 1; i <= count[windows]; i++) if (!window(member[windows, i])) return 0
	# Only the platform-free C unit samples omit the production header.
	# The CGI never sets core_only, so every published metadata field is required.
	if (!core_only) {
		total = split("build up_ms mono_ms session_mono_ms stock_sent stock_suppressed info_source info", fields, " ")
		for (i = 1; i <= total; i++) if (!((id SUBSEP fields[i]) in member)) return 0
	}
	total = split("up_ms stock_sent stock_suppressed", fields, " ")
	for (i = 1; i <= total; i++) {
		field = fields[i]
		if ((id SUBSEP field) in member && !u32(member[id, field])) return 0
	}
	total = split("mono_ms session_mono_ms", fields, " ")
	for (i = 1; i <= total; i++) {
		field = fields[i]
		if ((id SUBSEP field) in member && !nullable_u32(member[id, field])) return 0
	}
	if ((id SUBSEP "build") in member && kind[member[id, "build"]] != "string") return 0
	if ((id SUBSEP "info_source") in member && kind[member[id, "info_source"]] != "string") return 0
	if ((id SUBSEP "info") in member) {
		child = member[id, "info"]
		if (kind[child] != "object" || !info_record(member[child, "VIDEO_WIDTH"]) ||
		    !info_record(member[child, "VIDEO_HEIGHT"]) || !info_record(member[child, "VIDEO_FPS"])) return 0
	}
	return 1
}
# Old busybox awk reads `s (expr)` as a function call; append in two steps.
{
	if (length(s) + length($0) + (NR > 1) > 98304) { oversized = 1; next }
	if (!oversized) { if (NR > 1) s = s "\n"; s = s $0 }
}
END {
	n = length(s); p = 1
	if (!oversized && n > 0) {
		root = val(0); ws()
		if (root && p > n && timing(root)) print "ok"
	}
}
