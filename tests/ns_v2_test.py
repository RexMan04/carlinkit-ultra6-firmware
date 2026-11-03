#!/usr/bin/env python3
"""Namespace-isolated tests of the 0.2 CGIs on the adapter's own busybox
(MAINPAGE_PLAN.md): cpthru_settings/set/update and the downfile, submition
and factoryreset gateways. Same isolation as tests/ns_test.py: bwrap
--unshare-all with a scratch root; CGIs run under the device /bin/sh via
qemu, external commands are device busybox applets. The stock binaries the
gateways exec are replaced by fakes via CPTHRU_REAL, so nothing installs.

Usage: python3 -I tests/ns_v2_test.py [--rootfs DIR] [--qemu FILE] [--out DIR]
"""
import hashlib, json, os, shutil, subprocess, sys, tempfile, time

HOME = os.path.expanduser("~")
FW = f"{HOME}/models/staging/carlinkit-ultra6-fw"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def arg(name, default):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


ROOTFS = arg("--rootfs", f"{FW}/tier1/rootfs_stock_exact")
QEMU = arg("--qemu", f"{HOME}/tools/qemu-user/qemu-arm-static")
OUT = arg("--out", f"{FW}/review/mainpage-v020/ns")
APPLETS = ["cat", "awk", "tr", "ls", "sed", "cut", "df", "sleep", "md5sum", "flock", "setsid", "rm"]
IMG = os.urandom(300000)
IMG_MD5 = hashlib.md5(IMG).hexdigest()
LONG = "A" * 200 + ".swu"
Q = "/qemu-arm-static"
ENV = "CPTHRU_REAL=/fake CPTHRU_CGIDIR=/cgi CPTHRU_STAGE=/mnt/UDISK/swupdate"


def write(path, data, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)


def cgi(name, qs, out, extra=""):
    return f"{ENV} {extra} QUERY_STRING='{qs}' REQUEST_METHOD=GET {Q} /bin/sh /cgi/{name} > /out/{out} 2> /out/{out}.err"


def driver():
    S = "/mnt/UDISK/swupdate"
    L = [
        "set -u",
        # settings / set
        cgi("cpthru_settings.cgi", "", "settings.txt"),
        cgi("cpthru_set.cgi", "key=persist.sys.wifi.channel&value=149", "set_ok.txt"),
        cgi("cpthru_set.cgi", "key=persist.sys.wifi.channel&value=165", "set_badval.txt"),
        cgi("cpthru_set.cgi", "key=persist.sys.carplay.audio.media.samplerate&value=48000", "set_rate.txt"),
        cgi("cpthru_set.cgi", "key=persist.sys.headunit.gps.disable&value=1", "set_gps.txt"),
        cgi("cpthru_set.cgi", "key=persist.sys.cp.showui&value=1", "set_hidden.txt"),
        cgi("cpthru_set.cgi", "key=persist.sys.boot.delay&value=5;reboot", "set_inject.txt"),
        cgi("cpthru_settings.cgi", "", "settings2.txt"),
        # update: state, verify
        cgi("cpthru_update.cgi", "op=state", "state_idle.txt"),
        cgi("cpthru_update.cgi", f"op=verify&name={LONG}&size=1", "verify_long.txt"),
        cgi("cpthru_update.cgi", "op=verify&name=../x.swu&size=1", "verify_dots.txt"),
        cgi("cpthru_update.cgi", "op=verify&name=cpthru.swu&size=5", "verify_size.txt"),
        cgi("cpthru_update.cgi", f"op=verify&name=cpthru.swu&size={len(IMG)}", "verify_ok.txt"),
        # install rejections leave no marker and no lock
        cgi("cpthru_update.cgi", f"op=install&name=cpthru.swu&size={len(IMG)}&md5=zz", "inst_badmd5.txt"),
        cgi("cpthru_update.cgi", f"op=install&name=cpthru.swu&size={len(IMG)}&md5={'0' * 32}", "inst_wrongmd5.txt"),
        cgi("cpthru_update.cgi", f"op=install&name={LONG}&size={len(IMG)}&md5={IMG_MD5}", "inst_long.txt"),
        "[ -e /tmp/cpthru.install ] && echo yes > /out/marker_after_reject",
        # downfile gateway: stdin/stdout byte-exact, holds the lock while running
        f"{ENV} CONTENT_LENGTH=6 REQUEST_METHOD=POST {Q} /bin/sh /cgi/downfile.cgi < /fixtures/body.bin > /out/down_pass.txt 2> /out/down_pass.err",
        f"( {ENV} SLOW=3 CONTENT_LENGTH=6 REQUEST_METHOD=POST {Q} /bin/sh /cgi/downfile.cgi < /fixtures/body.bin > /out/down_slow.txt 2>&1 ) &",
        "slow=$!",
        "/qemu-arm-static /bin/busybox sleep 1",
        f"{ENV} CONTENT_LENGTH=6 REQUEST_METHOD=POST {Q} /bin/sh /cgi/downfile.cgi < /fixtures/body.bin > /out/down_busy.txt 2>&1",
        cgi("factoryreset.cgi", "", "factory_busy.txt"),
        # install while a chunk holds the lock: waits for it (drain), then installs
        "t0=$SECONDS",
        cgi("cpthru_update.cgi", f"op=install&name=cpthru.swu&size={len(IMG)}&md5={IMG_MD5}", "inst_ok.txt"),
        "echo $((SECONDS - t0)) > /out/inst_ok.secs",
        "wait $slow",
        "/qemu-arm-static /bin/busybox sleep 1",
        cgi("cpthru_update.cgi", f"op=install&name=cpthru.swu&size={len(IMG)}&md5={IMG_MD5}", "inst_again.txt"),
        cgi("cpthru_update.cgi", "op=state", "state_started.txt"),
        f"{ENV} CONTENT_LENGTH=6 REQUEST_METHOD=POST {Q} /bin/sh /cgi/downfile.cgi < /fixtures/body.bin > /out/down_after.txt 2>&1",
        cgi("factoryreset.cgi", "", "factory_after.txt"),
        cgi("cpthru_set.cgi", "key=persist.cpthru.off&value=1", "set_after.txt"),
        cgi("submition.cgi", f"filename=cpthru.swu&", "submition_direct.txt"),
        # concurrent installs with a launcher that exits at once: one launch only
        "/qemu-arm-static /bin/busybox sleep 1",
        "cat /out/launch.log > /out/launch_first.log 2>/dev/null",
        ": > /out/launch.log; rm -f /tmp/cpthru.install",
        f"( {cgi('cpthru_update.cgi', f'op=install&name=cpthru.swu&size={len(IMG)}&md5={IMG_MD5}', 'race_a.txt')} ) & a=$!",
        f"( {cgi('cpthru_update.cgi', f'op=install&name=cpthru.swu&size={len(IMG)}&md5={IMG_MD5}', 'race_b.txt')} ) & b=$!",
        "wait $a; wait $b",
        "/qemu-arm-static /bin/busybox sleep 1",
        # factory reset gateway with no marker runs the real one
        "rm -f /tmp/cpthru.install",
        cgi("factoryreset.cgi", "", "factory_ok.txt"),
        "echo done > /out/done",
    ]
    return "\n".join(L) + "\n"


def body(raw):
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
        print("FAIL isolation unavailable: bwrap not found")
        sys.exit(1)
    os.makedirs(OUT, exist_ok=True)
    scratch = tempfile.mkdtemp(prefix="cpthru-ns2-", dir=OUT)
    try:
        for d in ("tmp", "out", "w", "cgi", "props", "fixtures", "fake", "mnt/UDISK/swupdate"):
            os.makedirs(f"{scratch}/{d}", exist_ok=True)
        os.chmod(f"{scratch}/tmp", 0o1777)
        write(f"{scratch}/mnt/UDISK/swupdate/cpthru.swu", IMG)
        write(f"{scratch}/mnt/UDISK/swupdate/swupdate.log", "line one\nswupdate: \"quoted\" \\ back\n" * 5)
        write(f"{scratch}/fixtures/body.bin", b"ab\x00\xffcd")
        for n in ("cpthru_settings.cgi", "cpthru_set.cgi", "cpthru_update.cgi", "downfile.cgi", "submition.cgi", "factoryreset.cgi"):
            shutil.copy(f"{REPO}/web/cgi-bin/{n}", f"{scratch}/cgi/{n}")
        for a in APPLETS:
            write(f"{scratch}/w/{a}", f'#!/hostbin/bash\nexec {Q} /bin/busybox {a} "$@"\n', 0o755)
        write(f"{scratch}/w/getprop", '#!/hostbin/bash\n[ -f "/props/$1" ] && printf "%s\\n" "$(</props/$1)"\nexit 0\n', 0o755)
        write(f"{scratch}/w/setprop", '#!/hostbin/bash\nprintf "%s" "$2" > "/props/$1"; echo "noise on stdout"\n', 0o755)
        # Fakes of the moved stock binaries.
        write(f"{scratch}/fake/downfile.cgi", '#!/hostbin/bash\nb=$(od -An -tx1 | tr -d " \\n")\n'
              '[ -n "${SLOW:-}" ] && sleep "$SLOW"\n'
              'printf "Content-Type: text/html\\n\\nbody=%s cwd=%s\\nwrite data------success\\n" "$b" "$PWD"\n', 0o755)
        write(f"{scratch}/fake/submition.cgi", '#!/hostbin/bash\necho "launch qs=$QUERY_STRING cwd=$PWD" >> /out/launch.log\n', 0o755)
        write(f"{scratch}/fake/factoryreset.cgi", '#!/hostbin/bash\necho "factory cwd=$PWD" >> /out/factory.log\n'
              'printf "Content-Type: text/plain\\n\\nreset\\n"\n', 0o755)
        write(f"{scratch}/props/persist.cpthru.off", "0")
        write(f"{scratch}/props/persist.suding.wl.audio.latency", "600")
        write(f"{scratch}/drv.sh", driver(), 0o755)
        cmd = [bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--bind", scratch, "/"]
        for d in ("bin", "sbin", "lib", "usr", "etc"):
            if os.path.isdir(f"{ROOTFS}/{d}"):
                cmd += ["--ro-bind", f"{ROOTFS}/{d}", f"/{d}"]
        cmd += ["--ro-bind", "/usr/lib64", "/lib64", "--ro-bind", bash, "/hostbin/bash", "--ro-bind", "/usr/bin/od", "/w/od",
                "--ro-bind", QEMU, Q, "--proc", "/proc", "--dev", "/dev",
                "--setenv", "PATH", "/w", "--setenv", "HOME", "/tmp", "--chdir", "/", "/hostbin/bash", "/drv.sh"]
        t0 = time.monotonic()
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        o = f"{scratch}/out"
        check(os.path.exists(f"{o}/done"), "driver completed", r.stderr[-600:])

        def J(name):
            raw = open(f"{o}/{name}", "rb").read()
            h, b = body(raw)
            try:
                return json.loads(b)
            except ValueError:
                return {"_raw": b.decode("latin-1")[:300], "_err": open(f"{o}/{name}.err").read()[:300] if os.path.exists(f"{o}/{name}.err") else ""}

        def T(name):
            return open(f"{o}/{name}", "rb").read().decode("latin-1")

        s = J("settings.txt")
        check(s.get("ok") is True and len(s.get("values", {})) == 7 and s["values"]["persist.suding.wl.audio.latency"] == "600"
              and s["values"]["persist.sys.wifi.channel"] == "" and s["install_started"] is False, "settings CGI: 7 keys, unset as \"\"", str(s))
        check(J("set_ok.txt") == {"ok": True, "key": "persist.sys.wifi.channel", "value": "149"}, "set channel 149 (setprop stdout suppressed)", str(J("set_ok.txt")))
        check(J("set_badval.txt").get("ok") is False, "channel 165 refused")
        check(J("set_rate.txt").get("value") == "48000" and J("set_gps.txt").get("value") == "1", "sample rate + GPS saved")
        check(J("set_hidden.txt").get("error") == "unknown setting", "hidden stock setting not writable")
        check(J("set_inject.txt").get("ok") is False, "injected value refused")
        s2 = J("settings2.txt")["values"]
        check(s2["persist.sys.wifi.channel"] == "149" and s2["persist.sys.carplay.audio.media.samplerate"] == "48000", "settings read back")

        st = J("state_idle.txt")
        check(st.get("phase") == "idle" and {"name": "cpthru.swu", "size": len(IMG)} in st.get("staged", [])
              and isinstance(st.get("free_bytes"), int), "state idle, staged file listed, free space", str(st))
        check(J("verify_long.txt").get("error") == "unexpected file name", "200-char name refused (verify)")
        check(J("verify_dots.txt").get("error") == "unexpected file name", "path name refused")
        check(J("verify_size.txt").get("error") == "staged copy has a different size", "verify size mismatch")
        v = J("verify_ok.txt")
        check(v.get("ok") is True and v.get("md5") == IMG_MD5 and v.get("size") == len(IMG), "verify md5 matches", str(v))
        check(J("inst_badmd5.txt").get("phase") == "rejected", "install bad md5 rejected")
        w = J("inst_wrongmd5.txt")
        check(w.get("phase") == "rejected" and "does not match" in w.get("error", ""), "install wrong md5 rejected", str(w))
        check(J("inst_long.txt").get("error") == "unexpected file name", "200-char name refused (install)")
        check(not os.path.exists(f"{o}/marker_after_reject"), "rejected installs leave no marker")

        dp = T("down_pass.txt")
        check("body=6162" + "00ff" + "6364" in dp and "cwd=/cgi" in dp and dp.startswith("Content-Type: text/html\n\n"),
              "downfile gateway passes stdin/stdout byte-exact, cwd = CGI dir", dp[:200])
        check("upload refused" in T("down_busy.txt") and "fail" in T("down_busy.txt"), "second chunk refused while one holds the lock", T("down_busy.txt")[:200])
        check("refused" in T("factory_busy.txt"), "factory reset refused while a chunk holds the lock")
        check("write data------success" in T("down_slow.txt"), "slow chunk completed", T("down_slow.txt")[:200])
        io = J("inst_ok.txt")
        secs = int(open(f"{o}/inst_ok.secs").read())
        check(io.get("ok") is True and io.get("phase") == "install-started", "install accepted", str(io))
        check(secs >= 1, f"install waited for the in-flight chunk ({secs} s)")
        launches = open(f"{o}/launch_first.log").read().splitlines() if os.path.exists(f"{o}/launch_first.log") else []
        check(launches == ["launch qs=filename=cpthru.swu& cwd=/cgi"], "stock installer launched once with exact query, cwd", str(launches))
        ia = J("inst_again.txt")
        check(ia.get("ok") is False and ia.get("phase") == "install-started", "second install refused (once per boot)", str(ia))
        ss = J("state_started.txt")
        check(ss.get("phase") == "install-started" and "cpthru.swu" in ss.get("install", "") and len(ss.get("log", [])) == 6
              and all('"' not in x and "\\" not in x for x in ss["log"]), "state reports install + sanitized log tail", str(ss)[:300])
        check("a firmware install has started" in T("down_after.txt"), "upload refused after install started")
        check("a firmware install has started" in T("factory_after.txt"), "factory reset refused after install started")
        check(J("set_after.txt").get("error") == "a firmware install has started", "settings refused after install started")
        check("refused" in T("submition_direct.txt"), "direct stock installer URL refused")
        races = [J("race_a.txt"), J("race_b.txt")]
        rl = open(f"{o}/launch.log").read().splitlines()
        check(len(rl) == 1 and sorted(x.get("ok") for x in races) == [False, True], "concurrent installs: exactly one launch", f"{races} {rl}")
        fl = open(f"{o}/factory.log").read().splitlines() if os.path.exists(f"{o}/factory.log") else []
        check(fl == ["factory cwd=/cgi"] and "reset" in T("factory_ok.txt"), "factory reset gateway runs the stock one when idle", str(fl))
        elapsed = time.monotonic() - t0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    result = {"status": "passed" if not bad else "failed", "rootfs": ROOTFS, "seconds": round(elapsed, 1), "checks": checks}
    with open(f"{OUT}/ns-v2-results.json", "w") as f:
        json.dump(result, f, indent=2)
    print(f"{len(checks) - bad}/{len(checks)} namespace checks passed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
