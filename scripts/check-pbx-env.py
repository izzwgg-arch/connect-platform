#!/usr/bin/env python3
import json, re, urllib.request, datetime

ENV = "/opt/connectcomms/env/.env.platform"
txt = open(ENV).read()

def env(key):
    m = re.search(r"^" + key + r"=(.+)$", txt, re.M)
    return m.group(1).strip() if m else None

base = env("PBX_BASE_URL") or ""
token = env("PBX_API_TOKEN") or ""
secret = env("PBX_API_SECRET") or ""
tz = env("PBX_TIMEZONE") or "UTC"

print("BASE:", base)
print("TOKEN:", (token[:8]+"...") if token else "(not set)")
print("SECRET:", "(set)" if secret else "(not set)")
print("TIMEZONE:", tz)
print()

# Try to list tenants with a 20s timeout
url = base.rstrip("/") + "/api/v2/tenants"
headers = {"api-key": token}
if secret:
    headers["api-secret"] = secret
headers["Accept"] = "application/json"
req = urllib.request.Request(url, headers=headers)
try:
    resp = urllib.request.urlopen(req, timeout=20)
    data = json.loads(resp.read().decode())
    tenants = data.get("data", data) if isinstance(data, dict) else data
    if isinstance(tenants, list):
        names = [str(t.get("name","?")) for t in tenants[:30]]
        print(f"TENANTS ({len(tenants)} total): {names}")
    else:
        print("TENANTS RESPONSE:", json.dumps(data)[:500])
except Exception as e:
    print("TENANT LIST ERROR:", e)
