#!/usr/bin/env python3
"""Apply direction backfill: POST /admin/cdr/fix-directions?dryRun=false&scope=all"""
import json, re, urllib.request, urllib.error

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"

secret = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", open(ENV_PATH).read(), re.M).group(1).strip()
tok_r = urllib.request.urlopen(urllib.request.Request(
    f"{BASE}/admin/dev/generate-observe-token",
    json.dumps({"secret": secret}).encode(),
    {"Content-Type": "application/json"}, method="POST"), timeout=30)
token = json.loads(tok_r.read())["token"]

req = urllib.request.Request(
    f"{BASE}/admin/cdr/fix-directions?dryRun=false&scope=all",
    b"{}",
    {"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    method="POST")
try:
    r = urllib.request.urlopen(req, timeout=120)
    body = json.loads(r.read())
    print(json.dumps(body, indent=2))
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()}")
