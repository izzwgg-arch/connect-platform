#!/usr/bin/env python3
"""
True PBX vs Connect diff for March 29 (America/New_York).
Runs on the server via SSH — requires python3 and curl.
Calls:
  1. cdr-pipeline-reconciliation for March 29 (PBX CDR API + ConnectCdr join)
  2. Parses and presents a clean diff report with concrete examples
"""
import json, subprocess, sys, os

API = "http://localhost:3001"

def get_token():
    env_path = "/opt/connectcomms/env/.env.platform"
    text = open(env_path).read()
    import re
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    secret = m.group(1).strip()
    import urllib.request
    req = urllib.request.Request(
        f"{API}/admin/dev/generate-observe-token",
        data=json.dumps({"secret": secret}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())["token"]

def call_api(path, token, timeout_sec=300):
    r = subprocess.run(
        ["curl", "-sf", "--max-time", str(timeout_sec),
         "-H", f"Authorization: Bearer {token}", f"{API}{path}"],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        raise SystemExit(f"curl failed (rc={r.returncode}): {r.stderr[:200]}")
    try:
        return json.loads(r.stdout)
    except Exception as e:
        raise SystemExit(f"JSON parse error: {e}\nBody: {r.stdout[:400]}")

def pct(a, b):
    if b == 0: return "n/a"
    return f"{100*a/b:.1f}%"

def main():
    print("Getting auth token...")
    token = get_token()

    # March 29 ET = UTC+4: 2026-03-29T04:00:00Z to 2026-03-30T04:00:00Z
    # startSec / endSec
    start_sec = 1774756800  # 2026-03-29T04:00:00Z
    end_sec   = 1774843200  # 2026-03-30T04:00:00Z

    print(f"\nFetching PBX CDR data + Connect data for March 29 ET...")
    print(f"startSec={start_sec} ({start_sec}), endSec={end_sec}")
    print("(This may take several minutes for gesheft tenant — chunked fallback is active)\n")

    recon = call_api(
        f"/admin/diagnostics/cdr-pipeline-reconciliation?startSec={start_sec}&endSec={end_sec}",
        token,
        timeout_sec=600
    )

    totals = recon.get("section1_totals", {})
    tw     = recon.get("section1_timeWindow", {})
    mismatches = recon.get("section4_sampleMismatches", {})
    loss   = recon.get("section3_topLossPoints", [])
    counts = recon.get("counts", {})

    print("=" * 70)
    print("  REAL PBX vs REAL CONNECT  —  March 29, America/New_York")
    print("=" * 70)
    print(f"\nWindow: {tw.get('dayStartUtc','?')} → {tw.get('dayEndExclusiveUtc','?')}")
    print(f"PBX tenants targeted: {', '.join(tw.get('tenantsTargeted', []))}")

    pbx_raw     = totals.get("pbxRawRowsFromApi", 0)
    pbx_unique  = totals.get("pbxCanonicalCalls", 0)
    pbx_dir     = totals.get("pbxByDirection", {})
    conn_rows   = totals.get("connectCdrRows", 0)
    conn_dir    = totals.get("connectByDirection", {})
    conn_raw_legs = totals.get("connectRawLegTotal", conn_rows)

    print(f"""
┌─────────────────────────────────────────────────────────────────────┐
│  SECTION 1 — TOTALS (same time window)                              │
├─────────────────────────────────────────────────────────────────────┤
│                          PBX (raw CDR)   PBX (unique)   Connect      │
│  Total calls:            {str(pbx_raw).rjust(10)}   {str(pbx_unique).rjust(10)}   {str(conn_rows).rjust(7)}     │
│  Incoming:               {str(pbx_dir.get('incoming',0)).rjust(10)}   {str(pbx_dir.get('incoming',0)).rjust(10)}   {str(conn_dir.get('incoming',0)).rjust(7)}     │
│  Outgoing:               {str(pbx_dir.get('outgoing',0)).rjust(10)}   {str(pbx_dir.get('outgoing',0)).rjust(10)}   {str(conn_dir.get('outgoing',0)).rjust(7)}     │
│  Internal:               {str(pbx_dir.get('internal',0)).rjust(10)}   {str(pbx_dir.get('internal',0)).rjust(10)}   {str(conn_dir.get('internal',0)).rjust(7)}     │
│  Unknown:                {"n/a".rjust(10)}   {"n/a".rjust(10)}   {str(conn_dir.get('unknown',0)).rjust(7)}     │
├─────────────────────────────────────────────────────────────────────┤
│  PBX raw/unique ratio:   {f'{pbx_raw/max(pbx_unique,1):.2f}x':<10}                              │
│  Connect raw leg total:  {str(conn_raw_legs).rjust(10)}   (should ≈ PBX raw if all ingested)    │
│  Connect vs PBX unique:  {pct(conn_rows, pbx_unique).rjust(10)}   match rate                     │
└─────────────────────────────────────────────────────────────────────┘""")

    missing_count      = counts.get("missingPbxCanonicalNotInConnect", 0)
    misclassified_count = counts.get("misclassifiedDirection", 0)
    only_connect       = counts.get("onlyInConnectNotInPbx", 0)
    null_tenant        = counts.get("connectTenantNull", 0)
    dir_unknown        = counts.get("connectDirectionUnknown", 0)

    print(f"""
┌─────────────────────────────────────────────────────────────────────┐
│  SECTION 2 — DIFF SUMMARY                                           │
├─────────────────────────────────────────────────────────────────────┤
│  PBX calls missing from Connect:            {str(missing_count).rjust(6)}                    │
│  Direction mismatch (PBX vs Connect):       {str(misclassified_count).rjust(6)}                    │
│  Connect calls not in PBX window:           {str(only_connect).rjust(6)}                    │
│  Connect rows with null tenant:             {str(null_tenant).rjust(6)}   ({pct(null_tenant,conn_rows)} of Connect)  │
│  Connect rows with unknown direction:       {str(dir_unknown).rjust(6)}                    │
└─────────────────────────────────────────────────────────────────────┘""")

    print(f"\n── SECTION 3 — TOP LOSS POINTS (ranked) ──")
    for lp in loss[:8]:
        print(f"  [{str(lp.get('count',0)).rjust(4)}]  {lp.get('cause','')}  —  {lp.get('note','')[:80]}")

    # PBX outgoing calls — concrete 20-call sample
    missing_from_connect = mismatches.get("missingFromConnect", [])
    misclassified_sample = mismatches.get("misclassified", [])
    only_in_connect      = mismatches.get("onlyInConnectLinkedIdsSample", [])
    null_tenant_sample   = mismatches.get("tenantNull", [])

    print(f"\n── SECTION 4A — PBX CALLS MISSING FROM CONNECT (up to 20) ──")
    if missing_from_connect:
        print(f"{'linkedId':<28} {'PBX-dir':<10} {'from':<16} {'to':<16} {'started':<22}")
        print("-" * 95)
        for r in missing_from_connect[:20]:
            lid = (r.get("linkedId") or r.get("pbxLinkedId") or "?")[:27]
            d   = r.get("pbxDirection","?")[:9]
            frm = (r.get("from") or r.get("src") or "?")[:15]
            to  = (r.get("to") or r.get("dst") or "?")[:15]
            ts  = (r.get("calldate") or r.get("startedAt") or "?")[:21]
            print(f"{lid:<28} {d:<10} {frm:<16} {to:<16} {ts:<22}")
    else:
        print("  (none — all PBX calls found in Connect)")

    print(f"\n── SECTION 4B — DIRECTION MISMATCHES (PBX says X, Connect stored Y) ──")
    if misclassified_sample:
        print(f"{'linkedId':<28} {'PBX-dir':<10} {'Connect-dir':<13} {'from':<16} {'to':<16}")
        print("-" * 90)
        for r in misclassified_sample[:20]:
            lid = (r.get("linkedId") or r.get("pbxLinkedId") or "?")[:27]
            pbx_d = r.get("pbxDirection","?")[:9]
            con_d = r.get("connectDirection","?")[:12]
            frm   = (r.get("from") or r.get("src") or "?")[:15]
            to    = (r.get("to") or r.get("dst") or "?")[:15]
            print(f"{lid:<28} {pbx_d:<10} {con_d:<13} {frm:<16} {to:<16}")
    else:
        print("  (none found in sample)")

    print(f"\n── SECTION 4C — NULL TENANT SAMPLE (invisible on per-tenant dashboard) ──")
    if null_tenant_sample:
        print(f"{'linkedId':<28} {'direction':<12} {'from':<16} {'to':<16}")
        print("-" * 75)
        for r in null_tenant_sample[:10]:
            lid = (r.get("linkedId") or "?")[:27]
            d   = r.get("direction","?")[:11]
            frm = (r.get("fromNumber") or "?")[:15]
            to  = (r.get("toNumber") or "?")[:15]
            print(f"{lid:<28} {d:<12} {frm:<16} {to:<16}")

    print(f"\n── TENANT FETCH ERRORS ──")
    for e in tw.get("tenantFetchErrors", []):
        print(f"  {e}")
    pnotes = tw.get("paginationNotesByTenant", {})
    for t, note in pnotes.items():
        if note: print(f"  [{t}] {note}")

    print(f"\n── BOTTOM LINE ──")
    if missing_count == 0 and misclassified_count == 0:
        print(f"  Zero missing calls, zero direction mismatches in the joined set.")
        print(f"  PBX raw rows ({pbx_raw}) / Connect unique calls ({conn_rows}) ratio = {pbx_raw/max(conn_rows,1):.2f}x")
        print(f"  This ratio IS the counting model difference (PBX counts legs; Connect deduplicates).")
        print(f"  To match PBX dashboard totals, Connect would need to show SUM(rawLegCount) not COUNT(*).")
    else:
        print(f"  {missing_count} PBX calls not found in Connect (data loss).")
        print(f"  {misclassified_count} direction mismatches between PBX and Connect.")
        if null_tenant > 0:
            print(f"  {null_tenant} Connect rows have null tenant (invisible on tenant-scoped dashboards).")

if __name__ == "__main__":
    main()
