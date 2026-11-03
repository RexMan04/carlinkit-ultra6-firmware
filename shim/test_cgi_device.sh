#!/usr/bin/env bash
# REV-05: run both CGIs under qemu with the device's own busybox shell and
# utilities and its real getprop/setprop. PATH holds only wrappers that run the
# device binaries through qemu, so nothing resolves to a host tool. There's no
# property service under qemu, so getprop/setprop fail; the CGIs must still
# return valid JSON and report the failed set instead of claiming success.
set -u
Q=$1 QEMU=$2
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
for b in getprop setprop; do
	printf '#!/bin/sh\nexec %s -L %s %s/usr/bin/%s "$@"\n' "$QEMU" "$Q" "$Q" "$b" > "$T/$b"
done
for a in cat awk tr ls sed cut df du sleep; do # only applets the adapter's busybox has
	printf '#!/bin/sh\nexec %s -L %s %s/bin/busybox %s "$@"\n' "$QEMU" "$Q" "$Q" "$a" > "$T/$a"
done
chmod +x "$T"/*
fails=0
run() { QUERY_STRING=$2 PATH="$T" "$QEMU" -L "$Q" "$Q/bin/sh" "$HERE/../web/cgi-bin/$1" 2>/dev/null | sed '1,/^$/d'; }
json() { python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read()))'; }
echo "status:"; out=$(run cpthru_status.cgi ""); echo "$out" | json || fails=$((fails+1))
echo "set (allowed key):"; out=$(run cpthru_set.cgi "key=persist.cpthru.off&value=1"); echo "$out" | json || fails=$((fails+1))
case "$out" in *'"ok":true,"key":"persist.cpthru.off","value":"1"'*) ;; *'"ok":false'*|*'"value":""'*) ;; *) fails=$((fails+1)); echo "FAIL unexpected set reply";; esac
echo "set (bad key):"; out=$(run cpthru_set.cgi "key=x&value=1"); echo "$out" | json || fails=$((fails+1))
echo "snapshot (device busybox applets, real getprop):"
t0=$(date +%s); out=$(run cpthru_snapshot.cgi ""); t1=$(date +%s)
echo "$out" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print({k: d[k] for k in ("props", "nosave", "udisk", "missing")}); assert len(d["cpu"]) >= 1 and d["sample_up_cs"][1] > d["sample_up_cs"][0]' || fails=$((fails+1))
[ $((t1 - t0)) -le 20 ] || { fails=$((fails+1)); echo "FAIL snapshot took $((t1 - t0)) s"; }
echo "device CGI smoke: $fails failure(s)"
exit $((fails != 0))
