#!/bin/sh
# Gateway in front of the stock factory reset (moved to /usr/lib/cpthru):
# refused while an upload/install holds the lock or after an install started.
LOCK=${CPTHRU_LOCK:-/tmp/cpthru.lock}
MARK=${CPTHRU_MARK:-/tmp/cpthru.install}
REAL=${CPTHRU_REAL:-/usr/lib/cpthru}
CGIDIR=${CPTHRU_CGIDIR:-/etc/shttpd/cgi-bin}
refuse() { printf 'Content-Type: text/plain\n\nrefused: %s (fail)\n' "$1"; exit 0; }
exec 9>>"$LOCK"
flock -n 9 || refuse "the adapter is busy with an upload or install"
[ -f "$MARK" ] && refuse "a firmware install has started"
cd "$CGIDIR" || refuse "missing CGI directory"  # stock binary reads ./config.conf
exec "$REAL/factoryreset.cgi"
