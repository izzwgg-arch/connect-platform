#!/usr/bin/env python3
"""Check PBX access via existing endpoints, and run reconciliation with longer timeout."""
import json, re, sys, urllib.request, urllib.error

ENV = "/opt/connectcomms/env/.env.platform"
BASE = "http://127.0.0.1:3001"
TIMEOUT = 600  # 10 min for heavy PBX page crawl


def get_secret():
    txt = open(ENV).read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", txt, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET not found")
    return m.group(1).strip()


def post_json(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    resp = urllib.request.urlopen(req, timeout=30)
    return resp.status, json.loads(resp.read().decode())


def get_bearer(path, token, qs=""):
    url = f"{BASE}{path}{qs}"
    req = urllib.request.Request(url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET")
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:2000]}


def main():
    secret = get_secret()
    st, tok = post_json("/admin/dev/generate-observe-token", {"secret": secret})
    if st != 200 or "token" not in tok:
        raise SystemExit(f"Token failed: {st} {tok}")
    token = tok["token"]

    mode = sys.argv[1] if len(sys.argv) > 1 else "recon"

    if mode == "pbx-kpis":
        st1, r1 = get_bearer("/admin/diagnostics/pbx-cdr-today-kpis", token)
        print(json.dumps({"http": st1, "result": r1}, indent=2, default=str))
    elif mode == "recon":
        qs = sys.argv[2] if len(sys.argv) > 2 else ""
        st2, r2 = get_bearer("/admin/diagnostics/cdr-pipeline-reconciliation", token, qs)
        print(json.dumps({"http": st2, "result": r2}, indent=2, default=str))
    elif mode == "connect-breakdown":
        st3, r3 = get_bearer("/admin/diagnostics/connect-cdr-today-breakdown", token)
        print(json.dumps({"http": st3, "result": r3}, indent=2, default=str))

if __name__ == "__main__":
    main()
