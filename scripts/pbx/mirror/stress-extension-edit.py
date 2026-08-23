#!/usr/bin/env python3
"""Stress battery for the mirror extension EDIT/ADD appliers (2026-08-23).
Runs inside the unlicensed clone. Every mutation is reverted and verified
byte-identical (sha256) before moving on; the script aborts loudly on the
first discrepancy so a failure can never silently pollute the clone."""
import hashlib
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pymysql

if os.path.isdir("/var/lib/pbx-licenses") and os.listdir("/var/lib/pbx-licenses"):
    raise SystemExit("REFUSED: licence present — not the clone")

SOCK = next(p for p in ("/run/mysqld/mysqld.sock", "/var/run/mysqld/mysqld.sock") if os.path.exists(p))
def dbc(auto):
    return pymysql.connect(unix_socket=SOCK, user="root", database="ombutel", charset="utf8mb4",
                           cursorclass=pymysql.cursors.DictCursor, autocommit=auto)
conn, conn_ro = dbc(False), dbc(True)

import mirror_writes as mw
import vitalpbx_mirror as vmr

CONF = "/etc/asterisk/vitalpbx"
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
passed, failed = 0, 0
def check(label, cond, detail=""):
    global passed, failed
    if cond: passed += 1
    else:
        failed += 1
        print("FAIL:", label, detail)
        raise SystemExit("stress aborted at: " + label)
    print("ok  :", label)

# ── pick edit subjects: extensions with pjsip devices across several tenants ──
subjects = mw.q(conn_ro, """
    select e.tenant_id, e.extension, e.extension_id, e.name, e.email
    from ombu_extensions e
    where exists (select 1 from ombu_devices d where d.extension_id=e.extension_id and d.technology='pjsip')
      and e.tenant_id in (2, 5, 7, 9, 11, 104)
    order by e.tenant_id, e.extension""")
random.seed(20260823)
picks = []
seen_t = {}
for r in subjects:
    seen_t.setdefault(r["tenant_id"], []).append(r)
for t, rows in sorted(seen_t.items()):
    picks += random.sample(rows, min(4, len(rows)))
print("subjects:", len(picks), "across tenants", sorted(seen_t))

# ── 1. edit→revert cycles, byte-restore verified per cycle ───────────────────
cycles = 0
for r in picks:
    t, ext, eid = r["tenant_id"], r["extension"], r["extension_id"]
    files = ["pjsip__50-%d-extensions.conf" % t, "voicemail__50-%d-main.conf" % t]
    pre = {f: sha(os.path.join(CONF, f)) for f in files if os.path.exists(os.path.join(CONF, f))}
    vm0 = mw.q1(conn_ro, "select password from ombu_extensions_vm where extension_id=%s", (eid,))
    orig = {"name": r["name"], "email": r["email"] or ""}
    mw.edit_extension(conn, t, ext, set={"name": "ZZ Stress %s-%s" % (t, ext), "email": "zz-%s-%s@example.com" % (t, ext)},
                      vm=({"password": "97531"} if vm0 else {}))
    mw.apply_extension_edit_pbx(conn_ro, t, ext, target_dir=CONF, reload=False)
    row = mw.q1(conn_ro, "select name from ombu_extensions where extension_id=%s", (eid,))
    check("T%s ext %s edit landed" % (t, ext), row["name"].startswith("ZZ Stress"))
    mw.edit_extension(conn, t, ext, set=orig, vm=({"password": vm0["password"]} if vm0 else {}))
    mw.apply_extension_edit_pbx(conn_ro, t, ext, target_dir=CONF, reload=False)
    post = {f: sha(os.path.join(CONF, f)) for f in pre}
    check("T%s ext %s byte-restore" % (t, ext), pre == post, json.dumps({k: (pre[k][:8], post[k][:8]) for k in pre if pre[k] != post[k]}))
    cycles += 1
print("cycles complete:", cycles)

# one reload at the end (cycles skip per-cycle reloads to spare the clone's asterisk)
for c in ("module reload res_pjsip.so", "voicemail reload"):
    subprocess.run(["asterisk", "-rx", c], capture_output=True, text=True)

# ── 2. hostile inputs refused at the FULL path, nothing written ──────────────
t2files = ["pjsip__50-2-extensions.conf", "voicemail__50-2-main.conf"]
pre2 = {f: sha(os.path.join(CONF, f)) for f in t2files}
hostiles = [
    dict(set={"name": 'Evil";X'}, vm={}, devices=[]),
    dict(set={"name": "a,b,c"}, vm={}, devices=[]),
    dict(set={"name": "inject\nexten => _X.,1,Dial(...)"}, vm={}, devices=[]),
    dict(set={"name": "x; System(rm -rf /)"}, vm={}, devices=[]),
    dict(set={"name": "pipe|bomb"}, vm={}, devices=[]),
    dict(set={"email": "a@b, c@d"}, vm={}, devices=[]),
    dict(set={}, vm={"password": "1234; hi"}, devices=[]),
    dict(set={"internal_cid": '"a" <101>; include => hacked'}, vm={}, devices=[]),
    dict(set={"language": "en\nexten"}, vm={}, devices=[]),
    dict(set={"extension": "999"}, vm={}, devices=[]),               # renumber attempt
    dict(set={"class_of_service_id": "1"}, vm={}, devices=[]),      # outside whitelist
    dict(set={}, vm={}, devices=[{"device_id": 5, "secret": "with spaces!"}]),
    dict(set={}, vm={}, devices=[{"device_id": 5, "dtmf": "auto; rm"}]),
    dict(set={}, vm={}, devices=[{"device_id": 999999, "secret": "Abc12345XYZq"}]),  # foreign device
    dict(set={"name": "x" * 300}, vm={}, devices=[]),               # oversize
]
for i, h in enumerate(hostiles):
    try:
        mw.edit_extension(conn, 2, "101", **h)
        check("hostile %d refused" % i, False, json.dumps(h)[:120])
    except ValueError:
        check("hostile %d refused" % i, True)
post2 = {f: sha(os.path.join(CONF, f)) for f in t2files}
check("hostile batch wrote nothing", pre2 == post2)
row = mw.q1(conn_ro, "select name from ombu_extensions where tenant_id=2 and extension='101'")
check("t2 101 name untouched by hostiles", row["name"] == "Leah Fulop", row["name"])

# ── 3. an extension with a VIRTUAL device: pjsip patch must skip it cleanly ──
virt = mw.q1(conn_ro, """
    select e.tenant_id, e.extension, e.extension_id, e.name from ombu_extensions e
    where exists (select 1 from ombu_devices d where d.extension_id=e.extension_id and d.technology='virtual')
      and exists (select 1 from ombu_devices d where d.extension_id=e.extension_id and d.technology='pjsip')
    limit 1""")
if virt:
    t, ext = virt["tenant_id"], virt["extension"]
    files = ["pjsip__50-%d-extensions.conf" % t, "voicemail__50-%d-main.conf" % t]
    pre = {f: sha(os.path.join(CONF, f)) for f in files if os.path.exists(os.path.join(CONF, f))}
    mw.edit_extension(conn, t, ext, set={"name": "ZZ Virt Probe"})
    mw.apply_extension_edit_pbx(conn_ro, t, ext, target_dir=CONF, reload=False)
    mw.edit_extension(conn, t, ext, set={"name": virt["name"]})
    mw.apply_extension_edit_pbx(conn_ro, t, ext, target_dir=CONF, reload=False)
    post = {f: sha(os.path.join(CONF, f)) for f in pre}
    check("virtual-device tenant T%s ext %s round trip" % (t, ext), pre == post)
else:
    print("note: no mixed virtual+pjsip extension found — skipped")

# ── 4. idempotency: applying the same values twice is a no-op ────────────────
res = mw.edit_extension(conn, 2, "101", set={"name": "Leah Fulop"})
check("no-op edit reports empty change set", res["changed"] == {}, json.dumps(res["changed"]))

# ── 5. text-level refusal shapes (on copies, never the live files) ───────────
pj_text = open(os.path.join(CONF, "pjsip__50-2-extensions.conf"), encoding="utf-8").read()
try:
    mw._replace_pjsip_device_triple(pj_text, "T2_9999", "x")
    check("missing endpoint block refused", False)
except ValueError as e:
    check("missing endpoint block refused", "no endpoint block" in str(e))
# a truncated file (endpoint without aor) must refuse, not splice blindly
cut = pj_text[: pj_text.index("(p1-aor)")]
try:
    mw._replace_pjsip_device_triple(cut, "T2_101", "x")
    check("truncated file refused", False)
except ValueError:
    check("truncated file refused", True)
# duplicate-append refusal on the ADD path
try:
    mw.apply_extension_add_pbx(conn_ro, 2, "101", target_dir=CONF, reload=False, astdb=False)
    check("duplicate add refused", False)
except ValueError as e:
    check("duplicate add refused", "duplicate" in str(e) or "already" in str(e), str(e))

print("\nSTRESS PASS — %d checks, 0 failures" % passed)
