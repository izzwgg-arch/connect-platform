#!/usr/bin/env python3
"""
Production 2-hour paired observation: VitalPBX CDR KPIs + ARI active vs Connect live + CDR breakdown.

Low PBX load (default):
- Sample interval 75s (60–90s band).
- VitalPBX-heavy GET /admin/diagnostics/pbx-cdr-today-kpis cached ~300s (reuses last JSON).
- ARI diagnostic cached ~90s (reuses last JSON).
- Observe JWT reused until ~2 min before exp (no mint every tick).
- fcntl lock: only one instance runs.

Run on app server:
  python3 scripts/paired-observe-2h.py /opt/connectcomms/logs/paired-observe-2h.ndjson
"""
from __future__ import annotations

import base64
import fcntl
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ENV_PATH = "/opt/connectcomms/env/.env.platform"
API = "http://127.0.0.1:3001"
LOCK_PATH = "/opt/connectcomms/logs/paired-observe-2h.lock"

# 60–90s observation cadence (wall clock for Connect + log granularity)
INTERVAL_SEC = 75
DURATION_SEC = 7200

# PBX/VitalPBX load: refresh CDR KPI aggregate at most every 5 minutes
PBX_CDR_CACHE_TTL_SEC = 300
# ARI hits Asterisk on PBX host — cache 90s
ARI_CACHE_TTL_SEC = 90


def read_secret() -> str:
    text = open(ENV_PATH, encoding="utf-8").read()
    m = re.search(r"^DEV_OBSERVE_TOKEN_SECRET=(.+)$", text, re.M)
    if not m:
        raise SystemExit("DEV_OBSERVE_TOKEN_SECRET missing in .env.platform")
    return m.group(1).strip()


def acquire_singleton_lock():
    """Exit if another paired-observe-2h.py already holds the lock."""
    import os

    os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
    lockf = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another paired-observe-2h.py is already running (lock held).")
    lockf.write(f"{os.getpid()}\n")
    lockf.flush()
    return lockf


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


def jwt_exp_unix(token: str) -> float:
    try:
        payload_b64 = token.split(".")[1]
        pad = "=" * ((4 - len(payload_b64) % 4) % 4)
        raw = base64.urlsafe_b64decode(payload_b64 + pad)
        return float(json.loads(raw.decode()).get("exp", 0))
    except Exception:
        return 0.0


class TokenCache:
    def __init__(self) -> None:
        self._token: str | None = None
        self._exp: float = 0.0

    def get(self, secret: str) -> str:
        now = time.time()
        if self._token and now < self._exp - 120:
            return self._token
        self._token = mint_token(secret)
        self._exp = jwt_exp_unix(self._token) or (now + 3600)
        return self._token


class TimedCache:
    def __init__(self, ttl_sec: float) -> None:
        self.ttl = ttl_sec
        self._until: float = 0.0
        self._status: int | None = None
        self._body: dict | str | None = None

    def get(self, fetch) -> tuple[int, dict | str, bool]:
        """fetch is zero-arg lambda -> (status, body). Returns (st, body, from_cache)."""
        now = time.time()
        if self._body is not None and now < self._until:
            return self._status or 0, self._body, True
        st, body = fetch()
        if st == 200 and isinstance(body, dict):
            self._status = st
            self._body = body
            self._until = now + self.ttl
        else:
            # do not cache errors
            pass
        return st, body, False


def main() -> None:
    lockf = acquire_singleton_lock()
    try:
        _run()
    finally:
        try:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        lockf.close()


def _run() -> None:
    log_path = sys.argv[1] if len(sys.argv) > 1 else "/opt/connectcomms/logs/paired-observe-2h.ndjson"
    secret = read_secret()
    n_samples = DURATION_SEC // INTERVAL_SEC
    start_iso = datetime.now(timezone.utc).isoformat()

    tok = TokenCache()
    pbx_cdr_cache = TimedCache(PBX_CDR_CACHE_TTL_SEC)
    ari_cache = TimedCache(ARI_CACHE_TTL_SEC)

    with open(log_path, "a", encoding="utf-8") as log:
        log.write(
            json.dumps(
                {
                    "type": "meta",
                    "startIso": start_iso,
                    "intervalSec": INTERVAL_SEC,
                    "durationSec": DURATION_SEC,
                    "plannedSamples": n_samples,
                    "loadReduction": {
                        "pbxCdrCacheTtlSec": PBX_CDR_CACHE_TTL_SEC,
                        "ariCacheTtlSec": ARI_CACHE_TTL_SEC,
                        "jwtReuse": True,
                    },
                }
            )
            + "\n"
        )

        for i in range(n_samples):
            loop_start = time.time()
            token = tok.get(secret)

            def fetch_pbx():
                return get_json("/admin/diagnostics/pbx-cdr-today-kpis", token)

            def fetch_ari():
                return get_json("/admin/diagnostics/ari-bridged-active-calls", token)

            st_pbx, pbx, pbx_cached = pbx_cdr_cache.get(fetch_pbx)
            st_live, live = get_json("/admin/pbx/live/combined", token)
            st_ari, ari, ari_cached = ari_cache.get(fetch_ari)
            st_br, br = get_json("/admin/diagnostics/connect-cdr-today-breakdown", token)

            summ = live.get("summary") if isinstance(live, dict) else None
            rec = {
                "type": "sample",
                "sample": i + 1,
                "timestampUtc": datetime.now(timezone.utc).isoformat(),
                "cache": {
                    "pbxCdrKpis": pbx_cached,
                    "ariBridged": ari_cached,
                },
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
