#!/bin/sh
# Status for /cpthru.html: the shim's status and connection files plus the two
# settings it controls (WEBUI_PLAN.md). Read-only.
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
st=$(cat /tmp/cpthru.status 2>/dev/null)
ln=$(cat /tmp/cpthru.link 2>/dev/null)
now=$(awk '{printf "%d", $1 * 1000}' /proc/uptime)
off=$(getprop persist.cpthru.off | tr -cd '0-9')
lat=$(getprop persist.suding.wl.audio.latency | tr -cd '0-9')
build=$(cat /tmp/cpthru.build 2>/dev/null | tr -cd 'a-z0-9')
markers=$(ls /mnt/UDISK/ 2>/dev/null | awk '/^cpthru\.fail\./ { id = substr($0, 13); gsub(/[^a-z0-9]/, "", id); printf "%s\"%s\"", (n++ ? "," : ""), id }')
echo "{\"now_ms\":${now:-0},\"build\":\"$build\",\"markers\":[$markers],\"status\":${st:-null},\"link\":${ln:-null},\"settings\":{\"off\":\"$off\",\"latency\":\"$lat\"}}"
