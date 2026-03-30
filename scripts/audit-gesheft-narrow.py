#!/usr/bin/env python3
"""
Fetch gesheft CDR for a narrow 2-hour window to see raw row count vs unique linkedId count.
Also check telephony service health / restart history.
Read-only. No data modified.
"""
import json, re, urllib.request, urllib.error, time

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"

def get_secret():
    return re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", open(ENV_PATH).read(), re.M).group(1).strip()

def post_json(path, body):
    req = urllib.request.Request(f"{BASE}{path}", json.dumps(body).encode(),
                                  {"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def get_bearer(path, token, qs=""):
    req = urllib.request.Request(f"{BASE}{path}{qs}",
                                  headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, method="GET")
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

token = post_json("/admin/dev/generate-observe-token", {"secret": get_secret()})["token"]
print("Token minted")

# 1. Telephony health - check reconnection state
print("\n=== TELEPHONY HEALTH ===")
st, health = get_bearer("/internal/telephony-health", token)
print(f"HTTP {st}")
print(json.dumps(health, indent=2, default=str)[:2000])

# 2. Telephony diagnostics
print("\n=== TELEPHONY DIAGNOSTICS ===")
st2, diag = get_bearer("/internal/telephony-diagnostics", token)
print(f"HTTP {st2}")
print(json.dumps(diag, indent=2, default=str)[:2000])

# 3. Check container restart history
import subprocess
print("\n=== CONTAINER RESTART HISTORY ===")
result = subprocess.run(
    ["docker", "inspect", "--format",
     "{{.RestartCount}} restarts | State={{.State.Status}} | StartedAt={{.State.StartedAt}} | FinishedAt={{.State.FinishedAt}}",
     "app-telephony-1"],
    capture_output=True, text=True, timeout=10
)
print(result.stdout.strip() or result.stderr.strip())

result2 = subprocess.run(
    ["docker", "inspect", "--format",
     "{{.RestartCount}} restarts | State={{.State.Status}} | StartedAt={{.State.StartedAt}} | FinishedAt={{.State.FinishedAt}}",
     "app-api-1"],
    capture_output=True, text=True, timeout=10
)
print(f"app-api-1: {result2.stdout.strip()}")

# 4. Narrow window PBX CDR fetch for gesheft: 2 hours (today 12:00-14:00 NY = 16:00-18:00 UTC)
# Using today's known active window: let's use 13:00-15:00 NY time (17:00-19:00 UTC)
print("\n=== NARROW WINDOW: PBX CDR for gesheft (2h window 12:00-14:00 ET) ===")
# 12:00 ET today = 16:00 UTC
# ET = UTC-4 (currently EDT)
start_sec = 1774800000  # approximately 12:00 ET
end_sec   = 1774807200  # 14:00 ET (+2h)

st3, narrow = get_bearer(
    "/admin/diagnostics/cdr-pipeline-reconciliation", token,
    f"?startSec={start_sec}&endSec={end_sec}&pbxSlug=gesheft"
)
print(f"HTTP {st3}")
if st3 == 200:
    totals = narrow.get("section1_totals", {})
    window = narrow.get("section1_timeWindow", {})
    print(f"Window: {window.get('dayStartUtc')} → {window.get('dayEndExclusiveUtc')}")
    print(f"PBX raw rows: {totals.get('pbxRawRowsFromApi')}")
    print(f"PBX canonical unique calls: {totals.get('pbxCanonicalCalls')}")
    print(f"PBX directions: {totals.get('pbxByDirection')}")
    print(f"Connect rows: {totals.get('connectCdrRows')}")
    print(f"Connect directions: {totals.get('connectByDirection')}")
    errors = window.get("tenantFetchErrors", {})
    print(f"Tenant fetch errors: {errors}")
    sample_pbx = narrow.get("section4_sampleMismatches", {}).get("missingFromConnect", [])[:5]
    if sample_pbx:
        print(f"\nSample PBX-only rows: {sample_pbx}")
else:
    print(json.dumps(narrow, indent=2, default=str)[:1000])

print("\nDone.")
