#!/usr/bin/env python3
# Checks the timing JSON samples written by test_timing: parse, bound, the
# exact character set and prefix cpthru_status.cgi accepts, and the shape the
# diagnostics page reads. Usage: check_timing_json.py DIR
# Also checks the CGI's syntax/schema validator against malformed inputs and
# shape/range mutations. Only platform-free samples use the core_only mode.
import json, os, re, subprocess, sys

LIMIT = 96 * 1024
SAFE = re.compile(r'^[A-Za-z0-9{}\[\]":,._ -]*$')  # same set as cpthru_status.cgi
AWK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "cgi-bin", "cpthru_json.awk")


def awk_ok(text, core_only=False):
    cmd = ["awk"] + (["-v", "core_only=1"] if core_only else []) + ["-f", AWK]
    r = subprocess.run(cmd, input=text + "\n", capture_output=True, text=True, timeout=30)
    if r.returncode or r.stderr:
        raise RuntimeError(f"awk failed ({r.returncode}): {r.stderr}")
    return r.stdout.strip() == "ok"


BAD = ['{"v":1,}', '{"v":1,"a":[1,,2]}', '{"v":1,"b":{"c":}}', '{"v":1}{"v":1}', '{"v":1,"n":01}',
       '{"v":1,"a":[1,2}', '{"v":1,"a":"x}', '{"v":1 "a":1}', '{"v":1,"a":-}', '{"v":1,"a":nul}',
       '{"v":1,"a":' + "[" * 40 + "]" * 40 + "}"]
awk_bad = [b for b in BAD if awk_ok(b)]
print(("FAIL " if awk_bad else "ok ") + f"cpthru_json.awk rejects {len(BAD)} malformed inputs" +
      (f": accepted {awk_bad}" if awk_bad else ""))
STATS = ["cb", "iv", "gap", "lk", "par", "plk", "vsend", "csend", "orig", "res", "pub"]
COUNTS = ["seq", "gen", "t0", "len_ms", "calls", "first", "v_ok", "v_fail", "v_gate",
          "c_ok", "c_fail", "c_gate", "slow16", "slow33", "slow100"]

bad = len(awk_bad)
names = sorted(n for n in os.listdir(sys.argv[1]) if n.endswith(".json"))
for name in names:
    raw = open(os.path.join(sys.argv[1], name), "rb").read()
    problems = []
    if len(raw) >= LIMIT:
        problems.append(f"{len(raw)} bytes >= {LIMIT}")
    text = raw.decode("ascii", "replace")
    if not text.startswith('{"v":1,') or not text.endswith("}"):
        problems.append("prefix/suffix the CGI expects")
    if not SAFE.match(text):
        problems.append("characters outside the CGI's allowed set")
    if not awk_ok(text, core_only=name != "production.json"):
        problems.append("cpthru_json.awk rejects it")
    try:
        d = json.loads(text)
        assert d["v"] == 1 and d["available"] in (0, 1) and d["clock_res_ms"] == 1 and d["window_ms"] == 5000
        assert len(d["windows"]) <= d["ring_max"] == 24
        assert d["available"] or not d["windows"]
        for w in d["windows"]:
            assert all(type(w[k]) is int and 0 <= w[k] <= 0xffffffff for k in COUNTS)
            for s in STATS:
                st = w[s]
                assert set(st) == {"n", "avg", "max", "sum"} and all(
                    isinstance(st[k], (int, float)) for k in st)
                assert st["n"] == 0 or abs(st["avg"] - st["sum"] / st["n"]) <= max(0.1, st["sum"] / st["n"] * 1e-9)
    except Exception as e:  # noqa: BLE001 - report any shape problem
        problems.append(f"shape: {e!r}")
    bad += bool(problems)
    print(("FAIL " if problems else "ok ") + f"{name} ({len(raw)} bytes) " + "; ".join(problems))

# Mutate a real serialized production sample so each negative case otherwise
# has a valid header/window. In particular, uint64 comparisons must be exact.
production = json.load(open(os.path.join(sys.argv[1], "production.json")))
mutations = []
def change(label, path, value=None, delete=False):
    d = json.loads(json.dumps(production))
    at = d
    for key in path[:-1]:
        at = at[key]
    if delete:
        del at[path[-1]]
    else:
        at[path[-1]] = value
    mutations.append((label, json.dumps(d, separators=(",", ":"))))

mutations += [("reported null window", '{"v":1,"available":1,"windows":[null]}'),
              ("empty object", "{}"), ("array root", "[]"), ("null root", "null")]
for key in production:
    change("missing root " + key, [key], delete=True)
for key in COUNTS + STATS:
    change("missing window " + key, ["windows", 0, key], delete=True)
for key in ("n", "avg", "max", "sum"):
    change("missing stat " + key, ["windows", 0, "cb", key], delete=True)
for label, path, values in [
    ("window", ["windows", 0], [None, 0, [], "bad"]),
    ("stat", ["windows", 0, "cb"], [None, 0, [], "bad"]),
    ("counter", ["windows", 0, "calls"], [-1, 4294967296, 1.5, True, None, "1"]),
    ("stat count", ["windows", 0, "cb", "n"], [-1, 4294967296, True]),
    ("stat maximum", ["windows", 0, "cb", "max"], [-1, 4294967296, None]),
    ("stat sum", ["windows", 0, "cb", "sum"], [-1, 18446744073709551616, 18446744073709551617, 1.5, "1"]),
    ("stat average", ["windows", 0, "cb", "avg"], [-1.0, None, "2.5", True]),
    ("available", ["available"], [2, True, None]),
    ("windows", ["windows"], [None, {}, [production["windows"][0]] * 25]),
    ("info", ["info"], [None, []]),
    ("info record", ["info", "VIDEO_WIDTH"], [None, []]),
    ("info signed", ["info", "VIDEO_WIDTH", "stock"], [-2147483649, 2147483648, True]),
    ("info override", ["info", "VIDEO_WIDTH", "override"], [2, True]),
    ("info mono", ["info", "VIDEO_WIDTH", "last_mono_ms"], [-1, 4294967296]),
]:
    for value in values:
        change(label + " " + repr(value)[:40], path, value)
for key in ("calls", "last_mono_ms", "stock", "returned", "override"):
    change("missing info " + key, ["info", "VIDEO_WIDTH", key], delete=True)
for key, value in [("v", 2), ("window_ms", 1), ("ring_max", 25), ("clock_res_ms", 0),
                   ("gen", -1), ("seq", 4294967296), ("available", 0)]:
    change("invalid " + key, [key], value)
raw_production = json.dumps(production, separators=(",", ":"))
mutations += [("duplicate root", raw_production.replace('"v":1,', '"v":1,"v":1,', 1)),
              ("duplicate stat", raw_production.replace('"n":', '"n":0,"n":', 1)),
              ("exponent counter", raw_production.replace('"seq":1', '"seq":1e0', 1)),
              ("oversize", raw_production + " " * LIMIT)]
accepted = [label for label, text in mutations if awk_ok(text)]
bad += len(accepted)
print(("FAIL " if accepted else "ok ") + f"cpthru_json.awk rejects {len(mutations)} invalid shapes/ranges" +
      (f": {accepted}" if accepted else ""))

unavailable = json.loads(raw_production)
unavailable.update(available=0, windows=[], gen=0, seq=0, mono_ms=None, session_mono_ms=None)
boundaries = json.loads(raw_production)
boundaries["info"]["VIDEO_WIDTH"].update(stock=-2147483648, returned=2147483647, last_mono_ms=4294967295)
boundaries["windows"][0]["cb"].update(n=4294967295, max=4294967295, sum=18446744073709551615, avg=4294967297.0)
for label, value in [("production unavailable", unavailable), ("integer boundaries", boundaries)]:
    ok = awk_ok(json.dumps(value, separators=(",", ":")))
    bad += not ok
    print(("ok " if ok else "FAIL ") + label)
print(f"{len(names)} timing JSON samples, {bad} failed")
sys.exit(1 if bad or not names else 0)
