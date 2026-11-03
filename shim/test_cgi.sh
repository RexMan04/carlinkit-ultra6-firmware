#!/usr/bin/env bash
# Runs the web CGIs with fake getprop/setprop (WEBUI_PLAN.md: CGI tests).
# SH selects the shell under test (default: bash --posix; qemu_cgi.sh runs the
# device busybox).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CGI=$HERE/../web/cgi-bin
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/props"
cat > "$T/bin/getprop" <<G
#!/bin/sh
cat "$T/props/\$1" 2>/dev/null
G
cat > "$T/bin/setprop" <<S
#!/bin/sh
printf '%s' "\$2" > "$T/props/\$1"
S
chmod +x "$T/bin/"*
fails=0 n=0
run() { QUERY_STRING=$2 PATH="$T/bin:$PATH" ${SH:-bash --posix} "$CGI/$1" | sed '1,/^$/d'; }
check() { n=$((n+1)); if ! eval "$1"; then fails=$((fails+1)); echo "FAIL $2"; fi; }
json() { python3 -I -c 'import json,sys; json.loads(sys.stdin.read())'; }

for v in 0 300 400 1000; do
	out=$(run cpthru_set.cgi "key=persist.suding.wl.audio.latency&value=$v")
	check '[ "$(cat $T/props/persist.suding.wl.audio.latency)" = "$v" ] && echo "$out" | grep -q "\"ok\":true"' "latency $v accepted"
done
for v in 200 299 1100 350 -1 "" "400;id" '$(id)' '400`id`' "400%0aid" "1e3"; do
	echo 400 > "$T/props/persist.suding.wl.audio.latency"
	out=$(run cpthru_set.cgi "key=persist.suding.wl.audio.latency&value=$v")
	check 'echo "$out" | grep -q "\"ok\":false" && [ "$(cat $T/props/persist.suding.wl.audio.latency)" = "400" ]' "latency '$v' rejected"
	echo "$out" | json || { fails=$((fails+1)); echo "FAIL json for '$v'"; }
done
out=$(run cpthru_set.cgi "key=persist.cpthru.off&value=1")
check '[ "$(cat $T/props/persist.cpthru.off)" = "1" ]' "switch off"
for k in "persist.sys.wifi.channel" "persist.cpthru.off;id" "persist.cpthru" '*' ""; do
	out=$(run cpthru_set.cgi "key=$k&value=0")
	check 'echo "$out" | grep -q "unknown setting"' "key '$k' rejected"
	check '[ ! -e "$T/props/persist.sys.wifi.channel" ]' "nothing written for '$k'"
done
touch "$T/glob-me"
out=$(cd "$T" && run cpthru_set.cgi "key=*&value=*")
check 'echo "$out" | grep -q "unknown setting"' "globs not expanded"

out=$(run cpthru_status.cgi "")
check 'echo "$out" | grep -q "\"markers\":\["' "markers array present"
check 'echo "$out" | json' "status JSON valid without shim files"
check 'echo "$out" | grep -q "\"status\":null" && echo "$out" | grep -q "\"off\":\"1\""' "missing files -> null; settings read"
echo "$n checks, $fails failed (shell: ${SH:-bash --posix})"
exit $((fails != 0))
