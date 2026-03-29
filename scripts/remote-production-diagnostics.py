#!/usr/bin/env python3
"""On app server: mint observe JWT and fetch PBX + Connect CDR diagnostics (super-admin)."""
import json
import re
import urllib.request

ENV_PATH = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"


def get_secret() -> str:
    text = open(ENV_PATH, encoding="utf-8").read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    return m.group(1).strip()


def post_json(path: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=120)
    raw = resp.read().decode()
    return resp.status, json.loads(raw)


def get_bearer(path: str, token: str) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    resp = urllib.request.urlopen(req, timeout=120)
    raw = resp.read().decode()
    return resp.status, json.loads(raw)


def main() -> None:
    secret = get_secret()
    st, tok_body = post_json("/admin/dev/generate-observe-token", {"secret": secret})
    if st != 200 or "token" not in tok_body:
        print(json.dumps({"observe_status": st, "body": tok_body}))
        raise SystemExit(1)
    token = tok_body["token"]

    st1, pbx = get_bearer("/admin/diagnostics/pbx-cdr-today-kpis", token)
    st2, conn = get_bearer("/admin/diagnostics/connect-cdr-today-breakdown", token)

    out = {
        "observe_token_http": st,
        "pbx_cdr_today_kpis_http": st1,
        "pbx_cdr_today_kpis": pbx,
        "connect_cdr_breakdown_http": st2,
        "connect_cdr_today_breakdown": conn,
    }
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
