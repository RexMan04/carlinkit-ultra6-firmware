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
# SLOWPROP names a property whose read hangs (a wedged property service).
case "\$1" in "\${SLOWPROP:-}") exec sleep 10 ;; esac
cat "$T/props/\$1" 2>/dev/null || true # unset: empty, success (like getprop)
G
cat > "$T/bin/setprop" <<S
#!/bin/sh
printf '%s' "\$2" > "$T/props/\$1"
S
chmod +x "$T/bin/"*
fails=0 n=0
run() { QUERY_STRING=$2 SLOWPROP=${SLOWPROP:-} PATH="$T/bin:$PATH" ${SH:-bash --posix} "$CGI/$1" | sed '1,/^$/d'; }
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
for k in "persist.sys.cp.showui" "persist.cpthru.off;id" "persist.cpthru" '*' ""; do
	out=$(run cpthru_set.cgi "key=$k&value=0")
	check 'echo "$out" | grep -q "unknown setting"' "key '$k' rejected"
	check '[ ! -e "$T/props/persist.sys.cp.showui" ]' "nothing written for '$k'"
done
touch "$T/glob-me"
out=$(cd "$T" && run cpthru_set.cgi "key=*&value=*")
check 'echo "$out" | grep -q "unknown setting"' "globs not expanded"

out=$(run cpthru_status.cgi "")
check 'echo "$out" | grep -q "\"markers\":\["' "markers array present"
check 'echo "$out" | json' "status JSON valid without shim files"
check 'echo "$out" | grep -q "\"status\":null" && echo "$out" | grep -q "\"off\":\"1\""' "missing files -> null; settings read"
check 'echo "$out" | grep -q "\"timing\":null,\"timing_error\":\"missing\"" && echo "$out" | grep -q "\"props_ok\":true"' "no timing file -> null + reason"
# A wedged property service must not hang the status page.
t0=$(date +%s)
out=$(SLOWPROP=persist.cpthru.off run cpthru_status.cgi "")
t1=$(date +%s)
check 'echo "$out" | json && echo "$out" | grep -q "\"props_ok\":false" && [ $((t1 - t0)) -le 6 ]' "hung getprop bounded in status ($((t1 - t0)) s)"

# Snapshot (read-only; host /proc, no adapter files here): valid JSON, the
# allowlisted settings, explicit nulls/missing for what this host lacks.
printf 1 > "$T/props/persist.console.log.nosave"
t0=$(date +%s)
out=$(SLOWPROP=persist.console.log.index run cpthru_snapshot.cgi "")
t1=$(date +%s)
check 'echo "$out" | json' "snapshot JSON valid"
check 'echo "$out" | grep -q "\"nosave\":\"1\"" && echo "$out" | grep -q "\"persist.cpthru.off\":\"1\""' "snapshot settings read"
check 'echo "$out" | grep -q "\"persist.console.log.index\":null" && echo "$out" | grep -q "\"prop:persist.console.log.index\""' "hung getprop -> null + missing"
check '[ $((t1 - t0)) -le 8 ]' "snapshot bounded ($((t1 - t0)) s)"
check 'echo "$out" | python3 -I -c "import json,sys; d=json.load(sys.stdin); assert d[\"sample_up_cs\"][1] - d[\"sample_up_cs\"][0] >= 90, d[\"sample_up_cs\"]; assert any(c[\"name\"] == \"cpu\" and c[\"total\"] > 0 for c in d[\"cpu\"])"' "two CPU samples about 1 s apart"
out=$(run cpthru_snapshot.cgi 'x=$(touch /tmp/cpthru-pwned)&key=`id`')
check '[ ! -e /tmp/cpthru-pwned ] && echo "$out" | json' "query string ignored"
echo "$n checks, $fails failed (shell: ${SH:-bash --posix})"
exit $((fails != 0))
