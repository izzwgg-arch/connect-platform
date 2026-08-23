#!/usr/bin/env python3
"""Clone acceptance for the mirror EXTENSION EDIT-WRITER (2026-08-22).

Runs INSIDE the unlicensed vpbx-clone container. Refuses to run anywhere a
licence file exists. Sequence:
  A. factored-renderer byte-identity (new vitalpbx_mirror vs the HEAD copy)
  B. snapshot -> edit ext 101 (t2) via edit_extension + apply_extension_edit_pbx
     -> verify rows, files (surgical == renderer blocks; everything else
     untouched), pjsip endpoint, AstDB -> revert -> byte-identical to snapshot
"""
import hashlib
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pymysql

# hard refusal outside the clone
if os.listdir("/var/lib/pbx-licenses") if os.path.isdir("/var/lib/pbx-licenses") else []:
    raise SystemExit("REFUSED: a licence file exists — this is not the clone")
host = subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip()
print("host:", host)

SOCK = next(p for p in ("/run/mysqld/mysqld.sock", "/var/run/mysqld/mysqld.sock") if os.path.exists(p))
conn = pymysql.connect(unix_socket=SOCK, user="root", database="ombutel", charset="utf8mb4",
                       cursorclass=pymysql.cursors.DictCursor, autocommit=False)
conn_ro = pymysql.connect(unix_socket=SOCK, user="root", database="ombutel", charset="utf8mb4",
                          cursorclass=pymysql.cursors.DictCursor, autocommit=True)

T = 2
EXT = "101"
CONF = "/etc/asterisk/vitalpbx"
PJ = os.path.join(CONF, "pjsip__50-%d-extensions.conf" % T)
VMF = os.path.join(CONF, "voicemail__50-%d-main.conf" % T)

sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

import vitalpbx_mirror as vmn
import vitalpbx_mirror_head as vmh
import mirror_writes as mw

# ---------- A. factored renderer byte-identity ----------
mn = vmn.load_tenant(conn_ro, T)
mh = vmh.load_tenant(conn_ro, T)
a_pj_new, a_pj_head = vmn.render_pjsip_extensions(mn), vmh.render_pjsip_extensions(mh)
a_vm_new, a_vm_head = vmn.render_voicemail(mn), vmh.render_voicemail(mh)
assert a_pj_new == a_pj_head, "FACTORING CHANGED pjsip render output"
assert a_vm_new == a_vm_head, "FACTORING CHANGED voicemail render output"
print("A. factored renderers byte-identical to HEAD: pjsip %d bytes, voicemail %d bytes" % (len(a_pj_new), len(a_vm_new)))

# ---------- B. snapshot ----------
snap = {"pj": open(PJ, encoding="utf-8").read(), "vm": open(VMF, encoding="utf-8").read(),
        "pj_sha": sha(PJ), "vm_sha": sha(VMF)}
row0 = mw.q1(conn_ro, "select * from ombu_extensions where tenant_id=%s and extension=%s", (T, EXT))
vm0 = mw.q1(conn_ro, "select * from ombu_extensions_vm where extension_id=%s", (row0["extension_id"],))
dev0 = mw.q(conn_ro, "select * from ombu_devices where extension_id=%s order by device_id", (row0["extension_id"],))
orig = {"name": row0["name"], "email": row0["email"] or "", "internal_cid": row0["internal_cid"] or "",
        "vm_password": vm0["password"], "desk_secret": dev0[0]["secret"], "desk_desc": dev0[0]["description"]}
print("B. snapshot:", json.dumps({k: (v if "secret" not in k else "***") for k, v in orig.items()}))

# ---------- edit ----------
# Ext 101's CID is hand-tuned ("Leah" while the name is "Leah Fulop") — a rename
# alone must PRESERVE it, exactly as the panel form (which re-posts the field
# untouched) would.
res = mw.edit_extension(conn, T, EXT,
                        set={"name": "ZZ Edit Accept", "email": "zz-accept@example.com"},
                        vm={"password": "246813"},
                        devices=[{"device_id": dev0[0]["device_id"], "secret": "ZzAccept12345secret", "description": "ZZ Accept Device"}])
print("edit changed:", json.dumps(res["changed"], default=str))
row1 = mw.q1(conn_ro, "select * from ombu_extensions where tenant_id=%s and extension=%s", (T, EXT))
assert row1["internal_cid"] == orig["internal_cid"], "a hand-tuned CID must SURVIVE a rename: %r" % row1["internal_cid"]
print("rename preserved the hand-tuned internal_cid (panel-identical behaviour)")
# an explicit CID change is honoured
mw.edit_extension(conn, T, EXT, set={"internal_cid": '"ZZ Edit Accept" <101>'})
applied = mw.apply_extension_edit_pbx(conn_ro, T, EXT, target_dir=CONF)
print("applied:", json.dumps(applied))
assert set(applied["files"]) == {os.path.basename(PJ), os.path.basename(VMF)}, "both files must be patched"

# rows really changed
row1 = mw.q1(conn_ro, "select * from ombu_extensions where tenant_id=%s and extension=%s", (T, EXT))
assert row1["name"] == "ZZ Edit Accept" and row1["email"] == "zz-accept@example.com"
assert row1["internal_cid"] == '"ZZ Edit Accept" <101>'

# surgical file: the edited blocks equal the renderer's blocks; nothing else moved
m1 = vmn.load_tenant(conn_ro, T)
e1 = next(x for x in m1["extensions"] if x["extension"] == EXT)
pj_after = open(PJ, encoding="utf-8").read()
for d in e1["devices"]:
    if d["technology"] != "pjsip":
        continue
    blk = vmn.pjsip_device_blocks(m1, e1, d)
    assert blk in pj_after, "renderer block for %s missing from surgical file" % d["user"]
vm_after = open(VMF, encoding="utf-8").read()
line = vmn.voicemail_line(m1, e1)
assert line in vm_after, "voicemail line missing from surgical file"

# untouched remainder: strip this ext's device triples + vm line from before/after; rest identical
def strip_ext(pj_text, vm_text, m, e):
    t = pj_text
    for d in e["devices"]:
        if d["technology"] != "pjsip":
            continue
        name = re.escape("%s%s" % (m["prefix"], d["user"]))
        t = re.sub(r"(?ms)^\[%s\]\(p\d+\)\n.*?^\[%s\]\(p\d+-aor\)\ntype=aor\nmax_contacts=\d+\n\n" % (name, name), "", t)
    v = re.sub(r"(?m)^%s => .*\n" % re.escape(EXT), "", vm_text)
    return t, v

b_pj, b_vm = strip_ext(snap["pj"], snap["vm"], m1, e1)
a_pj, a_vm = strip_ext(pj_after, vm_after, m1, e1)
assert b_pj == a_pj, "pjsip file changed OUTSIDE the edited extension's blocks"
assert b_vm == a_vm, "voicemail file changed OUTSIDE the edited extension's line"
print("surgical: only the edited extension's blocks moved")

# asterisk sees it
out = subprocess.run(["asterisk", "-rx", "pjsip show endpoint T2_101"], capture_output=True, text=True).stdout
assert "ZZ Edit Accept" in out, "pjsip endpoint does not show the new callerid after reload"
db = subprocess.run(["asterisk", "-rx", "database get %s/extensions/%s name" % (m1["hash"], EXT)], capture_output=True, text=True).stdout
assert "ZZ Edit Accept" in db, "AstDB name key not updated: %r" % db
print("asterisk: endpoint callerid + AstDB name updated live")

# ---------- revert ----------
res2 = mw.edit_extension(conn, T, EXT,
                         set={"name": orig["name"], "email": orig["email"], "internal_cid": orig["internal_cid"]},
                         vm={"password": orig["vm_password"]},
                         devices=[{"device_id": dev0[0]["device_id"], "secret": orig["desk_secret"], "description": orig["desk_desc"]}])
applied2 = mw.apply_extension_edit_pbx(conn_ro, T, EXT, target_dir=CONF)
assert sha(PJ) == snap["pj_sha"], "pjsip file NOT byte-identical after revert"
assert sha(VMF) == snap["vm_sha"], "voicemail file NOT byte-identical after revert"
row2 = mw.q1(conn_ro, "select name, email, internal_cid from ombu_extensions where tenant_id=%s and extension=%s", (T, EXT))
assert row2["name"] == orig["name"] and (row2["email"] or "") == orig["email"]
db2 = subprocess.run(["asterisk", "-rx", "database get %s/extensions/%s name" % (m1["hash"], EXT)], capture_output=True, text=True).stdout
assert orig["name"] in db2
print("revert: files byte-identical to snapshot, rows + AstDB restored")
print("ACCEPTANCE PASS")
