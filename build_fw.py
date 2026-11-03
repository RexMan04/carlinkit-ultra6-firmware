#!/usr/bin/env python3
# Build a test firmware for the Mini Ultra 6 from the stock .swu. Only the
# rootfs changes; kernel, recovery and sw-description are copied byte for byte.
#
# Variants:
#   tier1     lift the CarPlay 30 fps caps (6 bytes in libSdCommon.so) and add
#             the fps probe boot script
#   passthru  RETIRED. The delivered image (sha256 PASSTHRU_SHA256 below) was
#             built from commit bc428da; the shim and web sources have changed
#             since, so rebuilding would produce different bytes. Refused so
#             it can never overwrite the delivered file; check out bc428da to
#             reproduce it.
#   passthru_diag  TEST build: the pass-through shim with frame-hook timing,
#             the pass-through page, the read-only snapshot CGI and a
#             diagnostics/debug-ZIP panel on the stock main page, which also
#             switches off the stock automatic log upload, online version
#             query and usage telemetry (NEXT_TEST_PLAN.md). Written to its own
#             directory (DIAG_DIR) with release metadata; refuses to replace
#             an existing different image unless --replace is given.
#   release   0.2 TEST release (MAINPAGE_PLAN.md): the same shim; a new main
#             page with settings, presets, recovery, debug ZIP and a built-in
#             updater replaces the stock page and its assets; the stock
#             upload/install/reset CGIs move to /usr/lib/cpthru behind locking
#             gateways; a release manifest goes into cpthru-release.json and
#             the rootfs padding. Written to RELEASE_DIR/<version>/.
#
# Usage: build_fw.py tier1|passthru_diag|release [--replace]   build + verify
#        build_fw.py --selftest          repack untouched stock, expect identical
#        build_fw.py --patch-index SHTTPD_DIR OUT
#                     check the stock page inventory in SHTTPD_DIR and write the
#                     passthru_diag main page to OUT (browser tests; no firmware)
#
# Integrity (plan R11): the stock rootfs is extracted fresh from the
# md5-verified stock .swu on every run, and the rebuilt image is extracted
# again and compared to it file by file (sha256 + mode/owner/size/mtime/link),
# allowing only the variant's declared changes.
import datetime, hashlib, json, os, re, shutil, subprocess, sys

FW = os.path.expanduser("~/models/staging/carlinkit-ultra6-fw")
STOCK_SWU = f"{FW}/v5_202610121756.swu"
STOCK_MD5 = "8cda8cf273d665c80b2a4b217b9bdf44"
WORK = f"{FW}/build"
DIAG_DIR = f"{FW}/diag"
PASSTHRU_SWU = f"{WORK}/v5_202610121756_passthru.swu"
PASSTHRU_SHA256 = "c406489a8653a851597b0ec9109abda73a9fffd8b71a910b88d8e8ba5c218ade"
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
DIAG_WEB_FILES = dict(WEB_FILES, **{
    f"{WEB}/cpthru_diag.js": ("cpthru_diag.js", 0o644),
    f"{WEB}/cgi-bin/cpthru_snapshot.cgi": ("cgi-bin/cpthru_snapshot.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_json.awk": ("cgi-bin/cpthru_json.awk", 0o644),  # status CGI's JSON check
})
RELEASE_VERSION = "0.2.0-test.1"
RELEASE_LABEL = "Main page + updater test " + RELEASE_VERSION
RELEASE_DIR = f"{FW}/release"
RELEASE_ASSET = f"carlinkit-ultra6-{RELEASE_VERSION}.swu"
MANIFEST_PATH = f"{WEB}/cpthru-release.json"
MANIFEST_MAGIC = b"CPTHRU-RELEASE\n"
# Stock page and its assets, replaced by the new main page.
REMOVED = [f"{WEB}/{n}" for n in ("index.css", "encapsulation.js", "activation.js", "language.json", "qrcode.min.js",
                                  "md5.js", "mdm5.js", "01.png", "jquery.min.js", "crypto-js.js")]
REPLACED = {f"{WEB}/index.html": "index.html"}
RELEASE_WEB_FILES = {
    f"{WEB}/cpthru.html": ("cpthru_redirect.html", 0o644),
    f"{WEB}/cpthru_fw.js": ("cpthru_fw.js", 0o644),
    f"{WEB}/cpthru_main.js": ("cpthru_main.js", 0o644),
    f"{WEB}/cpthru_diag.js": ("cpthru_diag.js", 0o644),
    f"{WEB}/cgi-bin/cpthru_status.cgi": ("cgi-bin/cpthru_status.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_set.cgi": ("cgi-bin/cpthru_set.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_settings.cgi": ("cgi-bin/cpthru_settings.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_update.cgi": ("cgi-bin/cpthru_update.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_snapshot.cgi": ("cgi-bin/cpthru_snapshot.cgi", 0o744),
    f"{WEB}/cgi-bin/cpthru_json.awk": ("cgi-bin/cpthru_json.awk", 0o644),
}
# Stock mutation CGIs: moved out of the web root, same bytes and mode, and
# replaced in cgi-bin by gateways of the same name.
GATED = ["downfile.cgi", "submition.cgi", "factoryreset.cgi"]
GATE_DIR = "usr/lib/cpthru"
INDEX_ANCHOR = '\t<div class="cpbone">\n\t\t<h1 id="Config"></h1>\n'
# The diagnostics script goes after every stock script (so the stock
# functions exist) and runs before window.onload fires.
SCRIPT_ANCHOR = '<script src="/activation.js"></script>\n'
DIAG_SCRIPT = '<script src="/cpthru_diag.js"></script>\n'
# Stock functions the diagnostics page neutralizes: defining file, and the
# exact number of times each name appears in index.html (definition, calls,
# comments, console strings; the version-query URL also contains its name).
NEUTRALIZE = {"GetZipFile": ("index.html", 4), "UploadZipFile": ("index.html", 5),
              "queryDeviceVersion": ("index.html", 5), "cahudsoejhu": ("encapsulation.js", 2)}
ONLOAD_CALLS = ["queryDeviceVersion()", "cahudsoejhu()", "setInterval(cahudsoejhu, 60000)", "GetZipFile()"]
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


def check_stock_web(shttpd):
    """Inventory of the stock functions the diagnostics page neutralizes: each
    defined exactly once, in the expected file; the exact occurrence counts in
    index.html; no other stock script mentions them; and the stock onload makes
    the four automatic calls. Fails closed on any difference."""
    files = {"index.html": open(f"{shttpd}/index.html", encoding="utf-8").read()}
    for n in sorted(os.listdir(shttpd)):
        if n.endswith(".js") and os.path.isfile(f"{shttpd}/{n}"):
            files[n] = open(f"{shttpd}/{n}", encoding="utf-8", errors="replace").read()
    assert "cpthru_diag.js" not in files, "stock web dir already has cpthru_diag.js"
    for name, (where, count) in NEUTRALIZE.items():
        defs = {f: len(re.findall(r"\bfunction\s+" + name + r"\s*\(", s)) for f, s in files.items()}
        assert defs[where] == 1 and sum(defs.values()) == 1, f"{name}: definitions {defs}"
        idx = len(re.findall(r"\b" + name + r"\b", files["index.html"]))
        assert idx == count, f"{name}: {idx} mentions in index.html, expected {count}"
        others = {f: len(re.findall(r"\b" + name + r"\b", s)) for f, s in files.items()
                  if f not in ("index.html", where)}
        assert not any(others.values()), f"{name} also mentioned in {others}"
        if where != "index.html":
            assert len(re.findall(r"\b" + name + r"\b", files[where])) == 1, f"{name}: {where} mentions"
    s = files["index.html"]
    assert s.count("window.onload = function") == 1, "stock onload not found exactly once"
    body = s[s.index("window.onload = function"):s.index('xmlhttp.open("GET", "/cgi-bin/getversion.cgi"')]
    for call in ONLOAD_CALLS:
        assert len(re.findall(r"(?m)^\s*" + re.escape(call) + r"\s*$", body)) == 1, f"onload call {call!r}"
    assert s.count(SCRIPT_ANCHOR) == 1 and s.count(INDEX_ANCHOR) == 1, "index.html anchors"
    assert s.index(SCRIPT_ANCHOR) > s.index("window.onload = function"), "script anchor before onload"
    return s


def patch_index_diag(s):
    """Stock index.html -> diagnostics main page; everything else identical."""
    panel = open(f"{HERE}/web/index_diag.html", encoding="utf-8").read()
    s2 = s.replace(INDEX_ANCHOR, panel + INDEX_ANCHOR, 1).replace(SCRIPT_ANCHOR, SCRIPT_ANCHOR + DIAG_SCRIPT, 1)
    assert s2.count(DIAG_SCRIPT) == 1 and s2.count(panel) == 1
    assert s2.replace(panel, "", 1).replace(DIAG_SCRIPT, "", 1) == s, "only the two insertions changed"
    return s2


def apply_passthru_core(tree):
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
    return {"usr/lib", "usr/lib/libcpthru.so", S11}, build_id


def apply_passthru(tree, diag=False):
    _, build_id = apply_passthru_core(tree)
    web_files = DIAG_WEB_FILES if diag else WEB_FILES
    stock_index = check_stock_web(f"{tree}/{WEB}") if diag else None
    for dst, (src, mode) in web_files.items():
        assert not os.path.lexists(f"{tree}/{dst}"), f"{dst} already exists in stock"
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

    def add_diag():
        raw = open(idx, "rb").read()
        assert raw.decode("utf-8") == stock_index
        open(idx, "wb").write(patch_index_diag(stock_index).encode("utf-8"))
    keep_time(idx, add_diag if diag else add_link)
    print("added the pass-through page, its CGIs, and " +
          ("the diagnostics panel + script in index.html" if diag else "a link in index.html"))
    return ({"usr/lib", "usr/lib/libcpthru.so", S11, f"{WEB}/index.html", WEB, f"{WEB}/cgi-bin"}
            | set(web_files)), build_id


def file_digest(p):
    if os.path.islink(p):
        return "link:" + os.readlink(p)
    if os.path.isdir(p):
        return "dir"
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def release_id(tree, stock_tree, version):
    """MAINPAGE_PLAN.md MP-06: hash of the version plus every rootfs entry that
    differs from stock (content/link/dir + mode), and every removed stock path,
    excluding the generated manifest itself."""
    def entries(t):
        out = {}
        for dp, dns, fns in os.walk(t):
            for n in dns + fns:
                p = os.path.join(dp, n)
                rel = os.path.relpath(p, t)
                out[rel] = (file_digest(p), oct(os.lstat(p).st_mode))
        return out
    a, b = entries(stock_tree), entries(tree)
    b.pop(MANIFEST_PATH, None)
    lines = []
    for path in sorted(set(a) | set(b)):
        if path not in b:
            lines.append(f"{path}\tDELETED")
        elif a.get(path) != b[path]:
            lines.append(f"{path}\t{b[path][0]}\t{b[path][1]}")
    text = f"carlinkit-ultra6-release/1\nversion={version}\n" + "".join(l + "\n" for l in lines)
    return hashlib.sha256(text.encode()).hexdigest()[:12], len(lines)


def apply_release(tree, stock_tree):
    allowed, build_id = apply_passthru_core(tree)
    w = f"{tree}/{WEB}"
    # The stock page and its assets go; nothing that stays may refer to them.
    for rel in REMOVED:
        assert os.path.isfile(f"{tree}/{rel}"), f"{rel} missing in stock"
        keep_time(os.path.dirname(f"{tree}/{rel}"), lambda: os.remove(f"{tree}/{rel}"))
    for dst, src in REPLACED.items():
        assert os.path.isfile(f"{tree}/{dst}")
        keep_time(f"{tree}/{dst}", lambda: shutil.copy(f"{HERE}/web/{src}", f"{tree}/{dst}"))
    for dst, (src, mode) in RELEASE_WEB_FILES.items():
        assert not os.path.lexists(f"{tree}/{dst}"), f"{dst} already exists in stock"
        keep_time(os.path.dirname(f"{tree}/{dst}"), lambda: shutil.copy(f"{HERE}/web/{src}", f"{tree}/{dst}"))
        os.chmod(f"{tree}/{dst}", mode)
    gd = f"{tree}/{GATE_DIR}"
    assert not os.path.lexists(gd)
    keep_time(f"{tree}/usr/lib", lambda: os.makedirs(gd))
    os.chmod(gd, 0o755)
    for n in GATED:
        src = f"{w}/cgi-bin/{n}"
        st = os.stat(src)
        shutil.copy2(src, f"{gd}/{n}")
        os.chmod(f"{gd}/{n}", st.st_mode & 0o7777)
        assert open(f"{gd}/{n}", "rb").read()[:4] == b"\x7fELF"
        keep_time(src, lambda: shutil.copy(f"{HERE}/web/cgi-bin/{n}", src))
        os.chmod(src, 0o744)
    remaining = {}
    for dp, dns, fns in os.walk(w):
        for n in fns:
            if n.endswith((".html", ".js", ".cgi", ".awk")):
                remaining[os.path.relpath(os.path.join(dp, n), w)] = open(os.path.join(dp, n), "rb").read()
    for rel in REMOVED:
        name = os.path.basename(rel).encode()
        users = [f for f, b in remaining.items() if name in b]
        assert not users, f"removed {rel} is still referenced by {users}"
    for ref in re.findall(rb'src="/?([A-Za-z0-9_.-]+)"', remaining["index.html"]):
        assert os.path.isfile(f"{w}/{ref.decode()}"), f"index.html loads missing {ref}"
    rid, n = release_id(tree, stock_tree, RELEASE_VERSION)
    manifest = {"format": "carlinkit-ultra6-release", "schema": 1, "version": RELEASE_VERSION, "release_id": rid,
                "shim_build": build_id.split("=", 1)[1], "label": RELEASE_LABEL, "base": "v5_202610121756"}
    text = json.dumps(manifest, separators=(",", ":"))
    open(f"{tree}/{MANIFEST_PATH}", "w").write(text + "\n")
    os.chmod(f"{tree}/{MANIFEST_PATH}", 0o644)
    print(f"release {RELEASE_VERSION}: release_id {rid} over {n} changed paths; removed {len(REMOVED)} stock assets; "
          f"gated {', '.join(GATED)}")
    allowed |= ({f"{WEB}/index.html", WEB, f"{WEB}/cgi-bin", MANIFEST_PATH, "usr/lib", GATE_DIR}
                | set(REMOVED) | set(RELEASE_WEB_FILES) | {f"{WEB}/cgi-bin/{n}" for n in GATED}
                | {f"{GATE_DIR}/{n}" for n in GATED})
    return allowed, build_id, manifest


def write_manifest_padding(img, used, manifest, stock_len):
    """Release manifest at the first 4 KiB boundary after the squashfs data,
    inside the image's zero padding (squashfs never reads past bytes_used)."""
    blob = MANIFEST_MAGIC + json.dumps(manifest, separators=(",", ":")).encode() + b"\n"
    at = -(-used // 4096) * 4096
    data = bytearray(open(img, "rb").read())
    assert not any(data[used:]), "padding not zero"
    end = at + len(blob)
    while len(data) < end:
        data.extend(b"\0" * PAD)
    data[at:end] = blob
    assert len(data) <= stock_len, "rootfs with manifest is bigger than stock"
    # Same image length as stock (and as the installed test builds), zero padded.
    data.extend(b"\0" * (stock_len - len(data)))
    open(img, "wb").write(bytes(data))
    return at


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check_delivered():
    """The delivered pass-through image must stay byte-identical."""
    if os.path.exists(PASSTHRU_SWU):
        got = sha256(PASSTHRU_SWU)
        assert got == PASSTHRU_SHA256, f"delivered pass-through image changed: {got}"
        print(f"delivered pass-through image unchanged: sha256 {got}")
    else:
        print(f"note: delivered pass-through image not present at {PASSTHRU_SWU}")


def build(variant, items, total_len, replace=False):
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
    elif variant == "release":
        allowed, tag, manifest = apply_release(tree, stock_tree)
    else:
        allowed, tag = apply_passthru(tree, diag=variant == "passthru_diag")

    img = f"{WORK}/rootfs.{variant}.img"
    used = mksquashfs(tree, img, stock_img)
    stock_len = os.path.getsize(stock_img)
    if variant == "release":
        at = write_manifest_padding(img, used, manifest, stock_len)
        print(f"release manifest in rootfs padding at {at:#x}")
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
    out_dir = (DIAG_DIR if variant == "passthru_diag" else f"{RELEASE_DIR}/{RELEASE_VERSION}" if variant == "release"
               else WORK)
    out = f"{out_dir}/{RELEASE_ASSET}" if variant == "release" else f"{out_dir}/v5_202610121756_{variant}.swu"
    os.makedirs(out_dir, exist_ok=True)
    # Write beside the output first; an existing different image is never
    # touched unless replacing is explicitly allowed for this variant.
    tmp = out + ".new"
    write_cpio(tmp, new_items, total_len)

    # Read back what we wrote and check it the way swupdate would.
    back, _ = read_cpio(tmp)
    assert [n for f, n, d in back] == names
    listed = dict(l.split()[::-1] for l in
                  next(d for f, n, d in back if n == "cpio_item_md5").decode().splitlines())
    for f, n, d in back:
        if n in listed:
            assert hashlib.md5(d).hexdigest() == listed[n], f"md5 mismatch {n}"
        assert f[12] == sum(d) & 0xffffffff
        if n not in ("rootfs", "cpio_item_md5"):
            assert d == next(x for g, m, x in items if m == n), f"{n} changed"
    unchanged = [n for f, n, d in back if n not in ("rootfs", "cpio_item_md5")]
    if os.path.exists(out) and open(out, "rb").read() != open(tmp, "rb").read():
        if not (replace and variant in ("passthru_diag", "release")):
            os.remove(tmp)
            raise SystemExit(f"REFUSED: {out} exists with different bytes (sha256 {sha256(out)}); kept it. "
                             + ("Pass --replace to replace this unpublished test image." if variant == "passthru_diag"
                                else "Move it away deliberately first."))
        print(f"replacing previous test image {out} (sha256 {sha256(out)})")
    os.replace(tmp, out)
    print(f"wrote {out}\n  md5 {md5(out)}  size {os.path.getsize(out)}" + (f"\n  {tag}" if tag else ""))
    info_extra = {"manifest": manifest} if variant == "release" else {}
    return {**info_extra, "file": out, "size": os.path.getsize(out), "md5": md5(out), "sha256": sha256(out),
            "build_id": tag.split("=", 1)[1] if tag else None, "changed_rootfs_entries": sorted(changed),
            "byte_identical_payloads": unchanged, "rootfs_bytes_used": used,
            "rootfs_padded": len(rootfs), "stock_rootfs_padded": stock_len}


def write_release_metadata(info, variant="passthru_diag"):
    meta = dict(info)
    if variant == "release":
        meta.update({
            "name": os.path.basename(info["file"]), "variant": "release", "version": RELEASE_VERSION,
            "kind": "TEST release: main page, settings, presets, recovery, debug ZIP and built-in updater; video unchanged",
            "staged_name": "cpthru.swu",
            "device": "Carlinkit Mini Ultra 6 (Allwinner v553), stock config platform=v553 custom=yunlianAm",
            "base": {"file": os.path.basename(STOCK_SWU), "md5": STOCK_MD5, "sha256": sha256(STOCK_SWU),
                     "version": "202610121756C"},
            "known_limitation": "pass-through measured at about 8 fps on the owner's car; unchanged in this release",
            "built_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        path = f"{RELEASE_DIR}/{RELEASE_VERSION}/{RELEASE_ASSET[:-4]}.json"
        with open(path + ".new", "w") as f:
            json.dump(meta, f, indent=2)
            f.write("\n")
        os.replace(path + ".new", path)
        print(f"wrote {path}")
        return
    meta.update({
        "name": os.path.basename(info["file"]), "variant": "passthru_diag",
        "kind": "TEST build for measurements and a debug ZIP; not a performance fix",
        "device": "Carlinkit Mini Ultra 6 (Allwinner v553), stock config platform=v553 custom=yunlianAm",
        "base": {"file": os.path.basename(STOCK_SWU), "md5": STOCK_MD5, "sha256": sha256(STOCK_SWU),
                 "version": "202610121756C"},
        "known_limitation": "pass-through measured at about 8 fps on the owner's car; this build only measures it",
        "built_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    path = f"{DIAG_DIR}/v5_202610121756_passthru_diag.json"
    tmp = path + ".new"
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"wrote {path}")


def main():
    args = sys.argv[1:]
    if args[:1] == ["--patch-index"]:
        assert len(args) == 3, "usage: build_fw.py --patch-index SHTTPD_DIR OUT"
        s = check_stock_web(args[1])
        out = patch_index_diag(s)
        with open(args[2], "wb") as f:
            f.write(out.encode("utf-8"))
        print(f"stock page inventory ok; wrote the diagnostics main page to {args[2]}")
        return
    replace = "--replace" in args
    args = [a for a in args if a != "--replace"]
    variant = {"--selftest": "selftest"}.get(args[0], args[0]) if args else ""
    if variant == "passthru":
        raise SystemExit("passthru is retired: the delivered image (sha256 " + PASSTHRU_SHA256 + ") was built "
                         "from commit bc428da and is kept as is. Build passthru_diag, or check out bc428da.")
    assert variant in ("tier1", "passthru_diag", "release", "selftest"), \
        "usage: build_fw.py tier1|passthru_diag|release [--replace] | --selftest | --patch-index SHTTPD_DIR OUT"
    assert md5(STOCK_SWU) == STOCK_MD5, "stock .swu changed on disk"
    check_delivered()
    os.makedirs(WORK, exist_ok=True)
    items, total_len = read_cpio(STOCK_SWU)
    info = build(variant, items, total_len, replace)
    if variant in ("passthru_diag", "release"):
        write_release_metadata(info, variant)
    check_delivered()


if __name__ == "__main__":
    main()
