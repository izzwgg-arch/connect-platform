#!/usr/bin/env python3
"""
Audit: compare PBX unique linkedId count vs Connect unique linkedId count.
Run on server: python3 /opt/connectcomms/app/scripts/audit-pbx-linkedids.py
Read-only. No data is modified.
"""
import json, re, urllib.request, urllib.error

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"

def get_secret():
    text = open(ENV_PATH).read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    return m.group(1).strip()

def post_json(path, body, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE}{path}", json.dumps(body).encode(), headers, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=120)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

def get_bearer(path, token, qs=""):
    url = f"{BASE}{path}{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, method="GET")
    try:
        r = urllib.request.urlopen(req, timeout=300)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except:
            return e.code, {"raw": body}

token = post_json("/admin/dev/generate-observe-token", {"secret": get_secret()})[1]["token"]
print(f"Token minted.")

# Run the full pipeline reconciliation (calls PBX CDR API for all tenants)
print(f"\nRunning CDR pipeline reconciliation (may take 30-60s)...")
st, recon = get_bearer("/admin/diagnostics/cdr-pipeline-reconciliation", token)
print(f"HTTP {st}")

if st == 200:
    w = recon.get("window", {})
    print(f"\nWindow: {w.get('start')} → {w.get('end')}")
    print(f"Timezone: {w.get('timezone')}")

    pbx = recon.get("pbx", {})
    conn = recon.get("connect", {})

    print(f"\n{'='*60}")
    print(f"{'':30} {'PBX':>12}  {'Connect':>12}")
    print(f"{'─'*60}")
    print(f"{'Raw CDR rows fetched':30} {pbx.get('rawRowCount',0):>12}  {'(N/A)':>12}")
    print(f"{'Unique linkedIds':30} {pbx.get('uniqueLinkedIds',0):>12}  {conn.get('uniqueLinkedIds',0):>12}")
    print(f"{'Incoming':30} {pbx.get('incoming',0):>12}  {conn.get('incoming',0):>12}")
    print(f"{'Outgoing':30} {pbx.get('outgoing',0):>12}  {conn.get('outgoing',0):>12}")
    print(f"{'Internal':30} {pbx.get('internal',0):>12}  {conn.get('internal',0):>12}")
    print(f"{'='*60}")

    delta = recon.get("delta", {})
    print(f"\nDelta (PBX unique - Connect unique): {delta.get('uniqueLinkedIds', 'n/a')}")
    print(f"Missing from Connect:  {len(recon.get('onlyInPbx', []))} linked IDs")
    print(f"Only in Connect:       {len(recon.get('onlyInConnect', []))} linked IDs")
    print(f"Matched:               {len(recon.get('matched', []))} linked IDs")

    errors = recon.get("tenantFetchErrors", {})
    if errors:
        print(f"\nTenant fetch errors: {errors}")

    pagination = recon.get("paginationNotesByTenant", {})
    if any(pagination.values()):
        print(f"\nPagination notes: {pagination}")

    sample_missing = recon.get("onlyInPbx", [])[:10]
    if sample_missing:
        print(f"\nSample: calls in PBX but NOT in Connect (first 10):")
        for s in sample_missing:
            print(f"  {s.get('linkedId','')} | src={s.get('src','')} dst={s.get('dst','')} tenant={s.get('_pbxTenantName','')} calltype={s.get('calltype',s.get('callType',''))}")

    sample_extra = recon.get("onlyInConnect", [])[:5]
    if sample_extra:
        print(f"\nSample: calls in Connect but NOT in PBX (first 5):")
        for s in sample_extra:
            print(f"  {s.get('linkedId','')} | from={s.get('fromNumber','')} to={s.get('toNumber','')} dir={s.get('direction','')}")
else:
    print(f"ERROR: {json.dumps(recon, indent=2)[:500]}")

print("\nDone.")
