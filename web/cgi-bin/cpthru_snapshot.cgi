#!/bin/sh
# Read-only system snapshot and debug-ZIP preflight for the diagnostics panel
# (NEXT_TEST_PLAN.md B). Takes about one second: /proc/stat and sdDongle's
# per-thread CPU counters are sampled twice, one second apart, so the page
# gets a real CPU measurement. Ignores the query string. Never writes, never
# runs the vendor log exporter, never dumps all properties or environment.
# Every value is sanitized to a fixed character set; anything that can't be
# read is null and listed in "missing".
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
miss=
addmiss() { miss="$miss${miss:+,}\"$1\""; }
now() { awk '{printf "%.0f", $1 * 1000}' /proc/uptime 2>/dev/null; }
t0=$(now)

# Bounded property read (same watchdog idea as cpthru_set.cgi; the watchdog's
# output goes to /dev/null so it never holds this CGI's output open).
prop() {
	v=$( { getprop "$1" 2>/dev/null & p=$!; { sleep 2; kill "$p"; } </dev/null >/dev/null 2>&1 & w=$!; wait "$p"; r=$?; kill "$w" 2>/dev/null; exit "$r"; } )
	r=$?
	printf '%s' "$v" | tr -cd 'A-Za-z0-9._-' | cut -c1-64
	[ "$r" -eq 0 ]
}
# Allowlisted saved settings only; "" means unset, null means unreadable.
props= nosave=null
for k in persist.cpthru.off persist.suding.wl.audio.latency persist.console.log.nosave persist.console.log.index; do
	if v=$(prop "$k"); then
		v="\"$v\""
	else
		v=null
		addmiss "prop:$k"
	fi
	props="$props${props:+,}\"$k\":$v"
	[ "$k" = persist.console.log.nosave ] && nosave=$v
done

cfg=$(awk -F= '$1 == "platform" || $1 == "custom" || $1 == "version" { v = $2; gsub(/[^A-Za-z0-9._-]/, "", v); if (!($1 in seen)) { seen[$1] = 1; printf "%s\"%s\":\"%s\"", (n++ ? "," : ""), $1, substr(v, 1, 64) } }' /etc/config.ini 2>/dev/null)
if [ -n "$cfg" ]; then cfg="{$cfg}"; else cfg=null; addmiss config; fi
build=$(cat /tmp/cpthru.build 2>/dev/null | tr -cd 'a-z0-9' | cut -c1-32)
[ -n "$build" ] || addmiss build

# Storage: free space where minizip writes its ZIP, and the log directory it
# compresses. busybox df may wrap a long device name onto its own line.
free=$(df -k /mnt/UDISK 2>/dev/null | awk 'NR > 1 { if (NF >= 6) a = $4; else if (NF == 5) a = $3 } END { if (a ~ /^[0-9]+$/) printf "%.0f", a * 1024 }')
[ -n "$free" ] || { free=null; addmiss udisk_free; }
logb=$(du -sk /mnt/UDISK/log 2>/dev/null | awk 'NR == 1 && $1 ~ /^[0-9]+$/ { printf "%.0f", $1 * 1024 }')
[ -n "$logb" ] || { logb=null; addmiss log_dir; }
if [ -e /mnt/UDISK/local.zip ]; then
	left=true
	leftb=$(ls -ln /mnt/UDISK/local.zip 2>/dev/null | awk 'NR == 1 && $5 ~ /^[0-9]+$/ { print $5 }')
	[ -n "$leftb" ] || leftb=null
else
	left=false leftb=null
fi

mem=$(awk '/^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):/ { k = $1; sub(/:$/, "", k); printf "%s\"%s\":%.0f", (n++ ? "," : ""), k, $2 }' /proc/meminfo 2>/dev/null)
if [ -n "$mem" ]; then mem="{$mem}"; else mem=null; addmiss meminfo; fi
load=$(awk '{ printf "[%.2f,%.2f,%.2f]", $1, $2, $3 }' /proc/loadavg 2>/dev/null)
[ -n "$load" ] || { load=null; addmiss loadavg; }

pid=
for d in /proc/[0-9]*; do
	c=
	read -r c 2>/dev/null < "$d/comm"
	if [ "$c" = sdDongle ]; then pid=${d#/proc/}; break; fi
done

# One sample: uptime, CPU lines, network counters, sdDongle identity and
# per-thread CPU ticks. Thread names may hold spaces/parens: the name is
# between the first "(" and the last ")".
statawk='{ l = $0; o = index(l, "("); for (c = length(l); c > o; c--) if (substr(l, c, 1) == ")") break
	if (!o || c <= o) next
	name = substr(l, o + 1, c - o - 1); gsub(/[^A-Za-z0-9_.:-]/, "_", name)
	id = substr(l, 1, o - 2); n = split(substr(l, c + 2), f, " ")
	if (n < 20 || id !~ /^[0-9]+$/ || f[20] !~ /^[0-9]+$/) next
	if (mode == "P") printf "P %s %s\n", id, f[20]; else if (++k <= 64) printf "T %s %s %s %s\n", id, f[12], f[13], substr(name, 1, 32) }'
sample() {
	awk '{ printf "U %.0f\n", $1 * 100 }' /proc/uptime 2>/dev/null
	awk '/^cpu/ && ++k <= 16 { printf "C %s %.0f %.0f %.0f %.0f %.0f %.0f %.0f\n", $1, $2, $3, $4, $5, $6, $7, $8 }' /proc/stat 2>/dev/null
	awk 'NR > 2 && ++k <= 16 { i = index($0, ":"); if (!i) next; n = substr($0, 1, i - 1); gsub(/[^A-Za-z0-9_.-]/, "", n); $0 = substr($0, i + 1); printf "N %s %.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f\n", n, $1, $2, $3, $4, $9, $10, $11, $12 }' /proc/net/dev 2>/dev/null
	if [ -n "$pid" ]; then
		awk -v mode=P "$statawk" "/proc/$pid/stat" 2>/dev/null
		cat /proc/"$pid"/task/*/stat 2>/dev/null | awk -v mode=T "$statawk"
	fi
}
s1=$(sample)
sleep 1
s2=$(sample)
t1=$(now)
cpu=$(printf 'S 1\n%s\nS 2\n%s\n' "$s1" "$s2" | awk -v pid="$pid" '
$1 == "S" { s = $2; next }
$1 == "U" { up[s] = $2; next }
$1 == "C" { if (!($2 in cn)) { cn[$2] = ++nc; cname[nc] = $2 } k = cn[$2]; for (i = 3; i <= 9; i++) cv[s, k, i - 2] = $i; have_c[s, k] = 1; next }
$1 == "N" { if (!($2 in nn)) { nn[$2] = ++ni; nname[ni] = $2 } k = nn[$2]; for (i = 3; i <= 10; i++) nv[s, k, i - 2] = $i; have_n[s, k] = 1; next }
$1 == "P" { pp[s] = $2; ps[s] = $3; next }
$1 == "T" { if (!($2 in tn)) { tn[$2] = ++nt; tid[nt] = $2 } k = tn[$2]; tu[s, k] = $3; ts[s, k] = $4; tname[k] = $5; have_t[s, k] = 1; next }
END {
	printf "\"sample_up_cs\":[%s,%s],\"cpu\":[", (1 in up) ? up[1] : "null", (2 in up) ? up[2] : "null"
	m = 0
	for (k = 1; k <= nc; k++) {
		if (!((1, k) in have_c) || !((2, k) in have_c)) continue
		tot = 0
		for (i = 1; i <= 7; i++) { d[i] = cv[2, k, i] - cv[1, k, i]; tot += d[i] }
		printf "%s{\"name\":\"%s\",\"total\":%.0f,\"user\":%.0f,\"nice\":%.0f,\"system\":%.0f,\"idle\":%.0f,\"iowait\":%.0f,\"irq\":%.0f,\"softirq\":%.0f}", (m++ ? "," : ""), cname[k], tot, d[1], d[2], d[3], d[4], d[5], d[6], d[7]
	}
	printf "],\"net\":["
	m = 0
	for (k = 1; k <= ni; k++) {
		if (!((1, k) in have_n) || !((2, k) in have_n)) continue
		printf "%s{\"if\":\"%s\",\"rx_bytes\":%.0f,\"rx_packets\":%.0f,\"rx_errs\":%.0f,\"rx_drop\":%.0f,\"tx_bytes\":%.0f,\"tx_packets\":%.0f,\"tx_errs\":%.0f,\"tx_drop\":%.0f,\"delta\":{\"rx_bytes\":%.0f,\"tx_bytes\":%.0f,\"rx_drop\":%.0f,\"tx_drop\":%.0f}}", (m++ ? "," : ""), nname[k], nv[2, k, 1], nv[2, k, 2], nv[2, k, 3], nv[2, k, 4], nv[2, k, 5], nv[2, k, 6], nv[2, k, 7], nv[2, k, 8], nv[2, k, 1] - nv[1, k, 1], nv[2, k, 5] - nv[1, k, 5], nv[2, k, 4] - nv[1, k, 4], nv[2, k, 8] - nv[1, k, 8]
	}
	printf "],\"sdDongle\":"
	if (pid == "" || !(1 in pp)) { printf "null"; exit }
	same = (2 in pp) && pp[1] == pp[2] && ps[1] == ps[2]
	printf "{\"pid\":%s,\"starttime\":%s,\"same_process\":%s,\"threads_seen\":%d,\"threads\":[", pp[1], ps[1], same ? "true" : "false", nt
	m = 0
	if (same) for (k = 1; k <= nt; k++) {
		if (!((1, k) in have_t) || !((2, k) in have_t)) continue
		printf "%s{\"tid\":%s,\"name\":\"%s\",\"utime\":%.0f,\"stime\":%.0f}", (m++ ? "," : ""), tid[k], tname[k], tu[2, k] - tu[1, k], ts[2, k] - ts[1, k]
	}
	printf "]}"
}')
[ -n "$cpu" ] || cpu='"sample_up_cs":[null,null],"cpu":[],"net":[],"sdDongle":null'
[ -n "$pid" ] || addmiss sdDongle
case "$cpu" in *'"same_process":false'*) addmiss sdDongle_restarted ;; esac
echo "{\"v\":1,\"t0_ms\":${t0:-null},\"t1_ms\":${t1:-null},\"build\":\"$build\",\"config\":$cfg,\"props\":{$props},\"nosave\":$nosave,\"udisk\":{\"free_bytes\":$free,\"log_bytes\":$logb,\"leftover_zip\":$left,\"leftover_zip_bytes\":$leftb},\"mem_kb\":$mem,\"loadavg\":$load,\"ticks_note\":\"cpu and thread values are clock ticks over the 1 s sample\",$cpu,\"missing\":[$miss]}"
