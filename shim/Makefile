# make test     host unit tests (needs ffmpeg with libx264 for testdata)
# make arm      build/libcpthru.so for the adapter, then check its symbols
# make qemu-test  load it into the stock sdDongle under qemu-arm, check GOT slots
ZIG ?= $(HOME)/tools/zig-x86_64-linux-0.17.0/zig
QEMU ?= $(HOME)/tools/qemu-user/qemu-arm-static
ROOTFS ?= $(HOME)/models/staging/carlinkit-ultra6-fw/tier1/rootfs_stock_exact
SRC = cpthru_core.h cpthru_core.c cpthru_timing.h cpthru_timing.c cpthru_hooks.c
# Content hash of the sources: names the fail marker, so a new build starts clean.
BUILD_ID ?= $(shell cat $(SRC) | sha256sum | cut -c1-12)
CFLAGS = -std=c11 -O2 -Wall -Wextra

FFENC = ffmpeg -hide_banner -loglevel error -y -f lavfi
X264 = -c:v libx264 -profile:v high -x264-params keyint=20:min-keyint=20:scenecut=0:aud=1:bframes=0

test: build/test_core build/test_timing testdata
	./build/test_core
	python3 -I -c 'import json,sys; L=open("build/status.jsonl").read().split(chr(10)); L=[l for l in L if l]; [json.loads(l) for l in L]; print(len(L), "status JSON objects parse")'
	./build/test_timing
	python3 -I check_timing_json.py build/timing
	node test_page.js
	node ../web/test_diag_view.js
	./test_cgi.sh

build/test_core: test_core.c cpthru_core.c cpthru_core.h
	@mkdir -p build
	cc $(CFLAGS) -fsanitize=undefined -fsanitize-trap=all -D_FORTIFY_SOURCE=2 -g -o $@ test_core.c cpthru_core.c

build/test_timing: test_timing.c cpthru_timing.c cpthru_timing.h
	@mkdir -p build
	cc $(CFLAGS) -fsanitize=undefined -fsanitize-trap=all -D_FORTIFY_SOURCE=2 -g -o $@ test_timing.c cpthru_timing.c

testdata: testdata/main.h264 testdata/other.h264 testdata/multi.h264 testdata/crop.h264
testdata/main.h264:
	@mkdir -p testdata
	$(FFENC) -i testsrc2=size=1920x720:rate=60 -frames:v 40 $(X264) $@
testdata/other.h264:
	$(FFENC) -i testsrc2=size=1280x720:rate=60 -frames:v 20 $(X264) $@
testdata/multi.h264:
	$(FFENC) -i testsrc2=size=1920x720:rate=60 -frames:v 20 $(X264):slices=4 $@
testdata/crop.h264:
	$(FFENC) -i testsrc2=size=1920x1080:rate=30 -frames:v 5 -c:v libx264 -profile:v baseline -x264-params aud=1 $@

arm: build/libcpthru.so
	python3 -I check_syms.py build/libcpthru.so $(ROOTFS)

build/libcpthru.so: $(SRC)
	@mkdir -p build
	$(ZIG) cc -target arm-linux-musleabihf -mcpu=cortex_a7 -shared -fPIC -O2 -Wall -Wextra \
		-DCP_BUILD_ID='"$(BUILD_ID)"' -Wl,-soname,libcpthru.so -s -o $@ cpthru_hooks.c cpthru_core.c cpthru_timing.c

qemu-test: arm
	./qemu_test.sh $(ROOTFS) $(QEMU) $(ZIG)
	SH="$(QEMU) -L $(dir $(ROOTFS))qemu_root $(dir $(ROOTFS))qemu_root/bin/sh" ./test_cgi.sh
	./test_cgi_device.sh $(dir $(ROOTFS))qemu_root $(QEMU)

clean:
	rm -f build/test_core build/test_timing build/libcpthru.so build/libqtest.so build/qtest_table.h

.PHONY: test arm qemu-test testdata clean
