#!/usr/bin/env python3
"""
Step 6: Post-deploy verification.
1. Confirms /cdr-stats endpoint is live and shows counters.
2. Runs reconciliation with gesheft using chunked fetch (startIso/endIso narrow window).
3. Reports ratio of PBX raw rows to unique linkedIds.
Run on server: python3 /opt/connectcomms/app/scripts/verify-deploy.py
"""
import json, re, time, urllib.request, urllib.error
from datetime import datetime, timezone

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE_API = "http://127.0.0.1:3001"
BASE_TEL = "http://127.0.0.1:3003"

def get_secret():
    return re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", open(ENV_PATH).read(), re.M).group(1).strip()

def post_json(path, body, base=BASE_API):
    req = urllib.request.Request(f"{base}{path}", json.dumps(body).encode(),
                                  {"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def get_bearer(path, token, qs="", base=BASE_API):
    req = urllib.request.Request(f"{base}{path}{qs}",
                                  headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=300)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except: return e.code, {"raw": str(e)}

def get_plain(path, base=BASE_TEL):
    req = urllib.request.Request(f"{base}{path}", headers={"Accept": "application/json"})
    r = urllib.request.urlopen(req, timeout=10)
    return r.status, json.loads(r.read())

now = datetime.now(timezone.utc)
print(f"Post-Deploy Verification  {now.isoformat()}")

# ── 1. CDR stats endpoint ─────────────────────────────────────────────────────
print("\n=== 1. /cdr-stats (telephony health) ===")
try:
    st, stats = get_plain("/cdr-stats")
    print(f"  Status: HTTP {st}")
    print(f"  notified:    {stats.get('notified', '?')}")
    print(f"  postedOk:    {stats.get('postedOk', '?')}")
    print(f"  httpErrors:  {stats.get('httpErrors', '?')}")
    print(f"  httpTimeouts:{stats.get('httpTimeouts', '?')}")
    print(f"  skipped:     {stats.get('skipped', {})}")
    print(f"  since:       {stats.get('since', '?')}")
except Exception as e:
    print(f"  ERROR: {e}")

# ── 2. Mint token ─────────────────────────────────────────────────────────────
token = post_json("/admin/dev/generate-observe-token", {"secret": get_secret()})["token"]
print("\nToken minted")

# ── 3. Narrow-window gesheft reconciliation (3-hour window) ──────────────────
print("\n=== 2. gesheft reconciliation (3h narrow window, chunked) ===")
# 15:00–18:00 ET = 19:00–22:00 UTC on 2026-03-29
start_iso = "2026-03-29T19:00:00.000Z"
end_iso   = "2026-03-29T22:00:00.000Z"
print(f"  Window: {start_iso} → {end_iso}")
print("  Fetching (may take 1–3 minutes for chunked gesheft)...", flush=True)
t0 = time.time()
st, data = get_bearer(
    "/admin/diagnostics/cdr-pipeline-reconciliation", token,
    f"?pbxSlug=gesheft&startIso={start_iso}&endIso={end_iso}"
)
elapsed = round(time.time() - t0, 1)
print(f"  HTTP {st}  elapsed={elapsed}s")

if st == 200:
    totals = data.get("section1_totals", {})
    window_info = data.get("section1_timeWindow", {})
    errors = window_info.get("tenantFetchErrors", {})
    pagination = window_info.get("paginationNotesByTenant", {})
    print(f"  PBX raw rows:     {totals.get('pbxRawRowsFromApi', '?')}")
    print(f"  PBX unique:       {totals.get('pbxCanonicalCalls', '?')}")
    print(f"  Connect rows:     {totals.get('connectCdrRows', '?')}")
    if totals.get('pbxCanonicalCalls', 0):
        ratio = totals['pbxRawRowsFromApi'] / totals['pbxCanonicalCalls']
        print(f"  Ratio raw/unique: {ratio:.2f}×")
    print(f"  Errors:           {errors}")
    print(f"  Pagination notes: {pagination}")
    counts = data.get("counts", {})
    print(f"  missingFromConnect: {counts.get('missingPbxCanonicalNotInConnect', '?')}")
    print(f"  onlyInConnect:      {counts.get('connectOnlyRows', '?')}")
else:
    print(f"  ERROR: {json.dumps(data)[:300]}")

# ── 4. Full-day reconciliation (all tenants) ──────────────────────────────────
print("\n=== 3. Full-day reconciliation (all tenants, chunked fallback for gesheft) ===")
print("  Fetching (may take 3–8 minutes due to gesheft chunked fetch)...", flush=True)
t0 = time.time()
st2, data2 = get_bearer("/admin/diagnostics/cdr-pipeline-reconciliation", token)
elapsed2 = round(time.time() - t0, 1)
print(f"  HTTP {st2}  elapsed={elapsed2}s")
if st2 == 200:
    totals2 = data2.get("section1_totals", {})
    window2 = data2.get("section1_timeWindow", {})
    errors2 = window2.get("tenantFetchErrors", {})
    print(f"  PBX raw rows:      {totals2.get('pbxRawRowsFromApi', '?')}")
    print(f"  PBX unique calls:  {totals2.get('pbxCanonicalCalls', '?')}")
    print(f"  Connect rows:      {totals2.get('connectCdrRows', '?')}")
    if totals2.get('pbxCanonicalCalls', 0):
        r = totals2['pbxRawRowsFromApi'] / totals2['pbxCanonicalCalls']
        connect = totals2.get('connectCdrRows', 0)
        pbx_unique = totals2['pbxCanonicalCalls']
        print(f"  Ratio raw/unique:  {r:.2f}×")
        print(f"  Connect vs PBX unique: {connect} / {pbx_unique} = {(connect/pbx_unique*100):.1f}%")
    print(f"  Tenant errors:     {errors2}")
    counts2 = data2.get("counts", {})
    print(f"  missingFromConnect: {counts2.get('missingPbxCanonicalNotInConnect', '?')}")
else:
    print(f"  ERROR: {json.dumps(data2)[:300]}")

print("\nDone.")
