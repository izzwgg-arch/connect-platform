#!/usr/bin/env python3
"""Clone acceptance for the mirror EXTENSION ADD (2026-08-23), on the OVER-CAP
tenant t8 (18 extensions — the panel's import silently refuses here).
snapshot -> mirror add ext 660 -> verify rows/files/asterisk -> record whether
the PANEL can delete on an over-cap tenant -> restore file snapshots + astdb
-> byte-back."""
import hashlib
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pymysql

if os.path.isdir("/var/lib/pbx-licenses") and os.listdir("/var/lib/pbx-licenses"):
    raise SystemExit("REFUSED: a licence file exists — this is not the clone")

SOCK = next(p for p in ("/run/mysqld/mysqld.sock", "/var/run/mysqld/mysqld.sock") if os.path.exists(p))
conn = pymysql.connect(unix_socket=SOCK, user="root", database="ombutel", charset="utf8mb4",
                       cursorclass=pymysql.cursors.DictCursor, autocommit=False)
conn_ro = pymysql.connect(unix_socket=SOCK, user="root", database="ombutel", charset="utf8mb4",
                          cursorclass=pymysql.cursors.DictCursor, autocommit=True)

import mirror_writes as mw
import vitalpbx_mirror as vmr

T = 8
EXT = "660"
CONF = "/etc/asterisk/vitalpbx"
FILES = ["pjsip__50-8-extensions.conf", "voicemail__50-8-main.conf",
         "extensions__25-8-hints.conf", "extensions__50-8-dialplan.conf"]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

snap = {f: open(os.path.join(CONF, f), encoding="utf-8").read() for f in FILES}
shas = {f: sha(os.path.join(CONF, f)) for f in FILES}
count0 = mw.q1(conn_ro, "select count(*) c from ombu_extensions where tenant_id=%s", (T,))["c"]
print("t8 extensions before:", count0)

# rows + surgical apply — exactly what the helper endpoint runs
plan = mw.add_extension(conn, T, EXT, "ZZ Add Accept", "zz-add@example.com")
ids = plan.execute(conn)
print("rows:", json.dumps(plan.rows_by_table()), "ids:", json.dumps({k: int(v) for k, v in ids.items()}))
applied = mw.apply_extension_add_pbx(conn_ro, T, EXT, target_dir=CONF)
print("applied:", json.dumps(applied))
assert set(applied["files"]) == set(FILES), "all four files must be patched: %r" % applied["files"]

# verify rows + asterisk
m = vmr.load_tenant(conn_ro, T)
e = next(x for x in m["extensions"] if x["extension"] == EXT)
assert len([d for d in e["devices"] if d["technology"] == "pjsip"]) == 2
eps = subprocess.run(["asterisk", "-rx", "pjsip show endpoints"], capture_output=True, text=True).stdout
assert "T8_660" in eps and "T8_660_1" in eps, "both endpoints must load"
show = subprocess.run(["asterisk", "-rx", "pjsip show endpoint T8_660"], capture_output=True, text=True).stdout
assert "ZZ Add Accept" in show, "callerid must carry the name"
dp = subprocess.run(["asterisk", "-rx", "dialplan show T8_ext-followme"], capture_output=True, text=True).stdout
assert "FW660" in dp, "the FW dialplan block must be live"
hints = subprocess.run(["asterisk", "-rx", "core show hints"], capture_output=True, text=True).stdout
assert "T8_660" in hints, "the hint must be live"
db = subprocess.run(["asterisk", "-rx", "database get %s/extensions/%s name" % (m["hash"], EXT)], capture_output=True, text=True).stdout
assert "ZZ Add Accept" in db
print("asterisk: endpoints + dialplan + hint + astdb all live")

# does the PANEL delete work on an over-cap tenant? (the last unqualified claim)
verdict = {"panelDelete": "not-attempted"}
try:
    creds = {}
    for ln in open("/root/robot-creds.env", encoding="utf-8", errors="replace"):
        if "=" in ln:
            k, v = ln.strip().split("=", 1)
            creds[k] = v.strip().strip("'\"")
    import urllib.request
    import ssl
    import http.cookiejar
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.HTTPSHandler(context=ctx))
    import urllib.parse
    def post(pairs):
        data = urllib.parse.urlencode(pairs).encode()
        r = op.open(urllib.request.Request("https://127.0.0.1:8443/index.php", data=data), timeout=30)
        return r.read().decode("utf-8", "replace")
    login = post([("class", "login"), ("method", "authenticate"), ("mode", "auth"),
                  ("data[user]", creds.get("ONBOARDING_ROBOT_USER", "")), ("data[password]", creds.get("ONBOARDING_ROBOT_PASS", ""))])
    lj = json.loads(login)
    assert lj.get("state") == "success", "panel login failed"
    post([("class", "core"), ("method", "setTenant"), ("mode", "view"), ("data", m["hash"])])
    d1 = json.loads(post([("class", "extensions"), ("method", "delete"), ("mode", "delete"), ("data", str(ids["extension_id"]))]))
    html = str(d1.get("html") or "")
    if "confirmation-modal" in html:
        import re as _re
        pairs = []
        for mm in _re.finditer(r"<input\b[^>]*type=[\"']hidden[\"'][^>]*>", html):
            n = (_re.search(r"name=[\"']([^\"']+)[\"']", mm.group(0)) or [None, None])[1]
            v = (_re.search(r"value=[\"']([^\"']*)[\"']", mm.group(0)) or [None, ""])[1] or ""
            if n: pairs.append((n, v))
        d2 = json.loads(post(pairs))
        verdict["panelDelete"] = "OK" if (d2.get("state") == "success" or (d2.get("notification") or {}).get("type") == "success") else "REFUSED: " + json.dumps(d2)[:200]
    else:
        verdict["panelDelete"] = "OK" if d1.get("state") == "success" else "REFUSED: " + json.dumps(d1)[:200]
except Exception as exc:
    verdict["panelDelete"] = "ERROR: %s" % exc
print("panel delete on over-cap tenant:", verdict["panelDelete"])

left = mw.q1(conn_ro, "select count(*) c from ombu_extensions where tenant_id=%s and extension=%s", (T, EXT))["c"]
print("rows left for 660 after panel delete:", left)
if left:
    # panel could not delete — remove the mirror's rows ourselves (cascade from ombu_extensions + ombu_numbers)
    with conn.cursor() as cur:
        cur.execute("delete from ombu_extensions where extension_id=%s", (ids["extension_id"],))
        cur.execute("delete from ombu_numbers where tenant_id=%s and number=%s and module_id=1", (T, EXT))
    conn.commit()
    print("rows removed via mirror cleanup")

# restore the file snapshots byte-exactly + clear astdb keys + reload
for f in FILES:
    mw._atomic_write_conf(os.path.join(CONF, f), snap[f])
fam = m["hash"]
for family in ("%s/extensions/%s" % (fam, EXT), "%s/diversions/%s" % (fam, EXT)):
    subprocess.run(["asterisk", "-rx", "database deltree %s" % family.lstrip("/")], capture_output=True, text=True)
for dn in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM", "PEA"):
    subprocess.run(["asterisk", "-rx", "database del CustomDevstate T8_%s_%s" % (dn, EXT)], capture_output=True, text=True)
for c in ("module reload res_pjsip.so", "dialplan reload", "voicemail reload"):
    subprocess.run(["asterisk", "-rx", c], capture_output=True, text=True)
for f in FILES:
    assert sha(os.path.join(CONF, f)) == shas[f], "%s not byte-identical after restore" % f
count1 = mw.q1(conn_ro, "select count(*) c from ombu_extensions where tenant_id=%s", (T,))["c"]
eps2 = subprocess.run(["asterisk", "-rx", "pjsip show endpoints"], capture_output=True, text=True).stdout
assert "T8_660" not in eps2, "endpoint must be gone after restore"
print("restore: files byte-identical, endpoints gone, t8 count %d -> %d" % (count0, count1))
assert count1 == count0
print("ADD ACCEPTANCE PASS | panelDeleteOverCap=%s" % verdict["panelDelete"])
