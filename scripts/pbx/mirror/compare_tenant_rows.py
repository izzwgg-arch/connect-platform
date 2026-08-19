#!/usr/bin/env python3
"""
compare_tenant_rows.py --a 106 --b 107

Row-shape comparison of two tenants across every ombutel table that carries a tenant_id
(plus the extension/device child tables reached through extension_id/device_id). Prints, per
table, the columns whose values differ between the two tenants' rows (matched positionally in
id order), after masking the values that MUST differ (ids, names, path, DIDs, secrets, timestamps).
Used to validate mirror_writes.create_tenant()/add_extension() against a panel-made tenant.
"""
import argparse, os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vitalpbx_mirror as vm

MASK_COLS = {"tenant_id", "path", "name", "description", "did", "secret", "password", "features_password",
             "portal_password", "user", "email", "extension_id", "device_id", "destination_id", "id",
             "class_of_service_id", "dial_profile_id", "parking_lot_id", "ars_id", "inbound_route_id",
             "number_id", "internal_cid", "mailbox", "context", "setting_id", "value_masked", "assigned_exten",
             "extension", "number", "index", "outbound_profiles"}

def rows(conn, table, where, args):
    return vm.q(conn, "select * from %s where %s" % (table, where), args)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", type=int, required=True); ap.add_argument("--b", type=int, required=True)
    ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=3307)
    a = ap.parse_args()
    conn = vm.connect(a.host, a.port)
    tables = [r["table_name"] if "table_name" in r else r["TABLE_NAME"] for r in vm.q(conn,
        "select table_name from information_schema.columns where table_schema=database() and column_name='tenant_id' order by 1")]
    bad = 0
    for t in tables:
        ra = rows(conn, t, "tenant_id=%s", (a.a,)); rb = rows(conn, t, "tenant_id=%s", (a.b,))
        if not ra and not rb: continue
        if t == "ombu_tenant_settings":
            ra.sort(key=lambda r: r["name"]); rb.sort(key=lambda r: r["name"])
        elif t == "ombu_numbers":
            ra.sort(key=lambda r: (r["module_id"], r["number"])); rb.sort(key=lambda r: (r["module_id"], r["number"]))
        elif t == "ombu_queued_changes":
            ra.sort(key=lambda r: r["module_id"]); rb.sort(key=lambda r: r["module_id"])
        elif t == "ombu_inbound_routes":
            ra.sort(key=lambda r: (r["did"] is not None, r["inbound_route_id"])); rb.sort(key=lambda r: (r["did"] is not None, r["inbound_route_id"]))
        elif t == "ombu_devices":
            ra.sort(key=lambda r: r["profile_id"] or 0); rb.sort(key=lambda r: r["profile_id"] or 0)
        status = "same-count" if len(ra) == len(rb) else "COUNT %d vs %d" % (len(ra), len(rb))
        diffs = []
        for i, (x, y) in enumerate(zip(ra, rb)):
            for c in x:
                if c in MASK_COLS: continue
                if x[c] != y.get(c):
                    diffs.append("row%d.%s: %r vs %r" % (i, c, x[c], y.get(c)))
        if diffs or "COUNT" in status: bad += 1
        print("%-36s %-16s %s" % (t, status, "; ".join(diffs) if diffs else "identical (masked cols aside)"))
    # child tables via extension/device ids
    ea = vm.q(conn, "select extension_id from ombu_extensions where tenant_id=%s order by extension_id", (a.a,))
    eb = vm.q(conn, "select extension_id from ombu_extensions where tenant_id=%s order by extension_id", (a.b,))
    for x, y in zip(ea, eb):
        for t in ("ombu_extensions_vm", "ombu_followme", "ombu_extension_diversions", "ombu_extensions_contact_info", "ombu_extension_pea"):
            ra = rows(conn, t, "extension_id=%s", (x["extension_id"],)); rb = rows(conn, t, "extension_id=%s", (y["extension_id"],))
            if t == "ombu_extension_diversions":
                ra.sort(key=lambda r: r["name"]); rb.sort(key=lambda r: r["name"])
            diffs = [("row%d.%s: %r vs %r" % (i, c, p[c], q.get(c))) for i, (p, q) in enumerate(zip(ra, rb)) for c in p if c not in MASK_COLS and p[c] != q.get(c)]
            status = "same-count" if len(ra) == len(rb) else "COUNT %d vs %d" % (len(ra), len(rb))
            print("%-36s %-16s %s" % (t, status, "; ".join(diffs) if diffs else "identical (masked cols aside)"))
        da = vm.q(conn, "select device_id from ombu_devices where extension_id=%s order by profile_id", (x["extension_id"],))
        db = vm.q(conn, "select device_id from ombu_devices where extension_id=%s order by profile_id", (y["extension_id"],))
        for p, q in zip(da, db):
            ra = rows(conn, "ombu_pjsip_devices", "device_id=%s", (p["device_id"],)); rb = rows(conn, "ombu_pjsip_devices", "device_id=%s", (q["device_id"],))
            diffs = [("%s: %r vs %r" % (c, r1[c], r2.get(c))) for r1, r2 in zip(ra, rb) for c in r1 if c not in MASK_COLS and r1[c] != r2.get(c)]
            print("%-36s %-16s %s" % ("ombu_pjsip_devices", "same-count" if len(ra)==len(rb) else "COUNT", "; ".join(diffs) if diffs else "identical (masked cols aside)"))
    sa = vm.q(conn, "select module_id, substring(name, locate('_',name)+1) n, value from ombu_settings where name like %s order by module_id, n", ("T%d\_%%" % a.a,))
    sb = vm.q(conn, "select module_id, substring(name, locate('_',name)+1) n, value from ombu_settings where name like %s order by module_id, n", ("T%d\_%%" % a.b,))
    print("%-36s %s" % ("ombu_settings T<t>_*", "A=%s  B=%s" % ([(r["module_id"], r["n"], r["value"]) for r in sa], [(r["module_id"], r["n"], r["value"]) for r in sb])))
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
