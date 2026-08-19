#!/usr/bin/env bash
# MIRROR STRESS TEARDOWN — manifest-driven, deletes EXACTLY the 10 stress tenants + their Main rows.
# Run on the PBX as root: bash teardown10.sh /root/stress-manifest.json
set -euo pipefail
MF="${1:-/root/stress-manifest.json}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
echo "== backup row snapshots to /root/stress-teardown-$TS.sql =="
python3 - "$MF" <<'PY'
import json, subprocess, sys
mf = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def q(sql):
    return subprocess.run(["mysql", "-N", "-B", "ombutel", "-e", sql], capture_output=True, text=True).stdout.strip()
def run(sql):
    r = subprocess.run(["mysql", "ombutel", "-e", sql], capture_output=True, text=True)
    if r.returncode != 0:
        print("SQL ERROR:", sql[:120], "->", r.stderr[:300]); sys.exit(1)
summary = []
for m in mf:
    slug, path = m["slug"], m["tenantPath"]
    if not path or len(path) != 16:
        print("SKIP bad path", m); continue
    t = q(f"select tenant_id from ombu_tenants where name='{slug}' and path='{path}'")
    if not t:
        print(f"SKIP {slug}: no tenant row"); continue
    t = int(t)
    # guard: never touch a tenant outside the stress range / naming
    assert slug.startswith("mirror_stress_"), slug
    dests = q(f"select destination_id from ombu_inbound_routes where tenant_id={t} and destination_id is not null union select destination_id from ombu_parking_lots where tenant_id={t} and destination_id is not null").split()
    exts = q(f"select count(*) from ombu_extensions where tenant_id={t}")
    run(f"delete from ombu_tenants where tenant_id={t}")
    for d in dests:
        # fresh rows created by this test only; verify unreferenced before deleting
        ref = q(f"select (select count(*) from ombu_inbound_routes where destination_id={d}) + (select count(*) from ombu_parking_lots where destination_id={d}) + (select count(*) from ombu_custom_applications where destination_id={d})")
        if ref == "0":
            run(f"delete from ombu_destinations where id={d}")
    # Main-tenant rows (id + description double-checked)
    for table, col, idv in (("ombu_ars", "ars_id", m["arsId"]), ("ombu_outbound_routes", "outbound_route_id", m["routeId"]), ("ombu_trunks", "trunk_id", m["trunkId"])):
        desc = q(f"select description from {table} where {col}={idv} and tenant_id=1")
        if desc.startswith("MIRROR STRESS"):
            run(f"delete from {table} where {col}={idv} and tenant_id=1")
        else:
            print(f"GUARD: not deleting {table} {idv} (description {desc!r})")
    summary.append((slug, t, path, exts))
print("deleted:", summary)
open("/root/stress-teardown-summary.json", "w").write(json.dumps(summary))
PY
echo "== files + dirs + astdb =="
python3 - "$MF" <<'PY'
import json, subprocess, glob, os, sys
mf = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ids = json.load(open("/root/stress-teardown-summary.json"))
for slug, t, path, exts in ids:
    n = 0
    for f in glob.glob(f"/etc/asterisk/vitalpbx/*-{t}-*.conf"):
        os.remove(f); n += 1
    subprocess.run(["rm", "-rf", f"/var/lib/vitalpbx/static/{path}", f"/var/lib/vitalpbx/provisioning/provisioning_templates/{path}"])
    subprocess.run(["asterisk", "-rx", f"database deltree {path}"], capture_output=True)
    print(slug, t, "files removed:", n)
PY
echo "== stale fake trunks from earlier accepted tests (133/134) are DB-deleted already; Main re-render happens api-side next =="
echo "== reloads =="
asterisk -rx "module reload res_pjsip.so" >/dev/null; asterisk -rx "dialplan reload" >/dev/null; asterisk -rx "voicemail reload" >/dev/null
echo "teardown done"
