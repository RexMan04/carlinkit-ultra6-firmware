#!/usr/bin/env python3
"""Mutating CGI fixtures inside a real filesystem namespace (NEXT_TEST_PLAN.md
Verification 2-3). Fails closed if the isolation can't be set up; never falls
back to qemu -L with host paths.

One bubblewrap sandbox (user/pid/net/ipc/uts namespaces, its own /proc) whose
root is a scratch directory. The stock rootfs's bin, sbin, lib, usr and etc
are bound read-only; /mnt/UDISK and /tmp are scratch. ARM programs run
through the static qemu-arm inside the sandbox. External commands the CGIs
call are wrappers that run the DEVICE busybox applet through qemu (a host
bash, bound read-only at /hostbin/bash, only interprets the wrapper lines).
getprop is a fixture (no property service in the sandbox), and a fake
"sdDongle" process provides real per-thread CPU counters.

Runs:
  1. the real stock /etc/shttpd/cgi-bin/minizip.cgi?logID=local& on fixture
     logs: response bytes split at the header, ZIP entries byte-identical to
     the fixture, temporary /mnt/UDISK/local.zip removed afterwards;
  2. cpthru_status.cgi with timing files: missing, valid, oversize, two kinds
     of malformed;
  3. cpthru_snapshot.cgi: config.ini from the stock rootfs, nosave=1,
     leftover ZIP, sdDongle threads over the 1 s sample; a hung getprop; no
     sdDongle.
Host /mnt/UDISK and /tmp/cpthru.* / /tmp/cpthru-* are checked unchanged.

Usage: python3 -I tests/ns_test.py [--rootfs DIR] [--qemu FILE] [--out DIR]
Writes OUT/ns-results.json and OUT/stock-logs-fixture.zip (default OUT:
~/models/staging/carlinkit-ultra6-fw/review/diag-tests).
"""
import glob, hashlib, io, json, os, shutil, subprocess, sys, tempfile, time, zipfile

HOME = os.path.expanduser("~")
FW = f"{HOME}/models/staging/carlinkit-ultra6-fw"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def arg(name, default):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


ROOTFS = arg("--rootfs", f"{FW}/tier1/rootfs_stock_exact")
QEMU = arg("--qemu", f"{HOME}/tools/qemu-user/qemu-arm-static")
OUT = arg("--out", f"{FW}/review/diag-tests")
# Only applets the adapter's busybox really has (it has no wc or head).
APPLETS = ["cat", "awk", "tr", "ls", "sed", "cut", "df", "du", "sleep", "find", "readlink"]
LOGS = {"mnt/UDISK/log/sdDongle_0.log": b"cpthru: timing seq=1 gen=1\n" + bytes([0, 255, 10]) * 50,
        "mnt/UDISK/log/nested/binary.log": bytes(range(256)) * 4}
LEFTOVER = 1234
# Exactly the shape publish_timing() writes, including the spaces in
# info_source and null info values.
_ST = ',"{}":{{"n":40,"avg":2.5,"max":9,"sum":100}}'
_WIN = ('{"seq":1,"gen":3,"t0":195000,"len_ms":5003,"calls":41,"first":1,"v_ok":40,"v_fail":0,"v_gate":1,'
        '"c_ok":1,"c_fail":0,"c_gate":0,"slow16":2,"slow33":1,"slow100":0'
        + "".join(_ST.format(k) for k in ["cb", "iv", "gap", "lk", "par", "plk", "vsend", "csend", "orig", "res", "pub"]) + "}")
TIMING_PRODUCTION = (
    '{"v":1,"build":"1b93a4b1163f","up_ms":200000,"mono_ms":199000,"session_mono_ms":150000,"stock_sent":0,'
    '"stock_suppressed":12,"info_source":"last value returned by sd_get_info_int","info":{'
    '"VIDEO_WIDTH":{"calls":2,"last_mono_ms":150100,"stock":800,"returned":1920,"override":1},'
    '"VIDEO_HEIGHT":{"calls":2,"last_mono_ms":150100,"stock":480,"returned":720,"override":1},'
    '"VIDEO_FPS":{"calls":0,"last_mono_ms":null,"stock":null,"returned":null,"override":null}},'
    '"available":1,"clock_res_ms":1,"window_ms":5000,"ring_max":24,"gen":3,"seq":1,"windows":[' + _WIN + ']}')
_empty = json.loads(TIMING_PRODUCTION)
_empty.update(up_ms=5000, mono_ms=4900, gen=1, seq=0, windows=[])
TIMING_VALID = json.dumps(_empty, separators=(",", ":"))
_empty.update(available=0, mono_ms=None, session_mono_ms=None, gen=0)
TIMING_UNAVAILABLE = json.dumps(_empty, separators=(",", ":"))
TIMING_CASES = {
    "missing": None,
    "valid": TIMING_VALID,
    "production": TIMING_PRODUCTION,
    "unavailable": TIMING_UNAVAILABLE,
    "oversize": '{"v":1,"pad":"' + "0" * 98304 + '"}',
    "badchars": '{"v":1,"x":"</script><b>"}',
    "truncated": '{"v":1,"windows":[{"seq":1,',
    "trailing": '{"v":1,}',
    "badvalue": '{"v":1,"a":[1,,2],"b":{"c":}}',
    "twovalues": '{"v":1}{"v":1}',
    "leadingzero": '{"v":1,"n":01}',
    "nullwindow": '{"v":1,"available":1,"windows":[null]}',
    "fullnullwindow": TIMING_PRODUCTION.replace(_WIN, "null"),
    "missingmetadata": '{"v":1,"available":1,"clock_res_ms":1,"window_ms":5000,"ring_max":24,"gen":1,"seq":0,"windows":[]}',
    "nullstat": TIMING_PRODUCTION.replace(_ST.format("cb"), ',"cb":null'),
}


def fail(msg):
    print("FAIL " + msg)
    sys.exit(1)


def host_state():
    """What must not change on the host."""
    st = {"/mnt/UDISK": None}
    if os.path.lexists("/mnt/UDISK"):
        items = []
        for dp, dns, fns in os.walk("/mnt/UDISK"):
            for n in sorted(dns + fns):
                p = os.path.join(dp, n)
                try:
                    s = os.lstat(p)
                    items.append((p, s.st_size, s.st_mtime_ns))
                except OSError as e:
                    items.append((p, "err", str(e)))
        st["/mnt/UDISK"] = items
    for p in sorted(glob.glob("/tmp/cpthru.*") + glob.glob("/tmp/cpthru-*")):
        try:
            s = os.lstat(p)
            digest = hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.isfile(p) else "-"
            st[p] = (s.st_size, s.st_mtime_ns, digest)
        except OSError as e:
            st[p] = ("err", str(e))
    return st


def write(path, data, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)


def driver():
    """Host-bash driver run inside the sandbox; only bash builtins, the
    wrappers in /w and /qemu-arm-static."""
    q = "/qemu-arm-static"
    lines = [
        "set -u",
        "echo sentinel-seen=$( [ -f /tmp/sentinel ] && echo yes || echo no ) > /out/env.txt",
        "echo host-home-visible=$( [ -e " + HOME + " ] && echo yes || echo no ) >> /out/env.txt",
        # 1. stock minizip
        "cd /etc/shttpd/cgi-bin",
        f"QUERY_STRING='logID=local&' REQUEST_METHOD=GET {q} ./minizip.cgi > /out/minizip.raw 2> /out/minizip.err",
        "echo $? > /out/minizip.rc",
        "cd /",
        "for f in /mnt/UDISK/*; do echo \"$f\"; done > /out/udisk_after_minizip.txt",
        # 2. status with timing fixtures
    ]
    for case, text in TIMING_CASES.items():
        if text is None:
            lines.append(": > /dev/null; [ -e /tmp/cpthru.timing ] && echo stray > /out/stray")
        else:
            lines.append(f"printf '%s' \"$(</fixtures/timing_{case}.json)\" > /tmp/cpthru.timing")
        lines.append(f"QUERY_STRING= {q} /bin/sh /cgi/cpthru_status.cgi > /out/status_{case}.txt 2> /out/status_{case}.err")
    lines += [
        # 3. snapshot: leftover ZIP, sdDongle running
        f"printf '%{LEFTOVER}s' x > /mnt/UDISK/local.zip",
        "/w/sdDongle 20 & sd=$!",
        "t0=$SECONDS",
        f"QUERY_STRING= {q} /bin/sh /cgi/cpthru_snapshot.cgi > /out/snapshot.txt 2> /out/snapshot.err",
        "echo $((SECONDS - t0)) > /out/snapshot.secs",
        "t0=$SECONDS",
        f"SLOWPROP=persist.console.log.index QUERY_STRING= {q} /bin/sh /cgi/cpthru_snapshot.cgi > /out/snapshot_slow.txt 2> /out/snapshot_slow.err",
        "echo $((SECONDS - t0)) > /out/snapshot_slow.secs",
        "kill $sd; wait $sd 2>/dev/null",
        f"QUERY_STRING= {q} /bin/sh /cgi/cpthru_snapshot.cgi > /out/snapshot_nosd.txt 2> /out/snapshot_nosd.err",
        "echo done > /out/done",
    ]
    return "\n".join(lines) + "\n"


def body(raw):
    """CGI output -> (header text, body bytes) at the first blank line."""
    for sep in (b"\r\n\r\n", b"\n\n"):
        i = raw.find(sep)
        if i >= 0:
            return raw[:i].decode("latin-1"), raw[i + len(sep):]
    return None, raw


def main():
    checks, bad = [], 0

    def check(ok, what, detail=""):
        nonlocal bad
        checks.append({"check": what, "ok": bool(ok), "detail": detail})
        bad += not ok
        print(("ok   " if ok else "FAIL ") + what + (f": {detail}" if detail and not ok else ""))

    bwrap = shutil.which("bwrap")
    bash = os.path.realpath("/usr/bin/bash")
    if not bwrap:
        fail("isolation unavailable: bwrap not found (refusing to run the mutating fixtures without it)")
    for p in (QEMU, f"{ROOTFS}/bin/busybox", f"{ROOTFS}/etc/shttpd/cgi-bin/minizip.cgi", bash, "/usr/lib64"):
        if not os.path.exists(p):
            fail(f"missing {p}")
    os.makedirs(OUT, exist_ok=True)
    before = host_state()
    scratch = tempfile.mkdtemp(prefix="cpthru-ns-", dir=OUT)
    try:
        for d in ("tmp", "out", "w", "cgi", "props", "fixtures", "mnt/UDISK"):
            os.makedirs(f"{scratch}/{d}", exist_ok=True)
        os.chmod(f"{scratch}/tmp", 0o1777)
        write(f"{scratch}/tmp/sentinel", "x")
        for rel, data in LOGS.items():
            write(f"{scratch}/{rel}", data)
        for case, text in TIMING_CASES.items():
            if text is not None:
                write(f"{scratch}/fixtures/timing_{case}.json", text)
        for n in ("cpthru_status.cgi", "cpthru_snapshot.cgi", "cpthru_set.cgi", "cpthru_json.awk"):
            shutil.copy(f"{REPO}/web/cgi-bin/{n}", f"{scratch}/cgi/{n}")
        for a in APPLETS:
            write(f"{scratch}/w/{a}", f'#!/hostbin/bash\nexec /qemu-arm-static /bin/busybox {a} "$@"\n', 0o755)
        write(f"{scratch}/w/getprop", '#!/hostbin/bash\n'
              'case "$1" in "${SLOWPROP:-}") exec /qemu-arm-static /bin/busybox sleep 10 ;; esac\n'
              '[ -f "/props/$1" ] && printf "%s\\n" "$(</props/$1)"\nexit 0\n', 0o755)
        write(f"{scratch}/w/sdDongle", '#!/hostbin/bash\nend=$((SECONDS + ${1:-15}))\n'
              'while [ $SECONDS -lt $end ]; do :; done\n', 0o755)
        write(f"{scratch}/props/persist.console.log.nosave", "1")
        write(f"{scratch}/props/persist.cpthru.off", "0")
        write(f"{scratch}/drv.sh", driver(), 0o755)

        cmd = [bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
               "--bind", scratch, "/"]
        for d in ("bin", "sbin", "lib", "usr", "etc"):
            if os.path.isdir(f"{ROOTFS}/{d}"):
                cmd += ["--ro-bind", f"{ROOTFS}/{d}", f"/{d}"]
        cmd += ["--ro-bind", "/usr/lib64", "/lib64", "--ro-bind", bash, "/hostbin/bash",
                "--ro-bind", QEMU, "/qemu-arm-static", "--proc", "/proc", "--dev", "/dev",
                "--setenv", "PATH", "/w", "--setenv", "HOME", "/tmp", "--chdir", "/",
                "/hostbin/bash", "/drv.sh"]
        t0 = time.monotonic()
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            fail("sandbox run timed out after 180 s")
        o = f"{scratch}/out"
        if r.returncode != 0 and not os.path.exists(f"{o}/env.txt"):
            fail(f"isolation unavailable: bwrap exited {r.returncode}: {r.stderr.strip()[:400]}")
        check(os.path.exists(f"{o}/done"), "driver completed", r.stderr[-400:])
        env = open(f"{o}/env.txt").read()
        check("sentinel-seen=yes" in env and "host-home-visible=no" in env, "sandbox sees scratch /tmp, not the host", env)

        # 1. minizip
        raw = open(f"{o}/minizip.raw", "rb").read()
        head, zbytes = body(raw)
        check(head is not None and "content-type" in head.lower(), "minizip CGI header", repr(head))
        try:
            z = zipfile.ZipFile(io.BytesIO(zbytes))
            names = [n for n in z.namelist() if not n.endswith("/")]
            check(z.testzip() is None, "stock ZIP CRCs (python zipfile)")
            for rel, data in LOGS.items():
                hits = [n for n in names if n.lstrip("/").endswith(rel.split("mnt/UDISK/log/", 1)[1])]
                check(len(hits) == 1 and z.read(hits[0]) == data, f"stock ZIP holds {rel} byte-identical", str(names))
            check(len(names) == len(LOGS), "stock ZIP has only the fixture logs", str(names))
        except zipfile.BadZipFile as e:
            check(False, "stock minizip output is a ZIP", f"{e}; {len(zbytes)} bytes; stderr {open(f'{o}/minizip.err').read()[:300]}")
        after = open(f"{o}/udisk_after_minizip.txt").read().split()
        check("/mnt/UDISK/local.zip" not in after, "minizip removed its temporary ZIP", str(after))
        fixture = f"{OUT}/stock-logs-fixture.zip"
        if zbytes[:2] == b"PK":
            write(fixture, zbytes)

        # 2. status timing cases
        for case, text in TIMING_CASES.items():
            raw = open(f"{o}/status_{case}.txt", "rb").read()
            head, js = body(raw)
            try:
                d = json.loads(js)
            except ValueError as e:
                check(False, f"status JSON valid with timing {case}", f"{e}: {js[:200]!r}")
                continue
            if case in ("valid", "production", "unavailable"):
                check(d["timing"] == json.loads(text) and d["timing_error"] is None, f"status passes a {case} timing file",
                      str(d["timing_error"]))
            else:
                want = {"missing": "missing", "oversize": "oversize"}.get(case, "malformed")
                check(d["timing"] is None and d["timing_error"] == want, f"status timing {case} -> null/{want}",
                      f"{d['timing_error']}")
        check(not os.path.exists(f"{o}/stray"), "no timing file before the missing case")

        # 3. snapshot
        cfg = {}
        for line in open(f"{ROOTFS}/etc/config.ini"):
            k, _, v = line.strip().partition("=")
            if k in ("platform", "custom", "version") and k not in cfg:
                cfg[k] = v
        snaps = {}
        for name in ("snapshot", "snapshot_slow", "snapshot_nosd"):
            head, js = body(open(f"{o}/{name}.txt", "rb").read())
            try:
                snaps[name] = json.loads(js)
                check(True, f"{name} JSON valid")
            except ValueError as e:
                check(False, f"{name} JSON valid", f"{e}: {js[:300]!r} err {open(f'{o}/{name}.err').read()[:300]}")
        s = snaps.get("snapshot")
        if s:
            check(s["config"] == cfg, "config.ini platform/custom/version", f"{s['config']} vs {cfg}")
            check(s["nosave"] == "1" and s["props"]["persist.cpthru.off"] == "0" and
                  s["props"]["persist.suding.wl.audio.latency"] == "", "allowlisted settings; unset preserved as \"\"",
                  str(s["props"]))
            u = s["udisk"]
            logsize = sum(len(v) for v in LOGS.values())
            check(isinstance(u["free_bytes"], int) and u["free_bytes"] > 0, "device df reports free space", str(u))
            check(isinstance(u["log_bytes"], int) and u["log_bytes"] >= logsize, "device du reports the log directory", str(u))
            check(u["leftover_zip"] is True and u["leftover_zip_bytes"] == LEFTOVER, "leftover local.zip reported", str(u))
            sd = s["sdDongle"]
            check(sd and sd["same_process"] and sd["threads"] and
                  sum(t["utime"] + t["stime"] for t in sd["threads"]) > 0 and sd["threads"][0]["name"] == "sdDongle",
                  "sdDongle thread CPU measured over the sample", str(sd))
            check(s["sample_up_cs"][1] - s["sample_up_cs"][0] >= 90, "two samples about 1 s apart", str(s["sample_up_cs"]))
            check(any(c["name"] == "cpu" and c["total"] > 0 for c in s["cpu"]), "CPU tick deltas")
            check(int(open(f"{o}/snapshot.secs").read()) <= 15, "snapshot time bounded")
        s = snaps.get("snapshot_slow")
        if s:
            secs = int(open(f"{o}/snapshot_slow.secs").read())
            check(s["props"]["persist.console.log.index"] is None and "prop:persist.console.log.index" in s["missing"]
                  and secs <= 15, f"hung getprop bounded by the watchdog ({secs} s)", str(s["missing"]))
        s = snaps.get("snapshot_nosd")
        if s:
            check(s["sdDongle"] is None and "sdDongle" in s["missing"], "no sdDongle -> null + missing")
        elapsed = time.monotonic() - t0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    after = host_state()
    check(after == before, "host /mnt/UDISK and /tmp/cpthru.* unchanged",
          json.dumps({k: (before.get(k), after.get(k)) for k in set(before) | set(after) if before.get(k) != after.get(k)})[:400])
    result = {"status": "passed" if not bad else "failed", "isolation": "bwrap --unshare-all, scratch root, own /proc",
              "rootfs": ROOTFS, "qemu": QEMU, "seconds": round(elapsed, 1), "checks": checks}
    fx = f"{OUT}/stock-logs-fixture.zip"
    if os.path.exists(fx):
        result["fixture"] = {"path": fx, "bytes": os.path.getsize(fx),
                             "sha256": hashlib.sha256(open(fx, "rb").read()).hexdigest()}
    with open(f"{OUT}/ns-results.json", "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    print(f"{len(checks) - bad}/{len(checks)} namespace checks passed; results in {OUT}/ns-results.json")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
