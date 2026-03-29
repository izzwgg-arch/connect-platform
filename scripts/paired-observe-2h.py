#!/usr/bin/env python3
"""
Production 2-hour paired observation: VitalPBX CDR KPIs + ARI active vs Connect live + CDR breakdown.
Run on app server; logs NDJSON to path arg (default /opt/connectcomms/logs/paired-observe-2h.ndjson).
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ENV_PATH = "/opt/connectcomms/env/.env.platform"
API = "http://127.0.0.1:3001"
INTERVAL_SEC = 25
DURATION_SEC = 7200


def read_secret() -> str:
    text = open(ENV_PATH, encoding="utf-8").read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET missing in .env.platform")
    return m.group(1).strip()


def post_json(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode())


def get_json(path: str, token: str) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        f"{API}{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() or str(e)
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body


def mint_token(secret: str) -> str:
    out = post_json("/admin/dev/generate-observe-token", {"secret": secret})
    return out["token"]


def main() -> None:
    log_path = sys.argv[1] if len(sys.argv) > 1 else "/opt/connectcomms/logs/paired-observe-2h.ndjson"
    secret = read_secret()
    n_samples = DURATION_SEC // INTERVAL_SEC
    start = time.time()
    start_iso = datetime.now(timezone.utc).isoformat()

    with open(log_path, "a", encoding="utf-8") as log:
        log.write(
            json.dumps(
                {
                    "type": "meta",
                    "startIso": start_iso,
                    "intervalSec": INTERVAL_SEC,
                    "durationSec": DURATION_SEC,
                    "plannedSamples": n_samples,
                }
            )
            + "\n"
        )

        for i in range(n_samples):
            loop_start = time.time()
            token = mint_token(secret)
            st_pbx, pbx = get_json("/admin/diagnostics/pbx-cdr-today-kpis", token)
            st_live, live = get_json("/admin/pbx/live/combined", token)
            st_ari, ari = get_json("/admin/diagnostics/ari-bridged-active-calls", token)
            st_br, br = get_json("/admin/diagnostics/connect-cdr-today-breakdown", token)

            summ = live.get("summary") if isinstance(live, dict) else None
            rec = {
                "type": "sample",
                "sample": i + 1,
                "timestampUtc": datetime.now(timezone.utc).isoformat(),
                "http": {
                    "pbxCdrKpis": st_pbx,
                    "connectLiveCombined": st_live,
                    "ariBridged": st_ari,
                    "connectCdrBreakdown": st_br,
                },
                "pbx": {
                    "cdr": pbx if isinstance(pbx, dict) else None,
                    "ariFinalActiveCalls": ari.get("finalActiveCalls") if isinstance(ari, dict) else None,
                    "ariRawChannels": ari.get("rawChannelCount") if isinstance(ari, dict) else None,
                },
                "connect": {
                    "live": summ,
                    "activeCallsListCount": len((live.get("activeCalls") or {}).get("calls") or [])
                    if isinstance(live, dict)
                    else None,
                    "breakdown": {
                        "countsByDirection": br.get("countsByDirection") if isinstance(br, dict) else None,
                        "totalRows": br.get("totalRows") if isinstance(br, dict) else None,
                        "tenantIdNullCount": br.get("tenantIdNullCount") if isinstance(br, dict) else None,
                        "heuristicNotOutgoingShortFromLongToCount": br.get(
                            "heuristicNotOutgoingShortFromLongToCount"
                        )
                        if isinstance(br, dict)
                        else None,
                        "liveDashboardKpis": br.get("liveDashboardKpis") if isinstance(br, dict) else None,
                    }
                    if isinstance(br, dict)
                    else None,
                },
            }
            log.write(json.dumps(rec, default=str) + "\n")
            log.flush()

            elapsed = time.time() - loop_start
            sleep_for = max(0.0, INTERVAL_SEC - elapsed)
            time.sleep(sleep_for)

    end_iso = datetime.now(timezone.utc).isoformat()
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps({"type": "meta", "endIso": end_iso, "samplesWritten": n_samples}) + "\n")


if __name__ == "__main__":
    main()
