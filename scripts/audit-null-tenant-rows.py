#!/usr/bin/env python3
"""
Step 5: Audit null-tenant ConnectCdr rows against PBX tenant DID assignments.
Matches DID numbers in null-tenant rows against VitalPBX tenant list and CDR data.
Run on server: python3 /opt/connectcomms/app/scripts/audit-null-tenant-rows.py
"""
import json, re, urllib.request, urllib.error
from datetime import datetime, timezone

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
                                  headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=180)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except: return e.code, {"raw": str(e)}

def psql(query):
    """Run a psql query via docker exec and return rows as list-of-dicts."""
    import subprocess
    # Read DB url from .env.platform
    with open(ENV_PATH) as f:
        content = f.read()
    m = re.search(r'^DATABASE_URL=(.+)$', content, re.M)
    if not m:
        raise RuntimeError("DATABASE_URL not found in .env.platform")
    db_url = m.group(1).strip().strip('"').strip("'")
    result = subprocess.run(
        ["docker", "exec", "connectcomms-postgres", "psql", db_url, "-t", "-A", "--csv", "-c", query],
        capture_output=True, text=True, timeout=30
    )
    lines = [l for l in result.stdout.strip().split("\n") if l]
    if not lines:
        return []
    headers = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        parts = line.split(",")
        rows.append(dict(zip(headers, parts)))
    return rows

token = post_json("/admin/dev/generate-observe-token", {"secret": get_secret()})["token"]
print(f"Null-Tenant Row Audit  {datetime.now(timezone.utc).isoformat()}")

# ── 1. Count and categorize null-tenant rows ──────────────────────────────────
print("\n=== 1. Null-tenant rows summary (today) ===")
summary_rows = psql("""
SELECT
  direction,
  COUNT(*) as cnt,
  COUNT(CASE WHEN "dcontext" IS NOT NULL THEN 1 END) as has_dcontext,
  COUNT(CASE WHEN "fromNumber" ~ '^[0-9]{10,}$' THEN 1 END) as long_from,
  COUNT(CASE WHEN "toNumber" ~ '^[0-9]{10,}$' THEN 1 END) as long_to
FROM "ConnectCdr"
WHERE "tenantId" IS NULL
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
GROUP BY direction
ORDER BY cnt DESC
""")
for r in summary_rows:
    print(f"  direction={r.get('direction','?')}  count={r.get('cnt','?')}  has_dcontext={r.get('has_dcontext','?')}  long_from={r.get('long_from','?')}  long_to={r.get('long_to','?')}")

# ── 2. Distinct dcontext values in null-tenant rows ───────────────────────────
print("\n=== 2. Distinct dcontext patterns in null-tenant rows ===")
dcontext_rows = psql("""
SELECT
  COALESCE(dcontext, '(null)') as dcontext,
  COUNT(*) as cnt,
  MIN("fromNumber") as sample_from,
  MIN("toNumber") as sample_to
FROM "ConnectCdr"
WHERE "tenantId" IS NULL
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
GROUP BY dcontext
ORDER BY cnt DESC
LIMIT 30
""")
for r in dcontext_rows:
    print(f"  [{r.get('cnt','?'):>4}]  dcontext={r.get('dcontext','?')}  from={r.get('sample_from','?')}  to={r.get('sample_to','?')}")

# ── 3. Most common "to" numbers in null-tenant rows (likely DIDs) ─────────────
print("\n=== 3. Most-called TO numbers in null-tenant rows (likely tenant DIDs) ===")
to_rows = psql("""
SELECT
  "toNumber",
  COUNT(*) as cnt,
  COUNT(DISTINCT "linkedId") as unique_calls,
  MIN(direction) as direction
FROM "ConnectCdr"
WHERE "tenantId" IS NULL
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
  AND "toNumber" ~ '^[0-9]{7,}$'
GROUP BY "toNumber"
ORDER BY cnt DESC
LIMIT 20
""")
for r in to_rows:
    print(f"  [{r.get('cnt','?'):>4}]  to={r.get('toNumber','?')}  unique={r.get('unique_calls','?')}  direction={r.get('direction','?')}")

# ── 4. Most common "from" numbers in null-tenant rows (likely DID callers) ────
print("\n=== 4. Most common FROM numbers in null-tenant rows ===")
from_rows = psql("""
SELECT
  "fromNumber",
  COUNT(*) as cnt,
  MIN("toNumber") as sample_to
FROM "ConnectCdr"
WHERE "tenantId" IS NULL
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
  AND "fromNumber" ~ '^[0-9]{7,}$'
GROUP BY "fromNumber"
ORDER BY cnt DESC
LIMIT 10
""")
for r in from_rows:
    print(f"  [{r.get('cnt','?'):>4}]  from={r.get('fromNumber','?')}  sample_to={r.get('sample_to','?')}")

# ── 5. Fetch PBX tenant list to compare DID patterns ─────────────────────────
print("\n=== 5. PBX tenant list (first 10 from API) ===")
st, data = get_bearer("/admin/diagnostics/dashboard-reconciliation", token)
if st == 200:
    print(f"  Window: {data.get('window','?')}")
    print(f"  Raw connect count: {data.get('rawConnectCounts',{})}")
    print(f"  Null tenant rows: {data.get('nullTenantRows','?')}")
else:
    print(f"  Could not fetch reconciliation: HTTP {st}")

# ── 6. Sample null-tenant rows with full context ──────────────────────────────
print("\n=== 6. Sample null-tenant rows (10 random) ===")
sample_rows = psql("""
SELECT
  "linkedId",
  "fromNumber",
  "toNumber",
  direction,
  dcontext,
  "accountCode",
  "durationSec",
  "startedAt"
FROM "ConnectCdr"
WHERE "tenantId" IS NULL
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
ORDER BY RANDOM()
LIMIT 10
""")
for r in sample_rows:
    print(f"  linkedId={r.get('linkedId','?')}")
    print(f"    from={r.get('fromNumber','?')}  to={r.get('toNumber','?')}  dir={r.get('direction','?')}")
    print(f"    dcontext={r.get('dcontext','?')}  account={r.get('accountCode','?')}  dur={r.get('durationSec','?')}")
    print(f"    at={r.get('startedAt','?')}")

print("\nDone.")
