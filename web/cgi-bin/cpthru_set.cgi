#!/bin/sh
# Set one allowlisted setting: ?key=<name>&value=<digits> (WEBUI_PLAN.md).
# Keys are matched exactly and values must be one of that key's allowed
# values; nothing from the request reaches the shell unquoted.
set -f
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
fail() { echo "{\"ok\":false,\"error\":\"$1\"}"; exit 0; }
key=; value=
old_ifs=$IFS
IFS='&'
for kv in $QUERY_STRING; do
	case "$kv" in
	key=*) key=${kv#key=} ;;
	value=*) value=${kv#value=} ;;
	esac
done
IFS=$old_ifs
case "$key" in
persist.cpthru.off)
	case "$value" in 0|1) ;; *) fail "value must be 0 or 1" ;; esac ;;
persist.suding.wl.audio.latency)
	case "$value" in 0|300|400|500|600|700|800|900|1000) ;; *) fail "value must be 0 or 300-1000 in steps of 100" ;; esac ;;
*) fail "unknown setting" ;;
esac
# setprop waits on the property service; don't let a wedged service hang the
# page's request (busybox here has no timeout applet).
setprop "$key" "$value" &
sp=$!
(sleep 3; kill "$sp" 2>/dev/null) &
watchdog=$!
wait "$sp"
rc=$?
kill "$watchdog" 2>/dev/null
[ "$rc" -eq 0 ] || fail "setprop failed or timed out"
now=$(getprop "$key" | tr -cd '0-9')
echo "{\"ok\":true,\"key\":\"$key\",\"value\":\"$now\"}"
