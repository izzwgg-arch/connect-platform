#!/usr/bin/env python3
"""
VitalPBX inbound-route retarget helper for Connect.

This service intentionally exposes only three mutating surfaces:
  - inspect one DID/tenant
  - retarget that exact route to a preconfigured Connect destination_id
  - restore that exact route to a captured destination_id

It does not expose arbitrary SQL, does not update trunks/extensions/tenants,
and rejects missing or ambiguous DID matches.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import grp
import hashlib
import hmac
import json
import os
import pwd
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pymysql

VERSION = "2026.05.03"
DID_RE = re.compile(r"^\+?\d{7,20}$")
TENANT_RE = re.compile(r"^\d{1,10}$")
DEST_RE = re.compile(r"^\d{1,10}$")
# IVR prompt basename: same character set the rest of Connect's catalog
# enforces. We additionally cap at 120 chars so the on-disk filename
# remains comfortably under ext4 limits even with the .wav suffix.
PROMPT_BASE_RE = re.compile(r"^[A-Za-z0-9_\-.]{1,120}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Hard cap on inbound JSON body. The base64-encoded WAV for a 60-second
# greeting is ~1.3 MB — 16 MB leaves room for unusually long announcements
# while still bounding the helper's per-request memory footprint.
MAX_REQUEST_BYTES = 16 * 1024 * 1024
# Hard cap on the decoded WAV bytes we'll write to /var/lib/asterisk/sounds.
MAX_WAV_BYTES = 12 * 1024 * 1024


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def normalize_did(raw: Any) -> tuple[str, str]:
    value = str(raw or "").strip()
    digits = re.sub(r"\D", "", value)
    if not DID_RE.match(value) and not (7 <= len(digits) <= 20):
        raise ValueError("invalid_did")
    return digits, f"+{digits}"


def require_numeric(name: str, value: Any, pattern: re.Pattern[str]) -> str:
    text = str(value or "").strip()
    if not pattern.match(text):
        raise ValueError(f"invalid_{name}")
    return text


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


class Config:
    def __init__(self) -> None:
        self.bind = os.environ.get("CONNECT_PBX_HELPER_BIND", "127.0.0.1")
        self.port = int(os.environ.get("CONNECT_PBX_HELPER_PORT", "8757"))
        self.secret = os.environ.get("CONNECT_PBX_HELPER_SECRET", "")
        self.mysql_host = os.environ.get("OMBU_MYSQL_HOST", "127.0.0.1")
        self.mysql_port = int(os.environ.get("OMBU_MYSQL_PORT", "3306"))
        self.mysql_user = os.environ.get("OMBU_MYSQL_USER", "")
        self.mysql_password = os.environ.get("OMBU_MYSQL_PASSWORD", "")
        self.mysql_db = os.environ.get("OMBU_MYSQL_DB", "ombutel")
        self.mysql_socket = os.environ.get("OMBU_MYSQL_SOCKET", "")
        self.data_dir = Path(os.environ.get("CONNECT_PBX_HELPER_DATA_DIR", "/var/lib/connect-pbx-helper"))
        self.audit_file = Path(os.environ.get("CONNECT_PBX_HELPER_AUDIT_FILE", str(self.data_dir / "audit.jsonl")))
        self.snapshot_db = Path(os.environ.get("CONNECT_PBX_HELPER_SNAPSHOT_DB", str(self.data_dir / "snapshots.sqlite3")))
        self.default_connect_destination_id = os.environ.get("CONNECT_PBX_CONNECT_DESTINATION_ID", "").strip()
        # Empty = skip. Configure to a known-safe exact command, e.g.
        # CONNECT_PBX_HELPER_APPLY_COMMAND='asterisk -rx "dialplan reload"'
        self.apply_command = os.environ.get("CONNECT_PBX_HELPER_APPLY_COMMAND", "").strip()
        self.apply_timeout_sec = int(os.environ.get("CONNECT_PBX_HELPER_APPLY_TIMEOUT_SEC", "30"))
        # IVR prompt sync (Connect → PBX). Defaults match VitalPBX's stock
        # custom recordings dir, so the dialplan's
        # `STAT(/var/lib/asterisk/sounds/${GREETING}.wav)` check resolves
        # against the same files this helper writes.
        self.sounds_dir = Path(os.environ.get("CONNECT_PBX_HELPER_SOUNDS_DIR", "/var/lib/asterisk/sounds/custom"))
        self.sounds_owner_user = os.environ.get("CONNECT_PBX_HELPER_SOUNDS_OWNER_USER", "asterisk").strip()
        self.sounds_owner_group = os.environ.get("CONNECT_PBX_HELPER_SOUNDS_OWNER_GROUP", "asterisk").strip()
        self.sounds_file_mode = int(os.environ.get("CONNECT_PBX_HELPER_SOUNDS_FILE_MODE", "0o644"), 0)

    def validate(self) -> None:
        if len(self.secret) < 32:
            raise SystemExit("CONNECT_PBX_HELPER_SECRET must be at least 32 characters")
        if not self.mysql_user:
            raise SystemExit("OMBU_MYSQL_USER is required")
        self.data_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        self.audit_file.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        self.snapshot_db.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if self.default_connect_destination_id and not DEST_RE.match(self.default_connect_destination_id):
            raise SystemExit("CONNECT_PBX_CONNECT_DESTINATION_ID must be numeric")


CFG = Config()


def db_conn():
    kwargs: dict[str, Any] = {
        "user": CFG.mysql_user,
        "password": CFG.mysql_password,
        "database": CFG.mysql_db,
        "cursorclass": pymysql.cursors.DictCursor,
        "autocommit": False,
        "charset": "utf8mb4",
    }
    if CFG.mysql_socket:
        kwargs["unix_socket"] = CFG.mysql_socket
    else:
        kwargs["host"] = CFG.mysql_host
        kwargs["port"] = CFG.mysql_port
    return pymysql.connect(**kwargs)


def snapshot_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(CFG.snapshot_db))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS inbound_route_snapshots (
          route_id INTEGER PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          did_digits TEXT NOT NULL,
          did_e164 TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          captured_by TEXT,
          request_id TEXT,
          original_row_json TEXT NOT NULL,
          original_destination_id TEXT NOT NULL,
          current_connect_destination_id TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snap_did ON inbound_route_snapshots(tenant_id, did_digits)")
    return conn


def audit(action: str, ok: bool, payload: dict[str, Any], result: dict[str, Any] | None = None, error: str | None = None) -> None:
    entry = {
        "ts": utc_now(),
        "version": VERSION,
        "action": action,
        "ok": ok,
        "payload": payload,
        "result": result,
        "error": error,
    }
    with CFG.audit_file.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")


def find_route(conn, tenant_id: str, did_digits: str) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT inbound_route_id, cos_id, description, routing_method, did,
                   channel_id, cid_management_id, cid_lookup_id, cid_number,
                   destination_id, language, music_group_id, alertinfo,
                   enablerecording, digits_to_take, prepend, append, faxdetection,
                   drop_anon_calls, detectiontime, fax_destination_id, privacyman,
                   pmminlength, pmmaxretries, tenant_id
            FROM ombu_inbound_routes
            WHERE tenant_id = %s
              AND REPLACE(COALESCE(did, ''), '+', '') = %s
            """,
            (tenant_id, did_digits),
        )
        rows = cur.fetchall()
    if len(rows) == 0:
        raise LookupError("did_not_found")
    if len(rows) > 1:
        raise RuntimeError("multiple_routes_matched")
    return rows[0]


def destination_exists(conn, destination_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM ombu_destinations WHERE id = %s", (destination_id,))
        return cur.fetchone() is not None


def apply_changes() -> dict[str, Any]:
    if not CFG.apply_command:
        return {"ran": False, "reason": "apply_command_not_configured"}
    argv = shlex.split(CFG.apply_command)
    started = time.time()
    proc = subprocess.run(
        argv,
        text=True,
        capture_output=True,
        timeout=CFG.apply_timeout_sec,
        check=False,
    )
    return {
        "ran": True,
        "argv": argv,
        "exitCode": proc.returncode,
        "elapsedMs": int((time.time() - started) * 1000),
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
    }


def inspect_route(body: dict[str, Any]) -> dict[str, Any]:
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_numeric("tenant_id", body.get("tenantId"), TENANT_RE)
    with db_conn() as conn:
        route = find_route(conn, tenant_id, did_digits)
    snap = None
    with snapshot_conn() as sconn:
        row = sconn.execute("SELECT * FROM inbound_route_snapshots WHERE route_id = ?", (route["inbound_route_id"],)).fetchone()
        if row:
            cols = [d[0] for d in sconn.execute("SELECT * FROM inbound_route_snapshots LIMIT 0").description]
            snap = dict(zip(cols, row))
    return {
        "ok": True,
        "version": VERSION,
        "did": did_e164,
        "didDigits": did_digits,
        "tenantId": tenant_id,
        "route": route,
        "snapshot": snap,
        "mode": "connect" if str(route.get("destination_id")) == str((snap or {}).get("current_connect_destination_id")) else "pbx",
    }


def retarget_route(body: dict[str, Any]) -> dict[str, Any]:
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_numeric("tenant_id", body.get("tenantId"), TENANT_RE)
    connect_destination_id = str(body.get("connectDestinationId") or CFG.default_connect_destination_id).strip()
    connect_destination_id = require_numeric("connect_destination_id", connect_destination_id, DEST_RE)
    force = bool(body.get("force", False))
    request_id = str(body.get("requestId") or "").strip()[:128]
    actor = str(body.get("actor") or "").strip()[:128]

    with db_conn() as conn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            original_destination_id = str(route["destination_id"])
            if original_destination_id == connect_destination_id:
                conn.rollback()
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route}
            if not destination_exists(conn, connect_destination_id):
                raise RuntimeError("connect_destination_not_found")

            with snapshot_conn() as sconn:
                existing = sconn.execute(
                    "SELECT original_destination_id FROM inbound_route_snapshots WHERE route_id = ?",
                    (route_id,),
                ).fetchone()
                if existing and not force:
                    # Already captured. Only proceed if the route is still either
                    # original or the current connect destination. Anything else is drift.
                    existing_original = str(existing[0])
                    if original_destination_id not in (existing_original, connect_destination_id):
                        raise RuntimeError("route_drifted_since_capture")
                if not existing:
                    sconn.execute(
                        """
                        INSERT INTO inbound_route_snapshots
                          (route_id, tenant_id, did_digits, did_e164, captured_at, captured_by,
                           request_id, original_row_json, original_destination_id, current_connect_destination_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            route_id,
                            tenant_id,
                            did_digits,
                            did_e164,
                            utc_now(),
                            actor,
                            request_id,
                            json_dumps(route),
                            original_destination_id,
                            connect_destination_id,
                        ),
                    )
                else:
                    sconn.execute(
                        "UPDATE inbound_route_snapshots SET current_connect_destination_id = ? WHERE route_id = ?",
                        (connect_destination_id, route_id),
                    )
                sconn.commit()

            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE ombu_inbound_routes
                    SET destination_id = %s
                    WHERE inbound_route_id = %s
                      AND tenant_id = %s
                      AND destination_id = %s
                    """,
                    (connect_destination_id, route_id, tenant_id, original_destination_id),
                )
                if cur.rowcount != 1:
                    raise RuntimeError("retarget_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    apply_result = apply_changes()
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {
        "ok": True,
        "did": did_e164,
        "tenantId": tenant_id,
        "routeId": route_id,
        "before": route,
        "after": after,
        "connectDestinationId": connect_destination_id,
        "apply": apply_result,
    }


def restore_route(body: dict[str, Any]) -> dict[str, Any]:
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_numeric("tenant_id", body.get("tenantId"), TENANT_RE)
    force = bool(body.get("force", False))

    with db_conn() as conn, snapshot_conn() as sconn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            snap = sconn.execute(
                "SELECT original_destination_id, current_connect_destination_id FROM inbound_route_snapshots WHERE route_id = ?",
                (route_id,),
            ).fetchone()
            if not snap:
                raise LookupError("snapshot_not_found")
            original_destination_id = str(snap[0])
            connect_destination_id = str(snap[1] or "")
            current_destination_id = str(route["destination_id"])
            if current_destination_id == original_destination_id:
                conn.rollback()
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route}
            if not force and connect_destination_id and current_destination_id != connect_destination_id:
                raise RuntimeError("route_drifted_since_retarget")
            if not destination_exists(conn, original_destination_id):
                raise RuntimeError("original_destination_not_found")
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE ombu_inbound_routes
                    SET destination_id = %s
                    WHERE inbound_route_id = %s
                      AND tenant_id = %s
                      AND destination_id = %s
                    """,
                    (original_destination_id, route_id, tenant_id, current_destination_id),
                )
                if cur.rowcount != 1:
                    raise RuntimeError("restore_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    apply_result = apply_changes()
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {
        "ok": True,
        "did": did_e164,
        "tenantId": tenant_id,
        "routeId": route_id,
        "before": route,
        "after": after,
        "restoredDestinationId": original_destination_id,
        "apply": apply_result,
    }


def upload_prompt(body: dict[str, Any]) -> dict[str, Any]:
    """Write a Connect-supplied IVR prompt audio file to /var/lib/asterisk/sounds/custom/.

    Body shape (JSON):
        {
          "fileBaseName": "test_greeting_20260426",   # bare basename, no ext
          "sha256": "<hex>",                          # of the decoded WAV bytes
          "sizeBytes": 12345,                         # decoded length, advisory
          "bytesB64": "<base64>",                     # the WAV bytes
          "tenantSlug": "landau_home",                # context (audit only)
          "promptRef": "custom/test_greeting_…",       # context (audit only)
          "requestedBy": "user:abc"                   # context (audit only)
        }

    The handler:
      - Decodes base64, verifies sha256, enforces size cap.
      - If a file with the same sha already exists at the target path,
        skips the rewrite and returns `unchanged: true` (idempotent retries
        from Connect's catch-up cron are free).
      - Atomic write: stage in a temp file in the same directory, then
        os.replace() onto the final path so partial writes can never be
        played by `Background()` mid-call.
      - Best-effort chown to asterisk:asterisk + chmod 0644 so the
        Asterisk channel driver can read it. Failures are logged but
        not fatal — many production hosts run Asterisk under a different
        UID, and the operator may have already widened group perms.
    """
    base = str(body.get("fileBaseName") or "").strip()
    if not PROMPT_BASE_RE.match(base):
        raise ValueError("invalid_fileBaseName")
    sha = str(body.get("sha256") or "").strip().lower()
    if not SHA256_RE.match(sha):
        raise ValueError("invalid_sha256")
    bytes_b64 = body.get("bytesB64")
    if not isinstance(bytes_b64, str) or not bytes_b64:
        raise ValueError("bytesB64_required")
    try:
        wav_bytes = base64.b64decode(bytes_b64, validate=True)
    except Exception as exc:
        raise ValueError("base64_decode_failed: " + str(exc))
    if not wav_bytes:
        raise ValueError("empty_decoded_bytes")
    if len(wav_bytes) > MAX_WAV_BYTES:
        raise ValueError("wav_too_large")
    actual_sha = hashlib.sha256(wav_bytes).hexdigest()
    if not hmac.compare_digest(actual_sha, sha):
        raise ValueError("sha256_mismatch")

    # Sanity: the bytes should look like a RIFF WAV. Asterisk WILL play
    # other things, but Connect-side conversion is supposed to produce
    # WAV — refusing anything else here keeps a corrupted upload from
    # silently breaking the IVR for callers.
    if not (wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE"):
        raise ValueError("not_a_riff_wav")

    sounds_dir = CFG.sounds_dir
    if not sounds_dir.is_dir():
        raise RuntimeError("sounds_dir_missing: " + str(sounds_dir))

    target = sounds_dir / (base + ".wav")
    # Idempotency: skip if the file already matches sha. Saves a syscall
    # storm when the catch-up cron and the immediate push race.
    if target.is_file():
        try:
            with target.open("rb") as fh:
                existing_sha = hashlib.sha256(fh.read()).hexdigest()
            if hmac.compare_digest(existing_sha, sha):
                return {
                    "ok": True,
                    "unchanged": True,
                    "fileBaseName": base,
                    "pbxPath": str(target),
                    "sha256": sha,
                    "sizeBytes": len(wav_bytes),
                }
        except OSError:
            # Existing file is unreadable to us — fall through and rewrite.
            pass

    # Atomic write: temp file in the same directory + os.replace().
    tmp_fd, tmp_path = tempfile.mkstemp(prefix="." + base + ".", suffix=".wav.tmp", dir=str(sounds_dir))
    tmp_p = Path(tmp_path)
    try:
        with os.fdopen(tmp_fd, "wb") as fh:
            fh.write(wav_bytes)
            fh.flush()
            os.fsync(fh.fileno())
        # Best-effort permissions before the rename. Ignored if running
        # without the rights to chown — Asterisk usually still reads via
        # the group bit (0644).
        try:
            os.chmod(tmp_path, CFG.sounds_file_mode)
        except OSError:
            pass
        if CFG.sounds_owner_user:
            try:
                uid = pwd.getpwnam(CFG.sounds_owner_user).pw_uid
                gid = (
                    grp.getgrnam(CFG.sounds_owner_group).gr_gid
                    if CFG.sounds_owner_group
                    else -1
                )
                os.chown(tmp_path, uid, gid)
            except (KeyError, PermissionError, OSError):
                # Not running as root or asterisk user doesn't exist —
                # we still got the bytes onto disk, which is the
                # critical thing.
                pass
        os.replace(tmp_path, target)
    except Exception:
        # Clean up the temp on any failure path so we don't leak
        # half-written files into the sounds dir.
        try:
            tmp_p.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    return {
        "ok": True,
        "fileBaseName": base,
        "pbxPath": str(target),
        "sha256": sha,
        "sizeBytes": len(wav_bytes),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "ConnectPbxRouteHelper/" + VERSION

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s %s\n" % (utc_now(), fmt % args))

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth_ok(self) -> bool:
        got = self.headers.get("x-connect-pbx-helper-secret", "")
        return bool(got) and hmac.compare_digest(got, CFG.secret)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        if length > MAX_REQUEST_BYTES:
            raise ValueError("request_body_too_large")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("body_must_be_object")
        return parsed

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "version": VERSION})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not self._auth_ok():
            self._send(401, {"error": "unauthorized"})
            return
        actions = {
            "/inspect": inspect_route,
            "/retarget": retarget_route,
            "/restore": restore_route,
            "/upload-prompt": upload_prompt,
        }
        fn = actions.get(path)
        if not fn:
            self._send(404, {"error": "not_found"})
            return
        try:
            body = self._read_json()
            result = fn(body)
            # Audit but never log raw audio bytes — drop bytesB64 from
            # the persisted payload.
            audit_body = {k: v for k, v in body.items() if k != "bytesB64"}
            if "bytesB64" in body:
                audit_body["bytesB64Len"] = len(body.get("bytesB64") or "")
            audit(path.strip("/"), True, audit_body, result=result)
            self._send(200, result)
        except LookupError as exc:
            body = locals().get("body", {})
            audit_body = {k: v for k, v in body.items() if k != "bytesB64"}
            audit(path.strip("/"), False, audit_body, error=str(exc))
            self._send(404, {"error": str(exc)})
        except ValueError as exc:
            body = locals().get("body", {})
            audit_body = {k: v for k, v in body.items() if k != "bytesB64"}
            audit(path.strip("/"), False, audit_body, error=str(exc))
            self._send(400, {"error": str(exc)})
        except Exception as exc:
            body = locals().get("body", {})
            audit_body = {k: v for k, v in body.items() if k != "bytesB64"}
            audit(path.strip("/"), False, audit_body, error=str(exc))
            self._send(409, {"error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate config and exit")
    args = parser.parse_args()
    CFG.validate()
    # Create DB at boot so permission problems fail before listening.
    with snapshot_conn():
        pass
    if args.check:
        print(json.dumps({"ok": True, "version": VERSION, "bind": CFG.bind, "port": CFG.port}))
        return
    httpd = ThreadingHTTPServer((CFG.bind, CFG.port), Handler)
    print(f"connect-pbx-route-helper listening on {CFG.bind}:{CFG.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
