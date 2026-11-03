#!/bin/sh
# Gateway in front of the stock upload CGI (moved to /usr/lib/cpthru). Each
# chunk holds the shared lock while the real CGI appends it; refused once a
# firmware install has started. The stock binary reads CONTENT_LENGTH bytes
# without a bound and copies the multipart filename unchecked into a small
# stack buffer, so the request is buffered here (at most 12 KiB), its length
# and filename (closed set + protocol suffix) checked, and the identical bytes
# handed to the stock binary on stdin.
set -f
LOCK=${CPTHRU_LOCK:-/tmp/cpthru.lock}
MARK=${CPTHRU_MARK:-/tmp/cpthru.install}
REAL=${CPTHRU_REAL:-/usr/lib/cpthru}
CGIDIR=${CPTHRU_CGIDIR:-/etc/shttpd/cgi-bin}
TMP=${CPTHRU_TMP:-/tmp}/cpthru.chunk.$$
refuse() { rm -f "$TMP"; printf 'Content-Type: text/plain\n\nupload refused: %s (fail)\n' "$1"; exit 0; }
exec 9>>"$LOCK"
flock -n 9 || refuse "the adapter is busy with another upload, install or reset"
[ -f "$MARK" ] && refuse "a firmware install has started"
case "$CONTENT_LENGTH" in ''|*[!0-9]*) refuse "bad request length" ;; esac
[ "$CONTENT_LENGTH" -ge 1 ] && [ "$CONTENT_LENGTH" -le 12288 ] || refuse "bad request length"
cat > "$TMP" || refuse "could not buffer the request"
[ "$(ls -ln "$TMP" | awk 'NR == 1 { print $5 }')" = "$CONTENT_LENGTH" ] || refuse "request length mismatch"
# First filename="..." in the request (the part header precedes the data).
fn=$(tr -c 'A-Za-z0-9._:="-' '\n' < "$TMP" | awk '/^filename="[^"]*"$/ { print substr($0, 11, length($0) - 11); exit }')
case "$fn" in
cpthru.swu.[01]|v5_202610121756_STOCK_rollback.swu.[01]|v5_202610121756_passthru.swu.[01]|v5_202610121756_passthru_diag.swu.[01]) ;;
cpthru.swu:*.2|v5_202610121756_STOCK_rollback.swu:*.2|v5_202610121756_passthru.swu:*.2|v5_202610121756_passthru_diag.swu:*.2)
	sum=${fn#*:}; sum=${sum%.2}
	[ ${#sum} -eq 32 ] && [ -z "$(printf '%s' "$sum" | tr -d '0-9a-f')" ] || refuse "bad checksum field" ;;
*) refuse "unexpected file name" ;;
esac
cd "$CGIDIR" || refuse "missing CGI directory"  # stock binary reads ./config.conf
exec 0< "$TMP"
rm -f "$TMP"
exec "$REAL/downfile.cgi"
