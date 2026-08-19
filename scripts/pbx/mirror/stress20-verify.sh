#!/usr/bin/env bash
# Verify the 20x10 stress tenants on the PBX. Reads the manifest given as $1.
# Twin of stress-verify.sh with the 10-extension expectations (20 endpoints /
# 10 exts / 20 devices per tenant) — and the manifest path actually honoured
# (the 10x5 version hardcoded /root/stress-manifest.json inside the python).
set -uo pipefail
MF="${1:-/root/stress20-manifest.json}"
asterisk -rx "module reload res_pjsip.so" >/dev/null 2>&1; sleep 4
python3 - "$MF" <<'PY'
import json, subprocess, sys
def sh(c):
    return subprocess.run(c, shell=True, capture_output=True, text=True).stdout
def q(sql):
    return subprocess.run(["mysql","-N","-B","ombutel","-e",sql], capture_output=True, text=True).stdout.strip()
mf=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok=True
eps = sh("asterisk -rx 'pjsip show endpoints'")
hints = sh("asterisk -rx 'core show hints'")
for m in mf:
    slug, path = m["slug"], m["tenantPath"]
    t = q(f"select tenant_id from ombu_tenants where path='{path}'")
    files = int(sh(f"ls /etc/asterisk/vitalpbx/ | grep -c -- '-{t}-'").strip() or 0)
    epd = sum(1 for l in eps.splitlines() if f"Endpoint:  T{t}_" in l)
    exts = q(f"select count(*) from ombu_extensions where tenant_id={t}")
    devs = q(f"select count(*) from ombu_devices d join ombu_extensions e on e.extension_id=d.extension_id where e.tenant_id={t}")
    vm = sh(f"asterisk -rx 'voicemail show users for {slug}-voicemail'").count("=>") or len([l for l in sh(f"asterisk -rx 'voicemail show users for {slug}-voicemail'").splitlines() if l.startswith(slug)])
    hint_n = sum(1 for l in hints.splitlines() if f"T{t}_" in l)
    route = sh(f"asterisk -rx 'dialplan show T{t}_incoming-calls'").count(m["did"])
    cos = sh(f"asterisk -rx 'dialplan show T{t}_cos-all-init'").count("Gosub")
    astdb = int(sh(f"asterisk -rx 'database show {path}'").count("/"))
    line_ok = files==17 and epd==20 and exts=="10" and devs=="20" and route>=1 and cos>=1
    ok = ok and line_ok
    print(f"{slug} t={t}: files={files}/17 endpoints={epd}/20 exts={exts}/10 devices={devs}/20 vm_users={vm} hints={hint_n} inbound={route} cos={'ok' if cos else 'MISSING'} astdb_keys~{astdb} -> {'PASS' if line_ok else 'FAIL'}")
print("DOORWAYS:", {f"T{t}": sh(f"asterisk -rx 'dialplan show T{t}_incoming-calls'").count("custom-contexts,cc-") for t in (2,35,105)})
print("OVERALL:", "PASS" if ok else "FAIL")
PY
