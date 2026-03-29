#!/usr/bin/env python3
"""Run on app server: POST /admin/dev/generate-observe-token using DEV_OBSERVE_TOKEN_SECRET from .env.platform."""
import json
import re
import urllib.request

ENV_PATH = "/opt/connectcomms/env/.env.platform"
URL = "http://127.0.0.1:3001/admin/dev/generate-observe-token"

def main() -> None:
    text = open(ENV_PATH, encoding="utf-8").read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    secret = m.group(1).strip()
    req = urllib.request.Request(
        URL,
        data=json.dumps({"secret": secret}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=60)
    print(resp.status)
    print(resp.read().decode())


if __name__ == "__main__":
    main()
