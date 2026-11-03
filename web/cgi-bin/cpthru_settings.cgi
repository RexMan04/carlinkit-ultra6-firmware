#!/bin/sh
# Saved values of every setting cpthru_set.cgi may change (read once when the
# main page loads and after a save; not part of the 2 s status poll).
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
prop() {
	v=$( { getprop "$1" 2>/dev/null & p=$!; { sleep 2; kill "$p"; } </dev/null >/dev/null 2>&1 & w=$!; wait "$p"; r=$?; kill "$w" 2>/dev/null; exit "$r"; } )
	r=$?
	printf '%s' "$v" | tr -cd '0-9'
	[ "$r" -eq 0 ]
}
ok=true; vals=
for k in persist.cpthru.off persist.suding.wl.audio.latency persist.sys.carplay.audio.media.samplerate \
	persist.sys.boot.delay persist.sys.wifi.channel persist.sys.headunit.gps.disable \
	persist.suding.wireless.carplay.force.display; do
	v=$(prop "$k") || ok=false
	vals="$vals${vals:+,}\"$k\":\"$v\""
done
inst=false
[ -f "${CPTHRU_MARK:-/tmp/cpthru.install}" ] && inst=true
echo "{\"ok\":$ok,\"values\":{$vals},\"install_started\":$inst}"
