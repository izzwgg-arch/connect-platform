#!/usr/bin/env python3
"""Run on app server: mint observe JWT and call the CDR pipeline reconciliation endpoint."""
import json
import re
import sys
import urllib.request

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"
TIMEOUT = 300


def get_secret() -> str:
    text = open(ENV_PATH, encoding="utf-8").read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    return m.group(1).strip()


def post_json(path: str, body: dict) -> tuple:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=TIMEOUT)
    return resp.status, json.loads(resp.read().decode())


def get_bearer(path: str, token: str, qs: str = "") -> tuple:
    url = f"{BASE}{path}{qs}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        return resp.status, json.loads(resp.read().decode())
    except urllib.request.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body}


def main() -> None:
    qs = sys.argv[1] if len(sys.argv) > 1 else ""

    secret = get_secret()
    st, tok_body = post_json("/admin/dev/generate-observe-token", {"secret": secret})
    if st != 200 or "token" not in tok_body:
        print(json.dumps({"observe_status": st, "body": tok_body}))
        raise SystemExit(1)
    token = tok_body["token"]

    st_recon, recon = get_bearer("/admin/diagnostics/cdr-pipeline-reconciliation", token, qs)

    out = {
        "observe_token_http": st,
        "cdr_pipeline_reconciliation_http": st_recon,
        "cdr_pipeline_reconciliation": recon,
    }
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
