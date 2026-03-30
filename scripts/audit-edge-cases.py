#!/usr/bin/env python3
"""
Edge-case audit: query ConnectCdr directly via Prisma introspection route.
Run on server: python3 /opt/connectcomms/app/scripts/audit-edge-cases.py
"""
import json, re, subprocess, sys

# Invoke node/tsx to run a DB query inside the app context
QUERY_SCRIPT = r"""
const { db } = await import('/opt/connectcomms/app/packages/db/src/index.js');
const { PrismaClient } = await import('/opt/connectcomms/app/node_modules/.prisma/client/index.js');
""".strip()

# Instead use psql directly since we have DB access
ENV_PATH = "/opt/connectcomms/env/.env.platform"

def get_db_url():
    text = open(ENV_PATH).read()
    m = re.search(r"^DATABASE_URL=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DATABASE_URL not found")
    return m.group(1).strip().replace("connectcomms-postgres", "127.0.0.1")

def psql(query: str) -> list:
    db_url = get_db_url()
    result = subprocess.run(
        ["/usr/bin/psql", db_url, "-c", query, "--csv", "--quiet", "--no-psqlrc"],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"  psql error: {result.stderr[:200]}")
        return []
    lines = result.stdout.strip().splitlines()
    if not lines:
        return []
    headers = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        vals = line.split(",")
        rows.append(dict(zip(headers, vals)))
    return rows

def section(title):
    print(f"\n{'='*65}")
    print(f"  {title}")
    print(f"{'='*65}")

db_url = get_db_url()
print(f"Edge-case audit — using DB")

# 1. Distribution of direction x from-length x to-length for today
section("1. Direction distribution (today)")
rows = psql("""
SELECT direction,
       LENGTH(REGEXP_REPLACE(COALESCE("fromNumber",''), '[^0-9]', '', 'g')) AS from_digits,
       LENGTH(REGEXP_REPLACE(COALESCE("toNumber",''), '[^0-9]', '', 'g')) AS to_digits,
       COUNT(*) AS cnt
FROM "ConnectCdr"
WHERE "startedAt" >= NOW() - INTERVAL '24 hours'
GROUP BY 1,2,3
ORDER BY 1, cnt DESC
LIMIT 40;
""")
print(f"  {'direction':<12} {'from_len':>8} {'to_len':>7} {'count':>6}")
print(f"  {'-'*38}")
for r in rows:
    print(f"  {r.get('direction',''):<12} {r.get('from_digits',''):>8} {r.get('to_digits',''):>7} {r.get('cnt',''):>6}")

# 2. Unknown-direction rows: what are they?
section("2. Unknown-direction rows (today, up to 15)")
rows2 = psql("""
SELECT "linkedId", "fromNumber", "toNumber", "tenantId", "disposition", "durationSec"
FROM "ConnectCdr"
WHERE direction = 'unknown'
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
LIMIT 15;
""")
print(f"  {'linkedId':<28} {'from':<14} {'to':<14} {'tenant':<20} {'dispo':<10} {'dur'}")
print(f"  {'-'*95}")
for r in rows2:
    print(f"  {r.get('linkedId',''):<28} {r.get('fromNumber',''):<14} {r.get('toNumber',''):<14} {r.get('tenantId',''):<20} {r.get('disposition',''):<10} {r.get('durationSec','')}")

# 3. Null-tenant rows: from/to patterns
section("3. Null-tenant rows — from/to distribution (today)")
rows3 = psql("""
SELECT direction,
       COALESCE("fromNumber",'(null)') AS from_num,
       COALESCE("toNumber",'(null)') AS to_num,
       COUNT(*) AS cnt
FROM "ConnectCdr"
WHERE "tenantId" IS NULL
  AND "startedAt" >= NOW() - INTERVAL '24 hours'
GROUP BY 1,2,3
ORDER BY cnt DESC
LIMIT 20;
""")
print(f"  {'direction':<12} {'from':<16} {'to':<16} {'count'}")
for r in rows3:
    print(f"  {r.get('direction',''):<12} {r.get('from_num',''):<16} {r.get('to_num',''):<16} {r.get('cnt','')}")

# 4. Calls with 7-9 digit to (ambiguous local PSTN)
section("4. Ambiguous local-PSTN calls (7-9 digit 'to', today)")
rows4 = psql("""
SELECT "linkedId", "fromNumber", "toNumber", direction, "tenantId"
FROM "ConnectCdr"
WHERE "startedAt" >= NOW() - INTERVAL '24 hours'
  AND LENGTH(REGEXP_REPLACE(COALESCE("toNumber",''),'[^0-9]','','g')) BETWEEN 7 AND 9
LIMIT 15;
""")
if rows4:
    print(f"  {'linkedId':<28} {'from':<14} {'to':<12} {'direction':<12} tenant")
    for r in rows4:
        print(f"  {r.get('linkedId',''):<28} {r.get('fromNumber',''):<14} {r.get('toNumber',''):<12} {r.get('direction',''):<12} {r.get('tenantId','')}")
else:
    print("  None found — good (no ambiguous local-PSTN calls in today's data)")

# 5. Summary counts
section("5. Summary")
rows5 = psql("""
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE direction='incoming') AS incoming,
  COUNT(*) FILTER (WHERE direction='outgoing') AS outgoing,
  COUNT(*) FILTER (WHERE direction='internal') AS internal,
  COUNT(*) FILTER (WHERE direction='unknown') AS unknown,
  COUNT(*) FILTER (WHERE "tenantId" IS NULL) AS null_tenant,
  COUNT(DISTINCT "tenantId") AS distinct_tenants
FROM "ConnectCdr"
WHERE "startedAt" >= NOW() - INTERVAL '24 hours';
""")
if rows5:
    r = rows5[0]
    print(f"  Total rows:          {r.get('total')}")
    print(f"  Incoming:            {r.get('incoming')}")
    print(f"  Outgoing:            {r.get('outgoing')}")
    print(f"  Internal:            {r.get('internal')}")
    print(f"  Unknown:             {r.get('unknown')}")
    print(f"  Null-tenant:         {r.get('null_tenant')}")
    print(f"  Distinct tenants:    {r.get('distinct_tenants')}")

print()
