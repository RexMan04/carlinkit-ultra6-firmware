#!/usr/bin/env python3
# Build a test firmware for the Mini Ultra 6 from the stock .swu. Only the
# rootfs changes; kernel, recovery and sw-description are copied byte for byte.
#
# Variants:
#   tier1     lift the CarPlay 30 fps caps (6 bytes in libSdCommon.so) and add
#             the fps probe boot script
#   passthru  add /usr/lib/libcpthru.so (built by `make -C shim arm`) and
#             preload it on both sdDongle launch lines (PASSTHROUGH_PLAN.md);
#             add the pass-through web page and link it from the stock page
#             (WEBUI_PLAN.md)
#
# Usage: build_fw.py tier1|passthru     build + verify
#        build_fw.py --selftest          repack untouched stock, expect identical
#
# Integrity (plan R11): the stock rootfs is extracted fresh from the
# md5-verified stock .swu on every run, and the rebuilt image is extracted
# again and compared to it file by file (sha256 + mode/owner/size/mtime/link),
# allowing only the variant's declared changes.
import hashlib, os, shutil, subprocess, sys

FW = os.path.expanduser("~/models/staging/carlinkit-ultra6-fw")
STOCK_SWU = f"{FW}/v5_202610121756.swu"
STOCK_MD5 = "8cda8cf273d665c80b2a4b217b9bdf44"
WORK = f"{FW}/build"
HERE = os.path.dirname(os.path.abspath(__file__))
PAD = 0x10000  # stock rootfs image is padded to 64 KiB

# (file in rootfs, file offset, stock bytes, new bytes, what it does)
TIER1_PATCHES = [
    ("usr/lib/libSdCommon.so", 0x1a2b4, "1c20a0e3", "0a20a0e3",
     "setCarlinkH264Data: landscape frame gate 28 ms -> 10 ms"),
    ("usr/lib/libSdCommon.so", 0x1e830, "1c20a0e3", "0a20a0e3",
     "ScreenRecordPrivate ctor: default frame gate 28 ms -> 10 ms"),
    ("usr/lib/libSdCommon.so", 0x1e7dc, "1e0053e3", "3c0053e3",
     "ScreenRecordPrivate ctor: fps clamp, compare 30 -> 60"),
    ("usr/lib/libSdCommon.so", 0x1e7e8, "1e20a0e3", "3c20a0e3",
     "ScreenRecordPrivate ctor: fps clamp, value 30 -> 60"),
    ("usr/lib/libSdCommon.so", 0x2695c, "1e20a0e3", "3c20a0e3",
     "new_video_encoder_handle_ext: stContext_init fps 30 -> 60"),
    ("usr/lib/libSdCommon.so", 0x269ac, "1e20a0e3", "3c20a0e3",
     "new_video_encoder_handle_ext: h264_context_create fps 30 -> 60"),
]
S11 = "etc/init.d/S11carplay_init"
PRELOAD = "LD_PRELOAD=/usr/lib/libcpthru.so "
# Both sdDongle launch lines in the stock S11carplay_init (plan R9).
WEB = "etc/shttpd"
WEB_FILES = {  # rootfs path -> (source in web/, mode)
    f"{WEB}/cpthru.html": ("cpthru.html", 0o644),
    f"{WEB}/cpthru.js": ("cpthru.js", 0o644),
    f"{WEB}/cgi-bin/cpthru_status.cgi": ("cgi-bin/cpthru_status.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_set.cgi": ("cgi-bin/cpthru_set.cgi", 0o744),
}
INDEX_ANCHOR = '\t<div class="cpbone">\n\t\t<h1 id="Config"></h1>\n'
S11_LAUNCHES = ["\t\tsdDongle&\n", "\t\tsdDongle &> /mnt/UDISK/log/sdDongle_\"$log_index\".log &\n"]


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw).stdout


def md5(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


def read_cpio(path):
    """SVR4 'crc' cpio (070702) -> list of (header fields, name, data)."""
    d = open(path, "rb").read()
    i, items = 0, []
    while True:
        h = d[i:i + 110]
        assert h[:6] == b"070702", f"bad cpio magic at {i}"
        f = [int(h[6 + 8 * k:14 + 8 * k], 16) for k in range(13)]
        name = d[i + 110:i + 110 + f[11] - 1].decode()
        i = (i + 110 + f[11] + 3) & ~3
        if name == "TRAILER!!!":
            return items, len(d)
        items.append((f, name, d[i:i + f[6]]))
        i = (i + f[6] + 3) & ~3


def write_cpio(path, items, total_len):
    """Write items with their stock headers; size and checksum recomputed."""
    out = bytearray()

    def entry(f, name, data):
        f = list(f)
        f[6], f[11], f[12] = len(data), len(name) + 1, sum(data) & 0xffffffff
        out.extend(b"070702" + b"".join(b"%08X" % v for v in f) + name.encode() + b"\0")
        out.extend(b"\0" * (-len(out) % 4) + data)
        out.extend(b"\0" * (-len(out) % 4))

    for f, name, data in items:
        entry(f, name, data)
    entry([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], "TRAILER!!!", b"")
    out.extend(b"\0" * (-len(out) % 512))
    assert len(out) <= total_len + 512, "swu grew unexpectedly"
    open(path, "wb").write(out)


def unsquash(img, tree):
    """Extract preserving modes. Exit 2 = non-fatal: as non-root it can't
    mknod /dev/console (mksquashfs adds it back); the checks catch the rest."""
    if os.path.exists(tree):
        shutil.rmtree(tree)
    rc = subprocess.run(["sh", "-c", f"umask 0 && unsquashfs -no-xattrs -d '{tree}' '{img}'"],
                        capture_output=True).returncode
    assert rc in (0, 2), f"unsquashfs failed ({rc})"


def mksquashfs(tree, img, stock_img):
    if os.path.exists(img):
        os.remove(img)
    # Stock image: gzip, 256 KiB blocks, root-owned, no xattrs, fixed times.
    t = run("unsquashfs", "-mkfs-time", stock_img).strip()
    run("mksquashfs", tree, img, "-comp", "gzip", "-b", "262144", "-all-root",
        "-no-xattrs", "-noappend", "-quiet", "-no-progress", "-mkfs-time", t,
        "-p", f"dev/console C {t} 600 0 0 5 1")
    size = os.path.getsize(img)
    with open(img, "ab") as fh:
        fh.write(b"\0" * (-size % PAD))
    return size


def inventory(img, tree):
    """path -> (listing line without the path, sha256 of contents or link target)."""
    inv = {}
    for line in run("unsquashfs", "-lln", img).splitlines()[1:]:
        meta, _, rest = line.partition(" squashfs-root")
        path = rest.split(" -> ")[0].lstrip("/") or "."
        p = os.path.join(tree, path)
        if os.path.islink(p):
            digest = "link:" + os.readlink(p)
        elif os.path.isfile(p):
            digest = hashlib.sha256(open(p, "rb").read()).hexdigest()
        else:
            digest = "-"
        inv[path] = (" ".join(meta.split()), digest)
    return inv


def keep_time(path, fn):
    st = os.stat(path)
    fn()
    os.utime(path, (st.st_atime, st.st_mtime))


def apply_tier1(tree):
    for rel, off, old, new, what in TIER1_PATCHES:
        p = f"{tree}/{rel}"

        def patch():
            b = bytearray(open(p, "rb").read())
            got = b[off:off + 4].hex()
            assert got == old, f"{rel}@{off:#x}: expected {old}, found {got}"
            b[off:off + 4] = bytes.fromhex(new)
            open(p, "wb").write(b)
        keep_time(p, patch)
        print(f"patched {rel} @{off:#07x} {old} -> {new}  {what}")
    d = f"{tree}/etc/init.d"
    keep_time(d, lambda: shutil.copy(f"{HERE}/fpsprobe.sh", f"{d}/S99fpsprobe"))
    os.chmod(f"{d}/S99fpsprobe", 0o755)
    print("added /etc/init.d/S99fpsprobe")
    return {"etc/init.d", "etc/init.d/S99fpsprobe", "usr/lib/libSdCommon.so"}


def apply_passthru(tree):
    lib = f"{HERE}/shim/build/libcpthru.so"
    run("make", "-C", f"{HERE}/shim", "arm")  # builds and runs check_syms.py
    build_id = next((l for l in run("strings", lib).splitlines() if l.startswith("cpthru-build-id=")), "")
    assert build_id, "no build id in libcpthru.so"
    d = f"{tree}/usr/lib"
    keep_time(d, lambda: shutil.copy(lib, f"{d}/libcpthru.so"))
    os.chmod(f"{d}/libcpthru.so", 0o755)
    print(f"added /usr/lib/libcpthru.so ({os.path.getsize(lib)} bytes, md5 {md5(lib)})")

    p = f"{tree}/{S11}"

    def edit():
        s = open(p).read()
        for line in S11_LAUNCHES:
            assert s.count(line) == 1, f"S11 launch line not found exactly once: {line!r}"
            s = s.replace(line, line.replace("sdDongle", PRELOAD + "sdDongle", 1))
        assert s.count(PRELOAD + "sdDongle") == 2
        open(p, "w").write(s)
    keep_time(p, edit)
    print("preloaded libcpthru.so on both sdDongle launch lines in", S11)

    for dst, (src, mode) in WEB_FILES.items():
        d = os.path.dirname(f"{tree}/{dst}")
        keep_time(d, lambda: shutil.copy(f"{HERE}/web/{src}", f"{tree}/{dst}"))
        os.chmod(f"{tree}/{dst}", mode)
    idx = f"{tree}/{WEB}/index.html"
    link = open(f"{HERE}/web/index_link.html").read()

    def add_link():
        s = open(idx).read()
        assert s.count(INDEX_ANCHOR) == 1, "index.html anchor not found exactly once"
        s2 = s.replace(INDEX_ANCHOR, link + INDEX_ANCHOR)
        assert s2.replace(link, "", 1) == s  # everything else byte-identical
        open(idx, "w").write(s2)
    keep_time(idx, add_link)
    print("added the pass-through page, its CGIs, and a link in index.html")
    return ({"usr/lib", "usr/lib/libcpthru.so", S11, f"{WEB}/index.html", WEB, f"{WEB}/cgi-bin"}
            | set(WEB_FILES)), build_id


def build(variant, items, total_len):
    stock_img = f"{WORK}/rootfs.stock.img"
    open(stock_img, "wb").write(next(d for f, n, d in items if n == "rootfs"))
    stock_tree = f"{WORK}/stock"
    unsquash(stock_img, stock_tree)
    stock_inv = inventory(stock_img, stock_tree)

    tree = f"{WORK}/{variant}"
    if os.path.exists(tree):
        shutil.rmtree(tree)
    run("cp", "-a", stock_tree, tree)
    if variant == "selftest":
        allowed, tag = set(), ""
    elif variant == "tier1":
        allowed, tag = apply_tier1(tree), ""
    else:
        allowed, tag = apply_passthru(tree)

    img = f"{WORK}/rootfs.{variant}.img"
    used = mksquashfs(tree, img, stock_img)
    stock_len = os.path.getsize(stock_img)
    assert os.path.getsize(img) <= stock_len, "rebuilt rootfs is bigger than stock"
    print(f"rootfs {used} bytes used, {os.path.getsize(img)} padded (stock {stock_len})")

    # Extract what we built and compare every entry with stock.
    check_tree = f"{WORK}/{variant}.check"
    unsquash(img, check_tree)
    new_inv = inventory(img, check_tree)
    changed = {p for p in stock_inv.keys() | new_inv.keys() if stock_inv.get(p) != new_inv.get(p)}
    assert changed == allowed, f"unexpected changes: {sorted(changed ^ allowed)}"
    print(f"verified: {len(new_inv)} entries; changed only {sorted(changed) or 'nothing'}")
    shutil.rmtree(check_tree)
    if variant == "selftest":
        return

    rootfs = open(img, "rb").read()
    names = [n for f, n, d in items]
    md5s = dict(line.split()[::-1] for line in
                next(d for f, n, d in items if n == "cpio_item_md5").decode().splitlines())
    md5s["rootfs"] = hashlib.md5(rootfs).hexdigest()
    md5_text = "".join(f"{md5s[n]}  {n}\n" for n in names if n in md5s).encode()
    new_items = [(f, n, rootfs if n == "rootfs" else md5_text if n == "cpio_item_md5" else d)
                 for f, n, d in items]
    out = f"{WORK}/v5_202610121756_{variant}.swu"
    write_cpio(out, new_items, total_len)

    # Read back what we wrote and check it the way swupdate would.
    back, _ = read_cpio(out)
    assert [n for f, n, d in back] == names
    listed = dict(l.split()[::-1] for l in
                  next(d for f, n, d in back if n == "cpio_item_md5").decode().splitlines())
    for f, n, d in back:
        if n in listed:
            assert hashlib.md5(d).hexdigest() == listed[n], f"md5 mismatch {n}"
        assert f[12] == sum(d) & 0xffffffff
        if n not in ("rootfs", "cpio_item_md5"):
            assert d == next(x for g, m, x in items if m == n), f"{n} changed"
    print(f"wrote {out}\n  md5 {md5(out)}  size {os.path.getsize(out)}" + (f"\n  {tag}" if tag else ""))


def main():
    variant = {"--selftest": "selftest"}.get(sys.argv[1], sys.argv[1]) if len(sys.argv) > 1 else ""
    assert variant in ("tier1", "passthru", "selftest"), __doc__ or "usage: build_fw.py tier1|passthru|--selftest"
    assert md5(STOCK_SWU) == STOCK_MD5, "stock .swu changed on disk"
    os.makedirs(WORK, exist_ok=True)
    items, total_len = read_cpio(STOCK_SWU)
    build(variant, items, total_len)


if __name__ == "__main__":
    main()
