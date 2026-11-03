#!/usr/bin/env bash
# make qemu-test: preload libcpthru.so + the GOT checker into the stock
# sdDongle under qemu-arm (PASSTHROUGH_PLAN.md "Verification" 2).
# Uses a scratch copy of the rootfs; links every library into both /lib and
# /usr/lib with relative links, because qemu falls back to the host's x86
# file for any path missing from the sysroot.
set -euo pipefail
ROOTFS=$1 QEMU=$2 ZIG=$3
HERE=$(cd "$(dirname "$0")" && pwd)
Q=$(dirname "$ROOTFS")/qemu_root
rm -rf -- "$Q"
cp -a "$ROOTFS" "$Q"
(cd "$Q"
 for f in lib/*.so*; do b=${f#lib/}; [ -e "usr/lib/$b" ] || ln -s "../../lib/$b" "usr/lib/$b"; done
 for f in usr/lib/*.so*; do b=${f#usr/lib/}; [ -e "lib/$b" ] || [ -L "lib/$b" ] || ln -s "../usr/lib/$b" "lib/$b"; done)
python3 -I "$HERE/check_syms.py" --got-table "$ROOTFS" > "$HERE/build/qtest_table.h"
"$ZIG" cc -target arm-linux-musleabihf -mcpu=cortex_a7 -O1 -shared -fPIC -I"$HERE" \
	-o "$HERE/build/libqtest.so" "$HERE/qemu_test.c"
cp "$HERE/build/libcpthru.so" "$Q/usr/lib/"
cp "$HERE/build/libqtest.so" "$Q/tmp/"
cd "$Q"
timeout 60 "$QEMU" -L "$Q" -E "LD_PRELOAD=/usr/lib/libcpthru.so /tmp/libqtest.so" \
	-E LD_LIBRARY_PATH=/lib:/usr/lib "$Q/usr/bin/sdDongle"
