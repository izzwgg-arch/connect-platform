#!/usr/bin/env python3
"""
Step 1: Confirm PBX dashboard counting model.
Fetch a small non-timeout tenant for a narrow 1-hour window and compare:
  raw CDR rows from PBX API  vs  unique linkedid count
If raw_rows ≈ 2× unique, the 2× PBX/Connect ratio is fully explained.

Also fetches gesheft in a narrow 1-hour window (lower chance of timeout).
Run on server: python3 /opt/connectcomms/app/scripts/audit-pbx-counting-model.py
"""
import json, re, time, urllib.request, urllib.error
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
                                  headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                                  method="GET")
    try:
        r = urllib.request.urlopen(req, timeout=180)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except:
            return e.code, {"raw": str(e)}

token = post_json("/admin/dev/generate-observe-token", {"secret": get_secret()})["token"]
print(f"CDR Counting Model Audit  {datetime.now(timezone.utc).isoformat()}")
print(f"Token minted")

# ── Helper: fetch narrow CDR window for one tenant slug ──────────────────────
def fetch_window(slug: str, start_sec: int, end_sec: int, label: str) -> dict:
    print(f"\n  [{label}] Fetching {slug}  {start_sec}→{end_sec} ...", flush=True)
    qs = f"?pbxSlug={slug}&startSec={start_sec}&endSec={end_sec}"
    st, data = get_bearer("/admin/diagnostics/cdr-pipeline-reconciliation", token, qs)
    if st != 200:
        print(f"  ERROR HTTP {st}: {str(data)[:200]}")
        return {}
    totals = data.get("section1_totals", {})
    errors = data.get("section1_timeWindow", {}).get("tenantFetchErrors", {})
    notes  = data.get("section1_timeWindow", {}).get("paginationNotesByTenant", {})
    return {
        "pbx_raw_rows":    totals.get("pbxRawRowsFromApi", 0),
        "pbx_unique":      totals.get("pbxCanonicalCalls", 0),
        "pbx_directions":  totals.get("pbxByDirection", {}),
        "connect_rows":    totals.get("connectCdrRows", 0),
        "connect_dir":     totals.get("connectByDirection", {}),
        "errors":          errors,
        "pagination":      notes,
        "ratio":           round(totals.get("pbxRawRowsFromApi", 1) / max(totals.get("pbxCanonicalCalls", 1), 1), 2),
    }

# ── Today's windows (America/New_York = UTC-4 currently) ─────────────────────
# We use well-known windows from today's data
# "today" in ET: 2026-03-29 04:00 UTC → 2026-03-30 04:00 UTC
DAY_START = 1774756800   # 2026-03-29 04:00 UTC
DAY_END   = 1774843200   # 2026-03-30 04:00 UTC

# 4-hour mid-day window: 14:00–18:00 ET = 18:00–22:00 UTC
H14_START = 1774800000   # 2026-03-29 14:00 ET
H14_END   = 1774814400   # 2026-03-29 18:00 ET

section_header = lambda t: print(f"\n{'='*65}\n  {t}\n{'='*65}")

# ── 1. Small tenant (a_plus_center) — full day ────────────────────────────────
section_header("1. a_plus_center — full day (low row count, no timeout risk)")
r1 = fetch_window("a_plus_center", DAY_START, DAY_END, "a_plus_center full day")
if r1:
    print(f"  PBX raw CDR rows:       {r1['pbx_raw_rows']}")
    print(f"  PBX unique linkedIds:   {r1['pbx_unique']}")
    print(f"  Ratio raw/unique:       {r1['ratio']:.2f}×")
    print(f"  PBX directions:         {r1['pbx_directions']}")
    print(f"  Connect rows:           {r1['connect_rows']}")
    print(f"  Connect directions:     {r1['connect_dir']}")
    print(f"  Errors:                 {r1['errors']}")

# ── 2. Several small tenants — full day ──────────────────────────────────────
section_header("2. Small tenants — full day raw vs unique ratio")
small_tenants = ["relax_tires", "comfort_control", "trimpro", "mcnamara_lion", "smooth_leasing"]
total_raw = 0; total_unique = 0
for slug in small_tenants:
    r = fetch_window(slug, DAY_START, DAY_END, slug)
    if r and r.get("pbx_raw_rows", 0) > 0:
        print(f"  {slug:<25}  raw={r['pbx_raw_rows']:>4}  unique={r['pbx_unique']:>4}  ratio={r['ratio']:.2f}×  connect={r['connect_rows']}")
        total_raw += r["pbx_raw_rows"]
        total_unique += r["pbx_unique"]

if total_unique > 0:
    print(f"\n  AGGREGATE raw={total_raw}  unique={total_unique}  ratio={total_raw/total_unique:.2f}×")

# ── 3. Gesheft — narrow 4-hour window ────────────────────────────────────────
section_header("3. gesheft — narrow 4-hour window (14:00-18:00 ET)")
r3 = fetch_window("gesheft", H14_START, H14_END, "gesheft 4h")
if r3:
    print(f"  PBX raw CDR rows:       {r3['pbx_raw_rows']}")
    print(f"  PBX unique linkedIds:   {r3['pbx_unique']}")
    print(f"  Ratio raw/unique:       {r3['ratio']:.2f}×")
    print(f"  PBX directions:         {r3['pbx_directions']}")
    print(f"  Connect rows:           {r3['connect_rows']}")
    print(f"  Connect directions:     {r3['connect_dir']}")
    print(f"  Errors:                 {r3['errors']}")
    print(f"  Pagination notes:       {r3['pagination']}")

# ── 4. Verdict ────────────────────────────────────────────────────────────────
section_header("4. VERDICT")
if r1 or (total_unique > 0):
    all_raw = r1.get("pbx_raw_rows", 0) + total_raw
    all_unique = r1.get("pbx_unique", 0) + total_unique
    if all_unique > 0:
        overall = all_raw / all_unique
        print(f"  Combined raw rows:     {all_raw}")
        print(f"  Combined unique calls: {all_unique}")
        print(f"  Overall ratio:         {overall:.2f}×")
        if 1.7 <= overall <= 2.5:
            print(f"\n  CONFIRMED: PBX stores {overall:.2f} raw CDR records per unique logical call.")
            print(f"  The 2× gap between PBX dashboard (raw records) and Connect (unique calls)")
            print(f"  is the expected counting model difference — NOT missing calls.")
        elif overall < 1.4:
            print(f"\n  WARNING: Ratio {overall:.2f}× < 1.5 — PBX may count closer to unique calls.")
            print(f"  If so, there may be genuinely missing calls in Connect beyond the model difference.")
        else:
            print(f"\n  INCONCLUSIVE: ratio {overall:.2f}× — more data needed.")

print("\nDone.")
