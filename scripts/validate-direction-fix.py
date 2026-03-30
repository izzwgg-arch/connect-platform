#!/usr/bin/env python3
"""
Validation script for CDR direction-correction fix.
Run on the app server after deploying the direction-fix code.

What it does:
  1. Mints an observe JWT
  2. Calls GET /admin/diagnostics/dashboard-reconciliation → raw vs canonical counts + mismatch samples
  3. Calls POST /admin/cdr/fix-directions?dryRun=true&scope=today → counts rows that would be corrected
  4. Calls POST /admin/cdr/fix-directions?dryRun=true&scope=all  → lifetime scope
  5. Prints a structured validation report

Usage (on app server):
  python3 /opt/connectcomms/scripts/validate-direction-fix.py

Exit code 0 = validation data retrieved successfully (does NOT apply any fixes).
"""
import json
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"
TIMEOUT = 120


def get_secret() -> str:
    text = open(ENV_PATH, encoding="utf-8").read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found in .env.platform")
    return m.group(1).strip()


def post_json(path: str, body: dict, token: str | None = None) -> tuple[int, dict]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_bytes = e.read().decode()
        try:
            return e.code, json.loads(body_bytes)
        except Exception:
            return e.code, {"raw": body_bytes}


def get_bearer(path: str, token: str, qs: str = "") -> tuple[int, dict]:
    url = f"{BASE}{path}{qs}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_bytes = e.read().decode()
        try:
            return e.code, json.loads(body_bytes)
        except Exception:
            return e.code, {"raw": body_bytes}


def mint_token() -> str:
    secret = get_secret()
    st, body = post_json("/admin/dev/generate-observe-token", {"secret": secret})
    if st != 200 or "token" not in body:
        raise SystemExit(f"Failed to mint observe token: {st} {body}")
    return body["token"]


def section(title: str) -> None:
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}")


def main() -> None:
    print(f"CDR Direction Fix Validation — {datetime.now(timezone.utc).isoformat()}")

    token = mint_token()
    print(f"  ✓ Observe token minted")

    # ── 1. Dashboard reconciliation: raw vs canonical counts ──────────────────
    section("1. Dashboard Reconciliation (raw vs canonical)")
    st_recon, recon = get_bearer("/admin/diagnostics/dashboard-reconciliation", token)
    print(f"  HTTP {st_recon}")
    if st_recon == 200:
        w = recon.get("window", {})
        raw = recon.get("raw", {})
        canon = recon.get("canonical", {})
        delta = recon.get("delta", {})
        mismatches = recon.get("directionMismatches", {})
        print(f"\n  Window: {w.get('todayStr')} ({w.get('timezone')})  scope={w.get('scope')}")
        print(f"\n  ┌─────────────────────────────────────────────────────┐")
        print(f"  │  Direction       Raw    Canonical    Delta          │")
        print(f"  ├─────────────────────────────────────────────────────┤")
        for d in ["incoming", "outgoing", "internal", "unknown"]:
            r = raw.get(d, 0)
            c = canon.get(d, 0) if canon else "n/a"
            dd = (c - r) if isinstance(c, int) else "n/a"
            arrow = f" ← {'+' if isinstance(dd, int) and dd > 0 else ''}{dd}" if dd not in (0, "n/a") else ""
            print(f"  │  {d:<16} {r:>6}   {c:>10}  {arrow:<16}│")
        print(f"  ├─────────────────────────────────────────────────────┤")
        print(f"  │  TOTAL          {raw.get('total',0):>6}   {canon.get('total',0) if canon else 'n/a':>10}                   │")
        print(f"  └─────────────────────────────────────────────────────┘")

        print(f"\n  Null-tenant rows: {recon.get('nullTenantRows', 'n/a')}")
        print(f"\n  Direction mismatches (stored ≠ canonical):")
        print(f"    count:   {mismatches.get('count', 0)}")
        print(f"    summary: {mismatches.get('summary', {})}")

        samples = mismatches.get("samples", [])
        if samples:
            print(f"\n  Sample misclassified rows (up to 20):")
            print(f"  {'linkedId':<36} {'from':<14} {'to':<14} {'stored':<10} {'→canonical'}")
            print(f"  {'-'*90}")
            for s in samples:
                print(f"  {s.get('linkedId',''):<36} {str(s.get('from','')):<14} {str(s.get('to','')):<14} {s.get('storedDir',''):<10} → {s.get('canonicalDir','')}")
    else:
        print(f"  ERROR: {recon}")

    # ── 2. Fix-directions dry-run (today) ─────────────────────────────────────
    section("2. fix-directions DRY-RUN (scope=today)")
    st_dry, dry = post_json(
        "/admin/cdr/fix-directions?dryRun=true&scope=today",
        {},
        token=token,
    )
    print(f"  HTTP {st_dry}")
    if st_dry == 200:
        print(f"  Rows scanned:    {dry.get('rowsScanned', 'n/a')}")
        print(f"  Would fix today: {dry.get('wouldFix', 'n/a')}")
        print(f"  Summary: {dry.get('summary', {})}")
        samples_dry = dry.get("samples", [])
        if samples_dry:
            print(f"\n  Samples that would be corrected:")
            print(f"  {'linkedId':<36} {'from':<14} {'to':<14} {'was':<10} {'→becomes'}")
            print(f"  {'-'*90}")
            for s in samples_dry[:20]:
                print(f"  {s.get('linkedId',''):<36} {str(s.get('from','')):<14} {str(s.get('to','')):<14} {s.get('was',''):<10} → {s.get('becomes','')}")
        else:
            print("  (No corrections needed — stored directions already match canonical rules.)")
    else:
        print(f"  ERROR: {dry}")

    # ── 3. Fix-directions dry-run (all time) ─────────────────────────────────
    section("3. fix-directions DRY-RUN (scope=all)")
    st_all, all_dry = post_json(
        "/admin/cdr/fix-directions?dryRun=true&scope=all",
        {},
        token=token,
    )
    print(f"  HTTP {st_all}")
    if st_all == 200:
        print(f"  Rows scanned (all time): {all_dry.get('rowsScanned', 'n/a')}")
        print(f"  Would fix (all time):    {all_dry.get('wouldFix', 'n/a')}")
        print(f"  Summary: {all_dry.get('summary', {})}")
    else:
        print(f"  ERROR: {all_dry}")

    # ── 4. VALIDATION VERDICT ─────────────────────────────────────────────────
    section("4. VALIDATION VERDICT")
    if st_recon == 200:
        raw_in  = recon.get("raw", {}).get("incoming", 0)
        raw_out = recon.get("raw", {}).get("outgoing", 0)
        can_in  = (recon.get("canonical") or {}).get("incoming", 0)
        can_out = (recon.get("canonical") or {}).get("outgoing", 0)
        miscount = recon.get("directionMismatches", {}).get("count", 0)

        print(f"\n  Incoming:  raw={raw_in}  canonical={can_in}  (moved OUT: {raw_in - can_in})")
        print(f"  Outgoing:  raw={raw_out}  canonical={can_out}  (gained: {can_out - raw_out})")
        print(f"  Rows needing correction:  {miscount}")

        if miscount > 0:
            print(f"\n  ⚠  {miscount} rows in DB still have wrong stored direction.")
            print(f"     New calls will be stored correctly (ingest override is deployed).")
            print(f"     To fix existing rows: POST /admin/cdr/fix-directions?dryRun=false&scope=all")
        else:
            print(f"\n  ✓  All rows match canonical direction. No backfill needed.")
    else:
        print("  (Skipped — reconciliation call failed.)")

    print(f"\n  Done. No data was modified (all operations were read-only / dryRun).\n")


if __name__ == "__main__":
    main()
