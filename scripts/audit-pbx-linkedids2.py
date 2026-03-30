#!/usr/bin/env python3
"""Full pipeline reconciliation dump to understand why PBX counts are zero."""
import json, re, urllib.request, urllib.error

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"

def get_secret():
    text = open(ENV_PATH).read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    return m.group(1).strip()

def post_json(path, body):
    req = urllib.request.Request(f"{BASE}{path}", json.dumps(body).encode(),
                                  {"Content-Type": "application/json"}, method="POST")
    r = urllib.request.urlopen(req, timeout=30)
    return json.loads(r.read())

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

token = post_json("/admin/dev/generate-observe-token", {"secret": get_secret()})["token"]
print("Token minted")

# Print full reconciliation JSON (first 3000 chars, structured)
st, data = get_bearer("/admin/diagnostics/cdr-pipeline-reconciliation", token)
print(f"\nHTTP {st}")
# Show all keys
top = {k: v for k, v in data.items() if k not in ("matched", "onlyInPbx", "onlyInConnect")}
print(json.dumps(top, indent=2, default=str)[:4000])
print(f"\nonlyInPbx count: {len(data.get('onlyInPbx', []))}")
print(f"onlyInConnect count: {len(data.get('onlyInConnect', []))}")
print(f"matched count: {len(data.get('matched', []))}")

# Also check what tenants are visible
print("\n=== Testing PBX tenant list via dashboard KPIs pbx endpoint ===")
st2, kpis = get_bearer("/dashboard/call-kpis", token, "?source=pbx")
print(f"HTTP {st2}")
print(json.dumps(kpis, indent=2, default=str)[:1000])
