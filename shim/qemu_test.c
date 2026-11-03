/* Loader-level interposition test (PASSTHROUGH_PLAN.md "Verification" 2).
 * Built as a shared library and preloaded after libcpthru.so into the stock
 * sdDongle under qemu-arm, with the stock rootfs as sysroot. The device's own
 * musl 1.1.24 loader binds every PLT slot eagerly before constructors run, so
 * this constructor reads each hooked JUMP_SLOT from the caller's GOT, checks
 * it points into the shim, checks the shim found every original via
 * RTLD_NEXT, and exits before sdDongle's main() starts. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <link.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "build/qtest_table.h"

void *cp_dlsym(void *h, const char *n) __asm__("dlsym");
int cp_dladdr(const void *a, Dl_info *i) __asm__("dladdr");

struct find { const char *name; unsigned long base; int found; };

static int each(struct dl_phdr_info *i, size_t sz, void *arg)
{
	(void)sz;
	struct find *f = arg;
	const char *n = i->dlpi_name && *i->dlpi_name ? i->dlpi_name : "sdDongle";
	const char *b = strrchr(n, '/');
	if (!strcmp(b ? b + 1 : n, f->name))
		f->base = i->dlpi_addr, f->found = 1;
	return f->found;
}

__attribute__((constructor)) static void run(void)
{
	int bad = 0;
	for (unsigned k = 0; k < sizeof slots / sizeof *slots; k++) {
		struct find f = {slots[k].obj, 0, 0};
		dl_iterate_phdr(each, &f);
		if (!f.found) {
			printf("FAIL %s not loaded\n", slots[k].obj);
			bad++;
			continue;
		}
		void *target = *(void **)(f.base + slots[k].off);
		Dl_info di = {0};
		cp_dladdr(target, &di);
		int ok = di.dli_fname && strstr(di.dli_fname, "libcpthru");
		printf("%s %s GOT %s -> %s\n", ok ? "ok" : "FAIL", slots[k].obj, slots[k].sym,
		       di.dli_fname ? di.dli_fname : "?");
		bad += !ok;
	}
	/* The shim's lazy init resolves originals; it prints "cpthru: missing X"
	 * on stderr for any it can't find. Calling a hook triggers it. */
	int (*info)(const char *, int) = cp_dlsym(RTLD_DEFAULT, "sd_get_info_int");
	int v = info ? info("CPTHRU_TEST_KEY", 1234) : -1;
	printf("%s sd_get_info_int reaches the original: %d\n", v == 1234 ? "ok" : "FAIL", v);
	bad += v != 1234;
	/* Timing uses only this firmware clock (no new clock imports). */
	int (*ms)(void) = cp_dlsym(RTLD_DEFAULT, "get_current_mono_time_ms");
	int a = ms ? ms() : -1, b = ms ? ms() : -1;
	printf("%s get_current_mono_time_ms resolves and is monotonic: %d -> %d\n",
	       ms && b >= a ? "ok" : "FAIL", a, b);
	bad += !ms || b < a;
	printf(bad ? "%d problem(s)\n" : "PASS\n", bad);
	fflush(stdout);
	_exit(bad != 0);
}
