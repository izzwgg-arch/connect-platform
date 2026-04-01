#!/usr/bin/env python3
"""
Per-call PBX vs Connect diff — TODAY only (midnight ET = UTC+4).
Hardcoded startSec=1774843200 (2026-03-30T04:00:00Z = midnight EDT).
"""
import json, re, subprocess, sys, urllib.request, urllib.error

API_BASE  = "http://localhost:3001"
ENV_PATH  = "/opt/connectcomms/env/.env.platform"
START_SEC = 1774843200   # 2026-03-30T04:00:00Z = midnight EDT
END_SEC   = START_SEC + 7200  # 2-hour window ceiling (calls only ~15 min old)

import time as _time
END_SEC = int(_time.time()) + 60  # actual now + buffer

def get_token():
    text = open(ENV_PATH).read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    secret = m.group(1).strip()
    req = urllib.request.Request(
        f"{API_BASE}/admin/dev/generate-observe-token",
        data=json.dumps({"secret": secret}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["token"]

def api_get(path, token, timeout=120):
    req = urllib.request.Request(f"{API_BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    resp = urllib.request.urlopen(req, timeout=timeout)
    return json.loads(resp.read())

def db_query(sql):
    r = subprocess.run(
        ["docker", "exec", "-i", "connectcomms-postgres",
         "psql", "-U", "connectcomms", "-d", "connectcomms",
         "--csv", "-c", sql],
        capture_output=True, text=True
    )
    if r.returncode != 0 or "ERROR" in r.stderr:
        print(f"  DB ERR: {r.stderr[:200]}")
        return []
    lines = [l for l in r.stdout.strip().split("\n") if l.strip()]
    if len(lines) < 2:
        return []
    headers = [h.strip('"') for h in lines[0].split(",")]
    rows = []
    for line in lines[1:]:
        # naive CSV split — ok for these fields
        parts = line.split(",")
        row = {}
        for i, h in enumerate(headers):
            row[h] = parts[i].strip('"') if i < len(parts) else ""
        rows.append(row)
    return rows

def main():
    print(f"\n{'='*72}")
    print(f"  LIVE PBX vs CONNECT — TODAY (midnight EDT onward)")
    print(f"  Window: 2026-03-30T04:00:00Z (startSec={START_SEC}) → now")
    print(f"{'='*72}\n")

    token = get_token()

    # ── 1. Connect dashboard KPIs ─────────────────────────────────────────────
    kpis = api_get("/dashboard/call-kpis?mode=canonical", token, timeout=15)
    print("CONNECT DASHBOARD (what user sees right now):")
    print(f"  incoming={kpis.get('incomingToday')}  outgoing={kpis.get('outgoingToday')}  "
          f"internal={kpis.get('internalToday')}  missed={kpis.get('missedToday')}  "
          f"scope={kpis.get('scope')}  asOf={kpis.get('asOf')}")

    # ── 2. ConnectCdr rows in today's window ──────────────────────────────────
    connect_rows = db_query(
        f'SELECT "linkedId","tenantId","direction","fromNumber","toNumber",'
        f'"startedAt","durationSec","disposition","rawLegCount" '
        f'FROM "ConnectCdr" '
        f'WHERE "startedAt" >= TO_TIMESTAMP({START_SEC}) '
        f'  AND "startedAt" < TO_TIMESTAMP({END_SEC}) '
        f'ORDER BY "startedAt" ASC'
    )
    print(f"\nConnectCdr rows in today's window ({len(connect_rows)} rows):")
    dir_counts = {}
    tenant_null = 0
    for r in connect_rows:
        d = r.get("direction","?"); dir_counts[d] = dir_counts.get(d,0)+1
        if not r.get("tenantId") or r.get("tenantId") == "": tenant_null += 1
    print(f"  Direction breakdown: {dir_counts}")
    print(f"  Null tenantId: {tenant_null}")

    # ── 3. KPI query — what the dashboard actually counts ─────────────────────
    # The dashboard counts using the timezone-based today window.
    # Show those rows directly with a timezone-aware query.
    kpi_rows = db_query(
        f'SELECT "linkedId","tenantId","direction","fromNumber","toNumber","startedAt","durationSec" '
        f'FROM "ConnectCdr" '
        f'WHERE "startedAt" >= TO_TIMESTAMP({START_SEC}) '
        f'  AND "startedAt" < TO_TIMESTAMP({END_SEC}) '
        f'ORDER BY "startedAt" ASC'
    )
    connect_by_linked = {r["linkedId"]: r for r in kpi_rows}

    # ── 4. PBX CDRs via reconciliation ───────────────────────────────────────
    print(f"\nFetching PBX CDRs (may take 30-60s for all tenants)...")
    try:
        recon = api_get(
            f"/admin/diagnostics/cdr-pipeline-reconciliation?startSec={START_SEC}&endSec={END_SEC}",
            token, timeout=300
        )
    except Exception as e:
        print(f"  ERROR: {e}")
        recon = None

    if not recon:
        print("  Could not reach reconciliation endpoint.")
    else:
        totals = recon.get("section1_totals", {})
        tw     = recon.get("section1_timeWindow", {})
        mm     = recon.get("section4_sampleMismatches", {})
        counts = recon.get("counts", {})
        loss   = recon.get("section3_topLossPoints", [])

        pbx_raw    = totals.get("pbxRawRowsFromApi", 0)
        pbx_unique = totals.get("pbxCanonicalCalls", 0)
        pbx_dir    = totals.get("pbxByDirection", {})
        conn_total = totals.get("connectCdrRows", 0)
        conn_dir   = totals.get("connectByDirection", {})

        print(f"\n{'─'*72}")
        print(f"  SIDE-BY-SIDE COMPARISON")
        print(f"{'─'*72}")
        print(f"  {'Direction':<14} {'PBX unique':>12}  {'PBX raw legs':>12}  {'Connect':>10}  {'Delta':>8}")
        print(f"  {'─'*60}")
        for d in ["incoming","outgoing","internal","unknown"]:
            pu   = pbx_dir.get(d,0)
            conv = conn_dir.get(d,0)
            diff = conv - pu
            ds   = f"{'+' if diff>0 else ''}{diff}" if diff!=0 else "✓ match"
            print(f"  {d:<14} {str(pu):>12}  {str(pbx_raw if d=='incoming' else ''):>12}  {str(conv):>10}  {ds:>8}")
        print(f"  {'TOTAL':<14} {str(pbx_unique):>12}  {str(pbx_raw):>12}  {str(conn_total):>10}")

        print(f"\n  Tenants: {', '.join(tw.get('tenantsTargeted',[]))}")
        for e in tw.get("tenantFetchErrors",[]): print(f"  ⚠ {e}")

        missing   = mm.get("missingFromConnect", [])
        mismatch  = mm.get("misclassified", [])
        null_t    = mm.get("tenantNull", [])

        # ── 5. Missing calls table ────────────────────────────────────────────
        print(f"\n{'─'*72}")
        n_missing = counts.get("missingPbxCanonicalNotInConnect",0)
        print(f"  PBX CALLS MISSING FROM CONNECT ({n_missing})")
        print(f"{'─'*72}")
        if missing:
            print(f"  {'linkedId':<28} {'PBX-dir':<10} {'from':<14} {'to':<16} {'calldate'}")
            for r in missing[:20]:
                lid = str(r.get("linkedId") or r.get("pbxLinkedId","?"))[:27]
                pd  = str(r.get("pbxDirection","?"))[:9]
                frm = str(r.get("from") or r.get("src","?"))[:13]
                to_ = str(r.get("to") or r.get("dst","?"))[:15]
                ts  = str(r.get("calldate") or r.get("startedAt","?"))[:20]
                print(f"  {lid:<28} {pd:<10} {frm:<14} {to_:<16} {ts}")
        else:
            print("  NONE — all PBX calls are present in Connect (no data loss)")

        # ── 6. Direction mismatches ───────────────────────────────────────────
        print(f"\n{'─'*72}")
        n_mis = counts.get("misclassifiedDirection",0)
        print(f"  DIRECTION MISMATCHES PBX↔Connect ({n_mis})")
        print(f"{'─'*72}")
        if mismatch:
            print(f"  {'linkedId':<28} {'PBX':<10} {'Connect':<12} {'from':<14} {'to':<16}")
            for r in mismatch[:20]:
                lid = str(r.get("linkedId","?"))[:27]
                pd  = str(r.get("pbxDirection","?"))[:9]
                cd  = str(r.get("connectDirection","?"))[:11]
                frm = str(r.get("from") or r.get("src","?"))[:13]
                to_ = str(r.get("to") or r.get("dst","?"))[:15]
                print(f"  {lid:<28} {pd:<10} {cd:<12} {frm:<14} {to_:<16}")
        else:
            print("  NONE in sample")

        # ── 7. Loss points ───────────────────────────────────────────────────
        print(f"\n{'─'*72}")
        print(f"  TOP LOSS POINTS")
        print(f"{'─'*72}")
        for lp in loss:
            c = lp.get("count",0)
            if c > 0:
                print(f"  [{c:>3}]  {lp.get('cause',''):<45}  {lp.get('note','')[:60]}")

    # ── 8. Full per-call breakdown of all today's Connect rows ────────────────
    print(f"\n{'─'*72}")
    print(f"  ALL CONNECT CDR ROWS TODAY ({len(connect_rows)})")
    print(f"  (These are the rows the KPI query counts)")
    print(f"{'─'*72}")
    if connect_rows:
        print(f"  {'#':<3} {'linkedId':<28} {'dir':<10} {'from':<12} {'to':<16} {'tenant':<22} {'dur':>4} {'startedAt (UTC)'}")
        print(f"  {'─'*108}")
        for i, r in enumerate(connect_rows, 1):
            lid = str(r.get("linkedId","?"))[:27]
            d   = str(r.get("direction","?"))[:9]
            frm = str(r.get("fromNumber","?"))[:11]
            to_ = str(r.get("toNumber","?"))[:15]
            ten = str(r.get("tenantId") or "⚠ NULL")[:21]
            dur = str(r.get("durationSec","?"))[:4]
            ts  = str(r.get("startedAt","?"))[:22]
            flag = ""
            # Flags: likely outgoing stored as incoming
            from_short = len((r.get("fromNumber") or "").replace("+","").replace(" ","")) <= 6
            to_long    = len((r.get("toNumber") or "").replace("+","").replace(" ","")) >= 10
            if r.get("direction") == "incoming" and from_short and to_long:
                flag = " ← ⚠ short-ext→long PSTN stored as incoming?"
            if not r.get("tenantId") or r.get("tenantId") == "":
                flag += " [NULL tenant — excluded from KPI]"
            print(f"  {str(i):<3} {lid:<28} {d:<10} {frm:<12} {to_:<16} {ten:<22} {dur:>4} {ts}{flag}")
    else:
        print("  (no ConnectCdr rows in today's window)")

    # ── 9. Root cause summary ─────────────────────────────────────────────────
    print(f"\n{'─'*72}")
    print(f"  ROOT CAUSE SUMMARY")
    print(f"{'─'*72}")
    print(f"  Connect dashboard says: in={kpis.get('incomingToday')} out={kpis.get('outgoingToday')} int={kpis.get('internalToday')}")
    print(f"  ConnectCdr has in today's window: {dir_counts}")
    kpi_in  = kpis.get('incomingToday',0)
    kpi_out = kpis.get('outgoingToday',0)
    db_in   = dir_counts.get('incoming',0)
    db_out  = dir_counts.get('outgoing',0)
    if db_out > kpi_out:
        print(f"\n  ❌ OUTGOING GAP: ConnectCdr has {db_out} outgoing rows BUT dashboard shows {kpi_out}")
        print(f"     Explanation: Check if ConnectCdr startedAt timestamps fall within the KPI query window.")
        print(f"     KPI window = timezone-based 'today'. If server timezone ≠ ET, the window edges differ.")
        # Show the exact startedAt values for outgoing rows
        out_rows = [r for r in connect_rows if r.get("direction")=="outgoing"]
        if out_rows:
            print(f"     Outgoing rows startedAt (UTC):")
            for r in out_rows:
                print(f"       {r.get('startedAt','')}  from={r.get('fromNumber','')}  to={r.get('toNumber','')}  tenant={r.get('tenantId') or 'NULL'}")

    if db_in != kpi_in:
        print(f"\n  ❌ INCOMING DISCREPANCY: ConnectCdr has {db_in} incoming but dashboard shows {kpi_in}")
        print(f"     This means KPI query is using a different time window than our DB query.")

    if tenant_null > 0:
        print(f"\n  ⚠  NULL TENANT: {tenant_null} ConnectCdr rows have no tenantId")
        print(f"     These ARE included in global KPI but are invisible on per-tenant dashboards")

    print()

if __name__ == "__main__":
    main()
