#!/bin/sh
# Status for /cpthru.html and the diagnostics panel: the shim's status,
# connection and timing files plus the two settings it controls
# (WEBUI_PLAN.md, NEXT_TEST_PLAN.md A). Read-only.
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
# getprop waits on the property service; bound each read (busybox here has no
# timeout applet). The watchdog's output goes to /dev/null so it never holds
# this CGI's output open. Prints the digits of the value; returns non-zero if
# getprop failed or was killed by the watchdog.
prop() {
	v=$( { getprop "$1" 2>/dev/null & p=$!; { sleep 2; kill "$p"; } </dev/null >/dev/null 2>&1 & w=$!; wait "$p"; r=$?; kill "$w" 2>/dev/null; exit "$r"; } )
	r=$?
	printf '%s' "$v" | tr -cd '0-9'
	[ "$r" -eq 0 ]
}
props_ok=true
st=$(cat /tmp/cpthru.status 2>/dev/null)
ln=$(cat /tmp/cpthru.link 2>/dev/null)
now=$(awk '{printf "%d", $1 * 1000}' /proc/uptime)
off=$(prop persist.cpthru.off) || props_ok=false
lat=$(prop persist.suding.wl.audio.latency) || props_ok=false
build=$(cat /tmp/cpthru.build 2>/dev/null | tr -cd 'a-z0-9')
markers=$(ls /mnt/UDISK/ 2>/dev/null | awk '/^cpthru\.fail\./ { id = substr($0, 13); gsub(/[^a-z0-9]/, "", id); printf "%s\"%s\"", (n++ ? "," : ""), id }')
# Timing: the shim writes one bounded JSON object atomically. Accept only that
# (size, prefix, character set, and a full JSON syntax check by
# cpthru_json.awk); anything else becomes null with a reason, so a bad file
# never breaks the whole response. (The adapter's busybox has no wc.)
tm=; terr=missing
jsonawk=${0%/*}/cpthru_json.awk
[ -f "$jsonawk" ] || jsonawk=/etc/shttpd/cgi-bin/cpthru_json.awk
if [ -f /tmp/cpthru.timing ]; then
	sz=$(ls -ln /tmp/cpthru.timing 2>/dev/null | awk 'NR == 1 && $5 ~ /^[0-9]+$/ { print $5 }')
	if [ -z "$sz" ]; then
		terr=unreadable
	elif [ "$sz" -gt 98304 ]; then
		terr=oversize
	elif [ ! -f "$jsonawk" ]; then
		terr=unvalidated
	else
		tm=$(cat /tmp/cpthru.timing 2>/dev/null)
		terr=malformed
		case "$tm" in
		'{"v":1,'*'}')
			if [ -z "$(printf '%s' "$tm" | tr -d 'A-Za-z0-9{}\133\135":,._ -')" ] &&
			   [ "$(printf '%s\n' "$tm" | awk -f "$jsonawk")" = ok ]; then
				terr=
			fi ;;
		esac
		[ -n "$terr" ] && tm=
	fi
fi
te=null
[ -n "$terr" ] && te="\"$terr\""
echo "{\"now_ms\":${now:-0},\"build\":\"$build\",\"markers\":[$markers],\"status\":${st:-null},\"link\":${ln:-null},\"settings\":{\"off\":\"$off\",\"latency\":\"$lat\"},\"props_ok\":$props_ok,\"timing\":${tm:-null},\"timing_error\":$te}"
