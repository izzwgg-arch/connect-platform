#!/usr/bin/env python3
"""Pull CDR samples from production for edge-case analysis.
Run on app server: python3 /opt/connectcomms/app/scripts/sample-cdr-edge-cases.py
"""
import json, re, urllib.request

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"

secret = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", open(ENV_PATH).read(), re.M).group(1).strip()
tok = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/admin/dev/generate-observe-token",
    json.dumps({"secret": secret}).encode(),
    {"Content-Type": "application/json"}, method="POST"), timeout=30).read())["token"]

# Get connect-cdr-today-breakdown (samples by direction)
r = urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/admin/diagnostics/connect-cdr-today-breakdown",
    headers={"Authorization": f"Bearer {tok}"}, method="GET"), timeout=60)
breakdown = json.loads(r.read())

# Show direction distribution + samples
print(f"=== CDR BREAKDOWN (today) ===")
print(f"totals: {breakdown.get('totals')}")
print(f"\nsamples by direction:")
for dir_key in ["incoming", "outgoing", "internal", "unknown"]:
    samples = breakdown.get("samplesByDirection", {}).get(dir_key, [])
    print(f"\n  {dir_key.upper()} ({len(samples)} samples shown):")
    for s in samples[:5]:
        print(f"    linkedId={s.get('linkedId','')} from={s.get('fromNumber','')} to={s.get('toNumber','')} dispo={s.get('disposition','')} tenant={s.get('tenantId','')}")

# Get dashboard-reconciliation (null-tenant info)
r2 = urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/admin/diagnostics/dashboard-reconciliation",
    headers={"Authorization": f"Bearer {tok}"}, method="GET"), timeout=60)
recon = json.loads(r2.read())
print(f"\n=== DASHBOARD RECONCILIATION ===")
print(f"window: {recon.get('window')}")
print(f"raw:    {recon.get('raw')}")
print(f"canonical: {recon.get('canonical')}")
print(f"delta:  {recon.get('delta')}")
print(f"mismatches: {recon.get('directionMismatches',{}).get('count')} (should be 0 after backfill)")
print(f"null-tenant rows: {recon.get('nullTenantRows')}")
