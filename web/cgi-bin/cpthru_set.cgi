#!/bin/sh
# Set one allowlisted setting: ?key=<name>&value=<digits> (WEBUI_PLAN.md,
# MAINPAGE_PLAN.md).
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
# The stock page's settings (stock setprop.cgi / audioselect.cgi write these
# same properties with these same values).
persist.sys.carplay.audio.media.samplerate)
	case "$value" in 44100|48000) ;; *) fail "value must be 44100 or 48000" ;; esac ;;
persist.sys.boot.delay)
	case "$value" in 0|5|10|15|20|30|40|50|60) ;; *) fail "value must be one of the stock startup delays" ;; esac ;;
persist.sys.wifi.channel)
	case "$value" in 36|40|44|48|149|153|157|161) ;; *) fail "value must be one of the stock hotspot channels" ;; esac ;;
persist.sys.headunit.gps.disable|persist.suding.wireless.carplay.force.display)
	case "$value" in 0|1) ;; *) fail "value must be 0 or 1" ;; esac ;;
*) fail "unknown setting" ;;
esac
[ -f "${CPTHRU_MARK:-/tmp/cpthru.install}" ] && fail "a firmware install has started"
# setprop waits on the property service; don't let a wedged service hang the
# page's request (busybox here has no timeout applet).
setprop "$key" "$value" >/dev/null 2>&1 &
sp=$!
(sleep 3; kill "$sp" 2>/dev/null) &
watchdog=$!
wait "$sp"
rc=$?
kill "$watchdog" 2>/dev/null
[ "$rc" -eq 0 ] || fail "setprop failed or timed out"
now=$(getprop "$key" | tr -cd '0-9')
echo "{\"ok\":true,\"key\":\"$key\",\"value\":\"$now\"}"
