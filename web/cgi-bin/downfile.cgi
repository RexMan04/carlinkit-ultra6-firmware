#!/bin/sh
# Gateway in front of the stock upload CGI (moved to /usr/lib/cpthru). Each
# chunk holds the shared lock while the real CGI appends it; refused once a
# firmware install has started. Request and response bytes are unchanged.
LOCK=${CPTHRU_LOCK:-/tmp/cpthru.lock}
MARK=${CPTHRU_MARK:-/tmp/cpthru.install}
REAL=${CPTHRU_REAL:-/usr/lib/cpthru}
CGIDIR=${CPTHRU_CGIDIR:-/etc/shttpd/cgi-bin}
refuse() { printf 'Content-Type: text/plain\n\nupload refused: %s (fail)\n' "$1"; exit 0; }
exec 9>>"$LOCK"
flock -n 9 || refuse "the adapter is busy with another upload, install or reset"
[ -f "$MARK" ] && refuse "a firmware install has started"
cd "$CGIDIR" || refuse "missing CGI directory"  # stock binary reads ./config.conf
exec "$REAL/downfile.cgi"
