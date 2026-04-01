#!/usr/bin/env python3
"""
Live per-call PBX vs Connect diff for TODAY only.
Runs on the app server. Reads PBX credentials from the server .env,
calls the PBX CDR REST API directly, queries ConnectCdr via psql,
and shows a row-by-row comparison.
"""
import json, re, subprocess, sys, time, urllib.request, urllib.error, datetime

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE   = "http://localhost:3001"
DB_URL     = "postgresql://connectcomms:connectcomms@127.0.0.1:5432/connectcomms"
ENV_PATH   = "/opt/connectcomms/env/.env.platform"
# "today" in America/New_York starts at midnight ET = UTC+4h
# startSec = 2026-03-30T04:00:00Z
# Use the rolling today: compute midnight ET for today
import time as _time
NOW_UTC     = datetime.datetime.utcnow()
# America/New_York offset: standard time is UTC-5, daylight time is UTC-4
# March 30 2026 = DST active (clocks spring forward 2026-03-08 in US)
ET_OFFSET_H = 4   # EDT = UTC-4
# Midnight ET today
midnight_et = datetime.datetime(NOW_UTC.year, NOW_UTC.month, NOW_UTC.day, ET_OFFSET_H, 0, 0)
if NOW_UTC < midnight_et:
    # Before today's midnight ET — still "yesterday" ET
    midnight_et = midnight_et - datetime.timedelta(days=1)
TODAY_START_UTC = midnight_et
TODAY_END_UTC   = NOW_UTC + datetime.timedelta(minutes=1)  # include calls just now
START_SEC = int(TODAY_START_UTC.timestamp())
END_SEC   = int(TODAY_END_UTC.timestamp())

# ── Auth ──────────────────────────────────────────────────────────────────────
def get_token():
    text = open(ENV_PATH).read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found in " + ENV_PATH)
    secret = m.group(1).strip()
    req = urllib.request.Request(
        f"{API_BASE}/admin/dev/generate-observe-token",
        data=json.dumps({"secret": secret}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())["token"]

def api_get(path, token, timeout=60):
    req = urllib.request.Request(f"{API_BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} on {path}: {e.read()[:200]}")

# ── PBX client (reads credentials from server config) ─────────────────────────
def get_pbx_config():
    """Read VitalPBX base URL + credentials from the server environment."""
    env_text = open(ENV_PATH).read()
    # Also check the apps/api .env on the server
    try:
        api_env = open("/opt/connectcomms/app/apps/api/.env").read()
        env_text += "\n" + api_env
    except Exception:
        pass
    try:
        compose_env = open("/opt/connectcomms/app/.env").read()
        env_text += "\n" + compose_env
    except Exception:
        pass

    # Find VITALPBX_ config
    url    = re.search(r"^(?:VITALPBX_BASE_URL|PBX_BASE_URL)=(.+)$", env_text, re.M)
    user   = re.search(r"^(?:VITALPBX_API_USER|PBX_API_USER)=(.+)$", env_text, re.M)
    passwd = re.search(r"^(?:VITALPBX_API_PASSWORD|PBX_API_PASSWORD|VITALPBX_PASSWORD)=(.+)$", env_text, re.M)
    token_ = re.search(r"^(?:VITALPBX_API_TOKEN|PBX_API_TOKEN)=(.+)$", env_text, re.M)
    secret_= re.search(r"^(?:VITALPBX_API_SECRET|PBX_API_SECRET)=(.+)$", env_text, re.M)
    return {
        "base_url": url.group(1).strip() if url else None,
        "user":     user.group(1).strip() if user else None,
        "password": passwd.group(1).strip() if passwd else None,
        "token":    token_.group(1).strip() if token_ else None,
        "secret":   secret_.group(1).strip() if secret_ else None,
    }

# ── PBX CDR fetch via Connect API (uses cached credentials) ──────────────────
def fetch_pbx_cdrs_via_connect(token, start_sec, end_sec):
    """Use Connect's reconciliation endpoint to get PBX CDRs for today."""
    print(f"  Calling cdr-pipeline-reconciliation for startSec={start_sec} endSec={end_sec}...")
    path = f"/admin/diagnostics/cdr-pipeline-reconciliation?startSec={start_sec}&endSec={end_sec}"
    try:
        data = api_get(path, token, timeout=300)
    except Exception as e:
        print(f"  ERROR: {e}")
        return None
    return data

# ── ConnectCdr direct query ───────────────────────────────────────────────────
def query_connect_cdrs(start_sec, end_sec):
    """Direct psql query of ConnectCdr for the time window."""
    sql = f"""
COPY (
  SELECT 
    "linkedId",
    "tenantId",
    "direction",
    "disposition",
    "fromNumber",
    "toNumber",
    "startedAt",
    "durationSec",
    "rawLegCount"
  FROM "ConnectCdr"
  WHERE "startedAt" >= TO_TIMESTAMP({start_sec})
    AND "startedAt" < TO_TIMESTAMP({end_sec})
  ORDER BY "startedAt" ASC
) TO STDOUT WITH CSV HEADER
"""
    r = subprocess.run(
        ["docker", "exec", "-i", "connectcomms-postgres",
         "psql", "-U", "connectcomms", "-d", "connectcomms"],
        input=sql, capture_output=True, text=True
    )
    if r.returncode != 0:
        print(f"  psql error: {r.stderr[:300]}")
        return []
    rows = []
    lines = r.stdout.strip().split("\n")
    if len(lines) < 2:
        return []
    headers = lines[0].split(",")
    for line in lines[1:]:
        if not line.strip():
            continue
        parts = line.split(",")
        row = {}
        for i, h in enumerate(headers):
            row[h] = parts[i] if i < len(parts) else ""
        rows.append(row)
    return rows

# ── Dashboard KPI query ───────────────────────────────────────────────────────
def get_connect_kpis(token):
    return api_get("/dashboard/call-kpis?mode=canonical", token, timeout=15)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print(f"\n{'='*72}")
    print(f"  LIVE PBX vs CONNECT — TODAY ONLY")
    print(f"  Window: {TODAY_START_UTC.strftime('%Y-%m-%dT%H:%M:%SZ')} → {TODAY_END_UTC.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    print(f"  (Midnight EDT = UTC+4, so today starts at {TODAY_START_UTC.strftime('%H:%M UTC')})")
    print(f"{'='*72}\n")

    token = get_token()

    # ── Step 1: Connect dashboard KPIs right now ──────────────────────────────
    kpis = get_connect_kpis(token)
    print(f"CONNECT DASHBOARD (live):")
    print(f"  incoming={kpis.get('incomingToday',0)}  outgoing={kpis.get('outgoingToday',0)}  "
          f"internal={kpis.get('internalToday',0)}  missed={kpis.get('missedToday',0)}  "
          f"asOf={kpis.get('asOf','?')}")
    
    # ── Step 2: ConnectCdr direct query ──────────────────────────────────────
    print(f"\nConnectCdr rows for today's window (direct DB query):")
    connect_rows = query_connect_cdrs(START_SEC, END_SEC)
    connect_by_linked = {r["linkedId"]: r for r in connect_rows}
    print(f"  Total rows: {len(connect_rows)}")
    dir_counts = {}
    for r in connect_rows:
        d = r.get("direction","?")
        dir_counts[d] = dir_counts.get(d,0) + 1
    print(f"  By direction: {dir_counts}")
    
    # ── Step 3: PBX CDRs via reconciliation endpoint ──────────────────────────
    print(f"\nFetching PBX CDRs via reconciliation endpoint...")
    recon = fetch_pbx_cdrs_via_connect(token, START_SEC, END_SEC)

    if not recon:
        print("  Could not get reconciliation data. Showing ConnectCdr only.\n")
        print("CONNECT ROWS TODAY:")
        _print_connect_rows(connect_rows)
        return

    totals = recon.get("section1_totals", {})
    tw     = recon.get("section1_timeWindow", {})
    mm     = recon.get("section4_sampleMismatches", {})
    counts = recon.get("counts", {})
    loss   = recon.get("section3_topLossPoints", [])

    pbx_raw    = totals.get("pbxRawRowsFromApi", 0)
    pbx_unique = totals.get("pbxCanonicalCalls", 0)
    pbx_dir    = totals.get("pbxByDirection", {})
    conn_rows2 = totals.get("connectCdrRows", 0)
    conn_dir   = totals.get("connectByDirection", {})

    print(f"\n{'─'*72}")
    print(f"  PBX vs CONNECT SIDE BY SIDE (same window)")
    print(f"{'─'*72}")
    print(f"  {'Metric':<30} {'PBX (raw legs)':>14}  {'PBX (unique)':>14}  {'Connect':>10}")
    print(f"  {'─'*70}")
    print(f"  {'TOTAL':<30} {str(pbx_raw):>14}  {str(pbx_unique):>14}  {str(conn_rows2):>10}")
    for d in ["incoming","outgoing","internal","unknown"]:
        pbxv = pbx_dir.get(d,0)
        conv = conn_dir.get(d,0)
        diff = conv - pbxv
        diff_str = f"({'+' if diff>=0 else ''}{diff})" if diff != 0 else "✓"
        print(f"  {d:<30} {str(pbxv):>14}  {str(pbxv):>14}  {str(conv):>10}  {diff_str}")

    print(f"\n  Tenants queried: {', '.join(tw.get('tenantsTargeted',[]))}")
    for err in tw.get("tenantFetchErrors",[]):
        print(f"  ⚠ TENANT FETCH ERROR: {err}")

    # ── Step 4: Missing calls ─────────────────────────────────────────────────
    missing     = mm.get("missingFromConnect", [])
    mismatch    = mm.get("misclassified", [])
    null_tenant = mm.get("tenantNull", [])
    only_conn   = mm.get("onlyInConnectLinkedIdsSample", [])

    print(f"\n{'─'*72}")
    print(f"  MISSING FROM CONNECT ({counts.get('missingPbxCanonicalNotInConnect',0)} total, showing up to 20)")
    print(f"{'─'*72}")
    if missing:
        print(f"  {'linkedId':<30} {'PBX-dir':<10} {'from':<16} {'to':<16} {'time':<22}")
        print(f"  {'─'*92}")
        for r in missing[:20]:
            lid = str(r.get("linkedId") or r.get("pbxLinkedId","?"))[:29]
            d   = str(r.get("pbxDirection","?"))[:9]
            frm = str(r.get("from") or r.get("src","?"))[:15]
            to_ = str(r.get("to") or r.get("dst","?"))[:15]
            ts  = str(r.get("calldate") or r.get("startedAt","?"))[:21]
            print(f"  {lid:<30} {d:<10} {frm:<16} {to_:<16} {ts:<22}")
    else:
        print("  (none — all PBX calls found in Connect for this window)")

    print(f"\n{'─'*72}")
    print(f"  DIRECTION MISMATCHES — PBX direction vs Connect stored direction")
    print(f"  ({counts.get('misclassifiedDirection',0)} total)")
    print(f"{'─'*72}")
    if mismatch:
        print(f"  {'linkedId':<30} {'PBX':<10} {'Connect':<12} {'from':<16} {'to':<16}")
        print(f"  {'─'*86}")
        for r in mismatch[:20]:
            lid  = str(r.get("linkedId","?"))[:29]
            pd   = str(r.get("pbxDirection","?"))[:9]
            cd   = str(r.get("connectDirection","?"))[:11]
            frm  = str(r.get("from") or r.get("src","?"))[:15]
            to_  = str(r.get("to") or r.get("dst","?"))[:15]
            print(f"  {lid:<30} {pd:<10} {cd:<12} {frm:<16} {to_:<16}")
    else:
        print("  (none in sample)")

    # ── Step 5: Per-call table for all today's Connect rows ───────────────────
    print(f"\n{'─'*72}")
    print(f"  ALL TODAY's CONNECT CDR ROWS ({len(connect_rows)} rows)")
    print(f"{'─'*72}")
    _print_connect_rows(connect_rows)

    # ── Step 6: Why PBX outgoing=2 but Connect outgoing=0? ───────────────────
    print(f"\n{'─'*72}")
    print(f"  ROOT CAUSE ANALYSIS")
    print(f"{'─'*72}")
    pbx_out = pbx_dir.get("outgoing", 0)
    con_out = conn_dir.get("outgoing", 0)
    pbx_in  = pbx_dir.get("incoming", 0)
    con_in  = conn_dir.get("incoming", 0)

    if pbx_out > 0 and con_out == 0:
        print(f"\n  ❌ PBX outgoing={pbx_out} but Connect outgoing={con_out}")
        # Find those calls in Connect
        out_in_connect_as_incoming = [r for r in connect_rows if r.get("direction") == "incoming"]
        # Check if any connect rows might be the misclassified outgoing calls
        short_ext_as_incoming = [r for r in connect_rows
                                  if r.get("direction") == "incoming"
                                  and len((r.get("fromNumber") or "").replace("+","").replace(" ","")) <= 6]
        if short_ext_as_incoming:
            print(f"  → Found {len(short_ext_as_incoming)} Connect 'incoming' rows with short extension as fromNumber")
            print(f"    These are likely the outgoing calls stored as incoming:")
            for r in short_ext_as_incoming[:5]:
                print(f"    from={r.get('fromNumber','?'):<10} to={r.get('toNumber','?'):<15} "
                      f"dir={r.get('direction','?'):<10} tenant={r.get('tenantId','NULL'):<20} "
                      f"started={r.get('startedAt','?')[:19]}")
        else:
            print(f"  → No incoming rows with short-ext from. Check if outgoing calls were skipped at ingest.")
            print(f"    Missing calls count: {counts.get('missingPbxCanonicalNotInConnect',0)}")

    if pbx_in > con_in:
        diff = pbx_in - con_in
        print(f"\n  ❌ PBX incoming={pbx_in} but Connect incoming={con_in} (diff={diff})")
        print(f"  → {counts.get('missingPbxCanonicalNotInConnect',0)} PBX calls not in Connect at all")
        print(f"  → {counts.get('connectTenantNull',0)} Connect rows have null tenant (excluded from KPI)")
        null_rows = [r for r in connect_rows if not r.get("tenantId") or r.get("tenantId") == ""]
        if null_rows:
            print(f"  → NULL tenant rows in ConnectCdr today:")
            for r in null_rows[:5]:
                print(f"    from={r.get('fromNumber','?'):<10} to={r.get('toNumber','?'):<15} "
                      f"dir={r.get('direction','?'):<10} started={r.get('startedAt','?')[:19]}")

    # Loss points
    print(f"\n  Top loss points:")
    for lp in loss[:5]:
        c = lp.get("count",0)
        if c > 0:
            print(f"    [{c:>3}] {lp.get('cause','')}  — {lp.get('note','')[:70]}")

    print(f"\n{'='*72}\n")


def _print_connect_rows(rows):
    if not rows:
        print("  (no rows)")
        return
    print(f"  {'linkedId':<28} {'dir':<10} {'from':<14} {'to':<16} {'tenant':<22} {'dur':>4} {'started'}")
    print(f"  {'─'*106}")
    for r in rows:
        lid = str(r.get("linkedId","?"))[:27]
        d   = str(r.get("direction","?"))[:9]
        frm = str(r.get("fromNumber","?"))[:13]
        to_ = str(r.get("toNumber","?"))[:15]
        ten = str(r.get("tenantId") or "NULL")[:21]
        dur = str(r.get("durationSec","?"))[:4]
        ts  = str(r.get("startedAt","?"))[:19]
        print(f"  {lid:<28} {d:<10} {frm:<14} {to_:<16} {ten:<22} {dur:>4} {ts}")


if __name__ == "__main__":
    main()
