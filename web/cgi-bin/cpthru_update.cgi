#!/bin/sh
# Firmware update gateway (MAINPAGE_PLAN.md). One shared lock serializes
# every staging mutation (upload chunks via the downfile.cgi gateway, this
# script, factory reset). The install-started marker is checked only while the
# lock is held and, once written, stays until reboot (/tmp), so the stock
# installer runs at most once per boot.
#   ?op=state                          phase, staged files, installer log tail
#   ?op=verify&name=N&size=S           md5sum of one staged file
#   ?op=install&name=N&size=S&md5=M    re-check, then start the stock installer
set -f
echo "Content-Type: application/json"
echo "Cache-Control: no-store"
echo ""
DIR=${CPTHRU_STAGE:-/mnt/UDISK/swupdate}
LOCK=${CPTHRU_LOCK:-/tmp/cpthru.lock}
MARK=${CPTHRU_MARK:-/tmp/cpthru.install}
REAL=${CPTHRU_REAL:-/usr/lib/cpthru}
CGIDIR=${CPTHRU_CGIDIR:-/etc/shttpd/cgi-bin}
out() { echo "$1"; exit 0; }
reject() { out "{\"ok\":false,\"phase\":\"rejected\",\"error\":\"$1\"}"; }
op=; name=; size=; md5=
old_ifs=$IFS
IFS='&'
for kv in $QUERY_STRING; do
	case "$kv" in
	op=*) op=${kv#op=} ;;
	name=*) name=${kv#name=} ;;
	size=*) size=${kv#size=} ;;
	md5=*) md5=${kv#md5=} ;;
	esac
done
IFS=$old_ifs
# The only names ever staged: a closed set, all far below the stock
# submition.cgi command buffer.
case "$name" in
''|cpthru.swu|v5_202610121756_STOCK_rollback.swu|v5_202610121756_passthru.swu|v5_202610121756_passthru_diag.swu) ;;
*) reject "unexpected file name" ;;
esac
fsize() { ls -ln "$1" 2>/dev/null | awk 'NR == 1 && $5 ~ /^[0-9]+$/ { print $5 }'; }
locked() { exec 9>>"$LOCK"; flock -n 9; }

case "$op" in
state)
	phase=idle; inst=
	if [ -f "$MARK" ]; then
		phase=install-started
		inst=$(tr -cd 'A-Za-z0-9._:= ' < "$MARK")
	fi
	# (No lock probe here: taking the lock, even briefly, could make a
	# concurrent upload chunk be refused.)
	files=
	set +f
	for f in "$DIR"/*; do
		[ -f "$f" ] || continue
		n=${f##*/}
		case "$n" in *[!A-Za-z0-9._-]*) continue ;; esac
		files="$files${files:+,}{\"name\":\"$n\",\"size\":$(fsize "$f")}"
	done
	set -f
	# busybox df may wrap a long device name onto its own line (as in cpthru_snapshot.cgi).
	free=$(df -k "$DIR" 2>/dev/null | awk 'NR > 1 { if (NF >= 6) a = $4; else if (NF == 5) a = $3 } END { if (a ~ /^[0-9]+$/) printf "%.0f", a * 1024 }')
	log=
	if [ "$phase" = install-started ] && [ -f "$DIR/swupdate.log" ]; then
		log=$(awk '{ a[NR % 6] = $0 } END { for (i = NR - 5; i <= NR; i++) if (i > 0) print a[i % 6] }' "$DIR/swupdate.log" |
			tr -cd 'A-Za-z0-9 ._:/%#()=,+\n-' | awk '{ printf "%s\"%s\"", (NR > 1 ? "," : ""), substr($0, 1, 160) }')
	fi
	out "{\"ok\":true,\"phase\":\"$phase\",\"install\":\"$inst\",\"staged\":[$files],\"free_bytes\":${free:-null},\"log\":[$log]}"
	;;
verify)
	[ -n "$name" ] || reject "missing name"
	locked || reject "the adapter is busy with an upload or install"
	[ -f "$MARK" ] && reject "an install was already started"
	[ -f "$DIR/$name" ] || reject "no staged copy"
	s=$(fsize "$DIR/$name")
	[ "$s" = "$size" ] || reject "staged copy has a different size"
	m=$(md5sum "$DIR/$name" | cut -d' ' -f1 | tr -cd '0-9a-f')
	out "{\"ok\":true,\"name\":\"$name\",\"size\":$s,\"md5\":\"$m\"}"
	;;
install)
	[ -n "$name" ] || reject "missing name"
	case "$size" in ''|*[!0-9]*) reject "bad size" ;; esac
	case "$md5" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) reject "bad md5" ;; esac
	[ ${#md5} -eq 32 ] && [ -z "$(printf '%s' "$md5" | tr -d '0-9a-f')" ] || reject "bad md5"
	# Lock first (waits for an in-flight chunk), then the authoritative marker check.
	i=0
	exec 9>>"$LOCK"
	while ! flock -n 9; do
		i=$((i + 1))
		[ $i -ge 10 ] && reject "the adapter is busy with an upload or reset"
		sleep 1
	done
	[ -f "$MARK" ] && out "{\"ok\":false,\"phase\":\"install-started\",\"error\":\"an install was already started this boot\"}"
	[ -f "$DIR/$name" ] || reject "no staged copy"
	[ "$(fsize "$DIR/$name")" = "$size" ] || reject "staged copy has a different size"
	m=$(md5sum "$DIR/$name" | cut -d' ' -f1)
	[ "$m" = "$md5" ] || reject "staged copy does not match the verified file"
	echo "name=$name size=$size md5=$md5 up=$(cut -d' ' -f1 /proc/uptime)" > "$MARK" || reject "cannot record install state"
	# Launch the stock installer once, detached, without the lock fd.
	( cd "$CGIDIR" && QUERY_STRING="filename=$name&" REQUEST_METHOD=GET \
		setsid "$REAL/submition.cgi" > /tmp/cpthru.install.log 2>&1 < /dev/null 9>&- & )
	out "{\"ok\":true,\"phase\":\"install-started\",\"name\":\"$name\",\"md5\":\"$md5\"}"
	;;
*) reject "unknown op" ;;
esac
