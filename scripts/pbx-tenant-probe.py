#!/usr/bin/env python3
"""Probe each PBX tenant's cdr.list for today to find which ones are slow/large."""
import json, re, sys, time, datetime, urllib.request, urllib.error

ENV = "/opt/connectcomms/env/.env.platform"
BASE_API = "http://127.0.0.1:3001"
TIMEOUT = 30


def get_secret():
    txt = open(ENV).read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", txt, re.M)
    if not m: raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    return m.group(1).strip()


def post_json(path, body):
    req = urllib.request.Request(f"{BASE_API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    resp = urllib.request.urlopen(req, timeout=30)
    return resp.status, json.loads(resp.read().decode())


def get_bearer(path, token, qs=""):
    url = f"{BASE_API}{path}{qs}"
    req = urllib.request.Request(url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET")
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main():
    secret = get_secret()
    _, tok = post_json("/admin/dev/generate-observe-token", {"secret": secret})
    token = tok["token"]

    # Get tenant list from PBX
    st, tenants_resp = get_bearer("/admin/pbx/tenants", token)
    tenants = tenants_resp if isinstance(tenants_resp, list) else (tenants_resp.get("data") or tenants_resp.get("tenants") or [])
    print(f"Got {len(tenants)} tenants (HTTP {st})")
    print(json.dumps(tenants[:5], indent=2, default=str))

    # Also check the existing kpis debug
    st2, kpis = get_bearer("/admin/diagnostics/pbx-cdr-today-kpis", token)
    print(f"\npbx-cdr-today-kpis HTTP {st2}: {json.dumps(kpis, default=str)[:1000]}")

    # Check connect breakdown for comparison
    st3, conn = get_bearer("/admin/diagnostics/connect-cdr-today-breakdown", token)
    print(f"\nconnect-breakdown HTTP {st3}:")
    summary = {
        "totalRows": conn.get("totalRows"),
        "countsByDirection": conn.get("countsByDirection"),
        "tenantIdNullCount": conn.get("tenantIdNullCount"),
        "dayStartUtc": conn.get("dayStartUtc"),
        "dayEndUtc": conn.get("dayEndUtc"),
        "liveDashboardKpis": conn.get("liveDashboardKpis"),
    }
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
