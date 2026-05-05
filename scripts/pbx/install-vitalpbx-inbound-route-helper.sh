#!/usr/bin/env bash
set -euo pipefail

# Self-contained installer for the Connect VitalPBX inbound-route helper.
#
# Run on the PBX host as root:
#   bash install-vitalpbx-inbound-route-helper.sh
#
# Optional env overrides:
#   CONNECT_DESTINATION_ID=607
#   CONNECT_PBX_HELPER_BIND=127.0.0.1
#   CONNECT_PBX_HELPER_PORT=8757
#   MYSQL_ROOT_ARGS="-uroot -p"
#   TEST_DID=8455577768       # optional smoke test after install
#   TEST_TENANT_ID=21         # required only when TEST_DID is set

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root on the PBX host" >&2
  exit 1
fi

# Re-running the installer should not silently rotate credentials or reset
# network binding. Preserve existing env values unless explicitly overridden
# by the operator for this invocation.
REQUESTED_CONNECT_DESTINATION_ID="${CONNECT_DESTINATION_ID:-}"
REQUESTED_HELPER_BIND="${CONNECT_PBX_HELPER_BIND:-}"
REQUESTED_HELPER_PORT="${CONNECT_PBX_HELPER_PORT:-}"
REQUESTED_VM_RECORD_CHANNEL_TEMPLATE="${CONNECT_PBX_VM_RECORD_CHANNEL_TEMPLATE:-}"
REQUESTED_VM_RECORD_APP="${CONNECT_PBX_VM_RECORD_APP:-}"
if [[ -f /etc/connect-pbx-helper.env ]]; then
  set +u
  # shellcheck disable=SC1091
  source /etc/connect-pbx-helper.env || true
  set -u
fi

CONNECT_DESTINATION_ID="${REQUESTED_CONNECT_DESTINATION_ID:-${CONNECT_PBX_CONNECT_DESTINATION_ID:-607}}"
HELPER_BIND="${REQUESTED_HELPER_BIND:-${CONNECT_PBX_HELPER_BIND:-127.0.0.1}}"
HELPER_PORT="${REQUESTED_HELPER_PORT:-${CONNECT_PBX_HELPER_PORT:-8757}}"
VM_RECORD_CHANNEL_TEMPLATE="${REQUESTED_VM_RECORD_CHANNEL_TEMPLATE:-${CONNECT_PBX_VM_RECORD_CHANNEL_TEMPLATE:-Local/{extension}@T{tenantId}_cos-all}}"
VM_RECORD_APP="${REQUESTED_VM_RECORD_APP:-${CONNECT_PBX_VM_RECORD_APP:-VoiceMailMain}}"
if [[ -z "${REQUESTED_VM_RECORD_CHANNEL_TEMPLATE}" && "${VM_RECORD_CHANNEL_TEMPLATE}" == "PJSIP/{extension}" ]]; then
  # Upgrade the original direct-endpoint default to tenant dialplan routing.
  # Direct PJSIP can report success without ringing if the real endpoint is
  # tenant/device-prefixed or if multiple devices need to ring.
  VM_RECORD_CHANNEL_TEMPLATE='Local/{extension}@T{tenantId}_cos-all'
fi
MYSQL_ROOT_ARGS="${MYSQL_ROOT_ARGS:-}"
TEST_DID="${TEST_DID:-}"
TEST_TENANT_ID="${TEST_TENANT_ID:-}"

case "${CONNECT_DESTINATION_ID}" in
  ''|*[!0-9]*) echo "ERROR: CONNECT_DESTINATION_ID must be numeric" >&2; exit 1 ;;
esac

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing command: $1" >&2
    exit 1
  }
}

need_cmd mysql
need_cmd systemctl
need_cmd curl

if ! command -v python3 >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 python3-pip
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3 python3-pip
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y python3 python3-venv python3-pip
  else
    echo "ERROR: python3 not found and no supported package manager found" >&2
    exit 1
  fi
fi

install -d -m 0755 /opt/connect-pbx-helper
install -d -m 0750 /var/lib/connect-pbx-helper
useradd --system --home /var/lib/connect-pbx-helper --shell /usr/sbin/nologin connect-route-helper 2>/dev/null || true

# The helper writes IVR prompts directly into Asterisk's sounds dir AND
# (when configured) reloads dialplan via /run/asterisk/asterisk.ctl.
# Both require membership in the 'asterisk' group, which is owned by
# /var/lib/asterisk/sounds/custom (mode 0775 on stock VitalPBX) and by
# the AMI control socket. This is a no-op if the group already includes
# the helper user.
if getent group asterisk >/dev/null 2>&1; then
  if ! id -nG connect-route-helper 2>/dev/null | tr ' ' '\n' | grep -qx asterisk; then
    usermod -a -G asterisk connect-route-helper
    echo "Added connect-route-helper to the asterisk group"
  fi
else
  echo "WARN: 'asterisk' group not present — IVR prompt writes may fail until perms are widened" >&2
fi

# Make sure the destination dir exists; on a stock VitalPBX it always
# does, but a freshly imaged box may not have called any custom-recording
# tool yet. We create with group write so the helper can drop files.
install -d -o asterisk -g asterisk -m 0775 /var/lib/asterisk/sounds/custom 2>/dev/null || \
  install -d -m 0775 /var/lib/asterisk/sounds/custom
install -d -o asterisk -g asterisk -m 0775 /var/spool/asterisk/voicemail 2>/dev/null || \
  install -d -m 0775 /var/spool/asterisk/voicemail
if id asterisk >/dev/null 2>&1; then
  # Asterisk must be able to read/write its own voicemail spool. Some restored
  # mailboxes can contain root-owned greeting files; repair those at install
  # time because the runtime helper intentionally does not run as root.
  chown -R asterisk:asterisk /var/spool/asterisk/voicemail
  find /var/spool/asterisk/voicemail -type d -exec chmod 0750 {} +
  find /var/spool/asterisk/voicemail -type f -exec chmod 0644 {} +
fi

HELPER_SECRET="${CONNECT_PBX_HELPER_SECRET:-}"
if [[ -z "${HELPER_SECRET}" ]]; then
  HELPER_SECRET="$(openssl rand -hex 32 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
fi

MYSQL_PASS="${OMBU_MYSQL_PASSWORD:-}"
if [[ -z "${MYSQL_PASS}" ]]; then
  MYSQL_PASS="$(openssl rand -base64 32 2>/dev/null | tr -d '\n' || python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
fi

python3 -m venv /opt/connect-pbx-helper/.venv
/opt/connect-pbx-helper/.venv/bin/pip install --upgrade pip >/dev/null
/opt/connect-pbx-helper/.venv/bin/pip install pymysql >/dev/null

cat >/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py <<'PYHELPER'
#!/usr/bin/env python3
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
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pymysql

VERSION = "2026.05.03"
DID_RE = re.compile(r"^\+?\d{7,20}$")
NUM_RE = re.compile(r"^\d{1,10}$")
PROMPT_BASE_RE = re.compile(r"^[A-Za-z0-9_\-.]{1,120}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_WAV_BYTES = 12 * 1024 * 1024
GREETING_TYPES = {"unavailable": "unavail.wav", "busy": "busy.wav", "temporary": "temp.wav", "name": "greet.wav"}
RECORD_JOBS = {}

def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

def normalize_did(raw):
    value = str(raw or "").strip()
    digits = re.sub(r"\D", "", value)
    if not DID_RE.match(value) and not (7 <= len(digits) <= 20):
        raise ValueError("invalid_did")
    return digits, "+" + digits

def require_num(name, raw):
    value = str(raw or "").strip()
    if not NUM_RE.match(value):
        raise ValueError("invalid_" + name)
    return value

class Config:
    def __init__(self):
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
        self.connect_destination_id = os.environ.get("CONNECT_PBX_CONNECT_DESTINATION_ID", "").strip()
        self.apply_command = os.environ.get("CONNECT_PBX_HELPER_APPLY_COMMAND", "").strip()
        self.apply_timeout = int(os.environ.get("CONNECT_PBX_HELPER_APPLY_TIMEOUT_SEC", "30"))
        self.sounds_dir = Path(os.environ.get("CONNECT_PBX_HELPER_SOUNDS_DIR", "/var/lib/asterisk/sounds/custom"))
        self.sounds_owner_user = os.environ.get("CONNECT_PBX_HELPER_SOUNDS_OWNER_USER", "asterisk").strip()
        self.sounds_owner_group = os.environ.get("CONNECT_PBX_HELPER_SOUNDS_OWNER_GROUP", "asterisk").strip()
        self.sounds_file_mode = int(os.environ.get("CONNECT_PBX_HELPER_SOUNDS_FILE_MODE", "0o644"), 0)
        self.voicemail_dir = Path(os.environ.get("CONNECT_PBX_HELPER_VOICEMAIL_DIR", "/var/spool/asterisk/voicemail"))
        self.voicemail_owner_user = os.environ.get("CONNECT_PBX_HELPER_VOICEMAIL_OWNER_USER", "asterisk").strip()
        self.voicemail_owner_group = os.environ.get("CONNECT_PBX_HELPER_VOICEMAIL_OWNER_GROUP", "asterisk").strip()
        self.voicemail_file_mode = int(os.environ.get("CONNECT_PBX_HELPER_VOICEMAIL_FILE_MODE", "0o644"), 0)
        self.vm_record_channel_template = os.environ.get("CONNECT_PBX_VM_RECORD_CHANNEL_TEMPLATE", "PJSIP/{extension}").strip()
        self.vm_record_app = os.environ.get("CONNECT_PBX_VM_RECORD_APP", "VoiceMailMain").strip()
    def validate(self):
        if len(self.secret) < 32:
            raise SystemExit("CONNECT_PBX_HELPER_SECRET must be at least 32 chars")
        if not self.mysql_user:
            raise SystemExit("OMBU_MYSQL_USER is required")
        if self.connect_destination_id and not NUM_RE.match(self.connect_destination_id):
            raise SystemExit("CONNECT_PBX_CONNECT_DESTINATION_ID must be numeric")
        self.data_dir.mkdir(mode=0o750, parents=True, exist_ok=True)

CFG = Config()

def db_conn():
    kw = {
        "user": CFG.mysql_user,
        "password": CFG.mysql_password,
        "database": CFG.mysql_db,
        "cursorclass": pymysql.cursors.DictCursor,
        "autocommit": False,
        "charset": "utf8mb4",
    }
    if CFG.mysql_socket:
        kw["unix_socket"] = CFG.mysql_socket
    else:
        kw["host"] = CFG.mysql_host
        kw["port"] = CFG.mysql_port
    return pymysql.connect(**kw)

def snap_conn():
    conn = sqlite3.connect(str(CFG.snapshot_db))
    conn.execute("""
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
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snap_did ON inbound_route_snapshots(tenant_id, did_digits)")
    return conn

def audit(action, ok, payload, result=None, error=None):
    entry = {"ts": utc_now(), "version": VERSION, "action": action, "ok": ok, "payload": payload, "result": result, "error": error}
    with CFG.audit_file.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")

def find_route(conn, tenant_id, did_digits):
    with conn.cursor() as cur:
        cur.execute("""
        SELECT inbound_route_id, cos_id, description, routing_method, did,
               channel_id, cid_management_id, cid_lookup_id, cid_number,
               destination_id, language, music_group_id, alertinfo,
               enablerecording, digits_to_take, prepend, append, faxdetection,
               drop_anon_calls, detectiontime, fax_destination_id, privacyman,
               pmminlength, pmmaxretries, tenant_id
        FROM ombu_inbound_routes
        WHERE tenant_id = %s AND REPLACE(COALESCE(did, ''), '+', '') = %s
        """, (tenant_id, did_digits))
        rows = cur.fetchall()
    if len(rows) == 0:
        raise LookupError("did_not_found")
    if len(rows) > 1:
        raise RuntimeError("multiple_routes_matched")
    return rows[0]

def destination_exists(conn, destination_id):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM ombu_destinations WHERE id = %s", (destination_id,))
        return cur.fetchone() is not None

def apply_changes():
    if not CFG.apply_command:
        return {"ran": False, "reason": "apply_command_not_configured"}
    start = time.time()
    proc = subprocess.run(shlex.split(CFG.apply_command), text=True, capture_output=True, timeout=CFG.apply_timeout, check=False)
    return {"ran": True, "exitCode": proc.returncode, "elapsedMs": int((time.time() - start) * 1000), "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-4000:]}

def inspect_route(body):
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    with db_conn() as conn:
        route = find_route(conn, tenant_id, did_digits)
    snapshot = None
    with snap_conn() as sconn:
        row = sconn.execute("SELECT * FROM inbound_route_snapshots WHERE route_id = ?", (route["inbound_route_id"],)).fetchone()
        if row:
            cols = [d[0] for d in sconn.execute("SELECT * FROM inbound_route_snapshots LIMIT 0").description]
            snapshot = dict(zip(cols, row))
    mode = "connect" if str(route.get("destination_id")) == str((snapshot or {}).get("current_connect_destination_id")) else "pbx"
    return {"ok": True, "version": VERSION, "did": did_e164, "didDigits": did_digits, "tenantId": tenant_id, "route": route, "snapshot": snapshot, "mode": mode}

def retarget_route(body):
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    connect_dest = require_num("connect_destination_id", body.get("connectDestinationId") or CFG.connect_destination_id)
    force = bool(body.get("force", False))
    actor = str(body.get("actor") or "")[:128]
    request_id = str(body.get("requestId") or "")[:128]
    with db_conn() as conn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            current_dest = str(route["destination_id"])
            if current_dest == connect_dest:
                conn.rollback()
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route}
            if not destination_exists(conn, connect_dest):
                raise RuntimeError("connect_destination_not_found")
            with snap_conn() as sconn:
                existing = sconn.execute("SELECT original_destination_id FROM inbound_route_snapshots WHERE route_id = ?", (route_id,)).fetchone()
                if existing and not force:
                    original = str(existing[0])
                    if current_dest not in (original, connect_dest):
                        raise RuntimeError("route_drifted_since_capture")
                if not existing:
                    sconn.execute("""
                    INSERT INTO inbound_route_snapshots
                      (route_id, tenant_id, did_digits, did_e164, captured_at, captured_by,
                       request_id, original_row_json, original_destination_id, current_connect_destination_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (route_id, tenant_id, did_digits, did_e164, utc_now(), actor, request_id, json.dumps(route, sort_keys=True), current_dest, connect_dest))
                else:
                    sconn.execute("UPDATE inbound_route_snapshots SET current_connect_destination_id = ? WHERE route_id = ?", (connect_dest, route_id))
                sconn.commit()
            with conn.cursor() as cur:
                cur.execute("""
                UPDATE ombu_inbound_routes
                SET destination_id = %s
                WHERE inbound_route_id = %s AND tenant_id = %s AND destination_id = %s
                """, (connect_dest, route_id, tenant_id, current_dest))
                if cur.rowcount != 1:
                    raise RuntimeError("retarget_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    apply_result = apply_changes()
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {"ok": True, "did": did_e164, "tenantId": tenant_id, "routeId": route_id, "before": route, "after": after, "connectDestinationId": connect_dest, "apply": apply_result}

def restore_route(body):
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    force = bool(body.get("force", False))
    with db_conn() as conn, snap_conn() as sconn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            snap = sconn.execute("SELECT original_destination_id, current_connect_destination_id FROM inbound_route_snapshots WHERE route_id = ?", (route_id,)).fetchone()
            if not snap:
                raise LookupError("snapshot_not_found")
            original_dest = str(snap[0])
            connect_dest = str(snap[1] or "")
            current_dest = str(route["destination_id"])
            if current_dest == original_dest:
                conn.rollback()
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route}
            if not force and connect_dest and current_dest != connect_dest:
                raise RuntimeError("route_drifted_since_retarget")
            if not destination_exists(conn, original_dest):
                raise RuntimeError("original_destination_not_found")
            with conn.cursor() as cur:
                cur.execute("""
                UPDATE ombu_inbound_routes
                SET destination_id = %s
                WHERE inbound_route_id = %s AND tenant_id = %s AND destination_id = %s
                """, (original_dest, route_id, tenant_id, current_dest))
                if cur.rowcount != 1:
                    raise RuntimeError("restore_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    apply_result = apply_changes()
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {"ok": True, "did": did_e164, "tenantId": tenant_id, "routeId": route_id, "before": route, "after": after, "restoredDestinationId": original_dest, "apply": apply_result}

def upload_prompt(body):
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
    if not (wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE"):
        raise ValueError("not_a_riff_wav")
    if not CFG.sounds_dir.is_dir():
        raise RuntimeError("sounds_dir_missing: " + str(CFG.sounds_dir))
    target = CFG.sounds_dir / (base + ".wav")
    if target.is_file():
        try:
            with target.open("rb") as fh:
                existing_sha = hashlib.sha256(fh.read()).hexdigest()
            if hmac.compare_digest(existing_sha, sha):
                return {"ok": True, "unchanged": True, "fileBaseName": base, "pbxPath": str(target), "sha256": sha, "sizeBytes": len(wav_bytes)}
        except OSError:
            pass
    tmp_fd, tmp_path = tempfile.mkstemp(prefix="." + base + ".", suffix=".wav.tmp", dir=str(CFG.sounds_dir))
    try:
        with os.fdopen(tmp_fd, "wb") as fh:
            fh.write(wav_bytes)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.chmod(tmp_path, CFG.sounds_file_mode)
        except OSError:
            pass
        if CFG.sounds_owner_user:
            try:
                uid = pwd.getpwnam(CFG.sounds_owner_user).pw_uid
                gid = grp.getgrnam(CFG.sounds_owner_group).gr_gid if CFG.sounds_owner_group else -1
                os.chown(tmp_path, uid, gid)
            except (KeyError, PermissionError, OSError):
                pass
        os.replace(tmp_path, target)
    except Exception:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return {"ok": True, "fileBaseName": base, "pbxPath": str(target), "sha256": sha, "sizeBytes": len(wav_bytes)}

def require_ext(raw):
    value = str(raw or "").strip()
    if not re.match(r"^\d{2,10}$", value):
        raise ValueError("invalid_extension")
    return value

def require_greeting_type(raw):
    value = str(raw or "unavailable").strip().lower()
    if value not in GREETING_TYPES:
        raise ValueError("invalid_greetingType")
    return value

def apply_vm_owner(path_obj):
    try:
        os.chmod(str(path_obj), CFG.voicemail_file_mode)
    except OSError:
        pass
    if CFG.voicemail_owner_user:
        try:
            uid = pwd.getpwnam(CFG.voicemail_owner_user).pw_uid
            gid = grp.getgrnam(CFG.voicemail_owner_group).gr_gid if CFG.voicemail_owner_group else -1
            os.chown(str(path_obj), uid, gid)
        except (KeyError, PermissionError, OSError):
            pass

def backup_vm_greeting(target, remove_original=True):
    if not target.exists():
        return None
    apply_vm_owner(target)
    stamp = dt.datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    backup = target.with_name(target.name + ".bak-" + stamp)
    seq = 1
    while backup.exists():
        backup = target.with_name(target.name + ".bak-" + stamp + "-" + str(seq))
        seq += 1
    if remove_original:
        target.replace(backup)
    else:
        backup.write_bytes(target.read_bytes())
    apply_vm_owner(backup)
    return backup

def apply_vm_dir_owner(path_obj):
    try:
        os.chmod(str(path_obj), 0o750)
    except OSError:
        pass
    if CFG.voicemail_owner_user:
        try:
            uid = pwd.getpwnam(CFG.voicemail_owner_user).pw_uid
            gid = grp.getgrnam(CFG.voicemail_owner_group).gr_gid if CFG.voicemail_owner_group else -1
            os.chown(str(path_obj), uid, gid)
        except (KeyError, PermissionError, OSError):
            pass

def voicemail_mailbox_dir(tenant_id, extension):
    tenant = require_num("tenant_id", tenant_id)
    ext = require_ext(extension)
    root = CFG.voicemail_dir.resolve()
    candidates = [root / tenant / ext, root / ("T" + tenant) / ext, root / "default" / ext]
    for p in candidates:
        if p.is_dir():
            apply_vm_dir_owner(p)
            return p
    target = candidates[0]
    target.mkdir(mode=0o750, parents=True, exist_ok=True)
    apply_vm_dir_owner(target)
    return target

def safe_vm_path(tenant_id, extension, greeting_type):
    mbox = voicemail_mailbox_dir(tenant_id, extension).resolve()
    root = CFG.voicemail_dir.resolve()
    if root not in mbox.parents and mbox != root:
        raise ValueError("voicemail_path_outside_root")
    return mbox / GREETING_TYPES[require_greeting_type(greeting_type)]

def decode_verified_wav(body):
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
    if not (wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE"):
        raise ValueError("not_a_riff_wav")
    return wav_bytes, sha

def vm_greeting_status(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    extension = require_ext(body.get("extension"))
    greeting_type = require_greeting_type(body.get("greetingType"))
    target = safe_vm_path(tenant_id, extension, greeting_type)
    include_bytes = bool(body.get("includeBytes", False))
    if not target.is_file():
        return {"ok": True, "tenantId": tenant_id, "extension": extension, "greetingType": greeting_type, "active": False, "pbxPath": str(target), "sizeBytes": 0, "sha256": None, "updatedAt": None}
    apply_vm_owner(target)
    data = target.read_bytes()
    stat = target.stat()
    out = {"ok": True, "tenantId": tenant_id, "extension": extension, "greetingType": greeting_type, "active": True, "pbxPath": str(target), "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "updatedAt": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(timespec="seconds")}
    if include_bytes:
        out["bytesB64"] = base64.b64encode(data).decode("ascii")
    return out

def vm_greeting_upload(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    extension = require_ext(body.get("extension"))
    greeting_type = require_greeting_type(body.get("greetingType"))
    wav_bytes, sha = decode_verified_wav(body)
    target = safe_vm_path(tenant_id, extension, greeting_type)
    target.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    backup = backup_vm_greeting(target, remove_original=False)
    tmp_fd, tmp_path = tempfile.mkstemp(prefix="." + target.stem + ".", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(tmp_fd, "wb") as fh:
            fh.write(wav_bytes)
            fh.flush()
            os.fsync(fh.fileno())
        apply_vm_owner(Path(tmp_path))
        os.replace(tmp_path, target)
    except Exception:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return {"ok": True, "tenantId": tenant_id, "extension": extension, "greetingType": greeting_type, "pbxPath": str(target), "backupPath": str(backup) if backup else None, "sizeBytes": len(wav_bytes), "sha256": sha, "active": True, "updatedAt": utc_now()}

def vm_greeting_reset(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    extension = require_ext(body.get("extension"))
    greeting_type = require_greeting_type(body.get("greetingType"))
    target = safe_vm_path(tenant_id, extension, greeting_type)
    backup = backup_vm_greeting(target)
    return {"ok": True, "tenantId": tenant_id, "extension": extension, "greetingType": greeting_type, "active": False, "pbxPath": str(target), "backupPath": str(backup) if backup else None, "sizeBytes": 0, "sha256": None, "updatedAt": utc_now()}

def vm_record_call(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    extension = require_ext(body.get("extension"))
    greeting_type = require_greeting_type(body.get("greetingType"))
    job_id = str(uuid.uuid4())
    target = safe_vm_path(tenant_id, extension, greeting_type)
    backup = backup_vm_greeting(target, remove_original=False)
    # Use explicit token replacement instead of str.format so Asterisk context
    # suffixes like `T{tenantId}_cos-all` cannot be misparsed as a single
    # `{tenantId_cos-all}` field if an operator edits the env by hand.
    channel = (
        CFG.vm_record_channel_template
        .replace("{tenantId}", tenant_id)
        .replace("{extension}", extension)
    )
    if "{" in channel or "}" in channel:
        raise ValueError("invalid_vm_record_channel_template")
    mailbox = extension + "@" + tenant_id
    cmd = ["asterisk", "-rx", "channel originate %s application %s %s" % (channel, CFG.vm_record_app, mailbox)]
    job = {"ok": True, "jobId": job_id, "tenantId": tenant_id, "extension": extension, "greetingType": greeting_type, "targetPath": str(target), "backupPath": str(backup) if backup else None, "status": "ringing", "callId": job_id, "createdAt": utc_now()}
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=10, check=False)
        job["asteriskExitCode"] = proc.returncode
        job["asteriskOutput"] = (proc.stdout + proc.stderr)[-2000:]
        if proc.returncode != 0:
            job["status"] = "failed"
            job["error"] = job["asteriskOutput"] or "asterisk_originate_failed"
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
    RECORD_JOBS[job_id] = job
    return job

class Handler(BaseHTTPRequestHandler):
    server_version = "ConnectPbxRouteHelper/" + VERSION
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (utc_now(), fmt % args))
    def send_json(self, status, payload):
        data = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def auth_ok(self):
        got = self.headers.get("x-connect-pbx-helper-secret", "")
        return bool(got) and hmac.compare_digest(got, CFG.secret)
    def read_body(self):
        length = int(self.headers.get("content-length", "0") or "0")
        if length > MAX_REQUEST_BYTES:
            raise ValueError("request_body_too_large")
        raw = self.rfile.read(length)
        parsed = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(parsed, dict):
            raise ValueError("body_must_be_object")
        return parsed
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self.send_json(200, {"ok": True, "version": VERSION})
        elif path.startswith("/voicemail/greeting/record-call/"):
            if not self.auth_ok():
                self.send_json(401, {"error": "unauthorized"})
                return
            job_id = path.rsplit("/", 1)[-1]
            self.send_json(200, RECORD_JOBS.get(job_id) or {"ok": True, "jobId": job_id, "status": "failed", "error": "job_not_found"})
        else:
            self.send_json(404, {"error": "not_found"})
    def do_POST(self):
        path = urlparse(self.path).path
        if not self.auth_ok():
            self.send_json(401, {"error": "unauthorized"})
            return
        actions = {
            "/inspect": inspect_route,
            "/retarget": retarget_route,
            "/restore": restore_route,
            "/upload-prompt": upload_prompt,
            "/voicemail/greeting/upload": vm_greeting_upload,
            "/voicemail/greeting/get": vm_greeting_status,
            "/voicemail/greeting/reset": vm_greeting_reset,
            "/voicemail/greeting/record-call": vm_record_call,
        }
        fn = actions.get(path)
        if not fn:
            self.send_json(404, {"error": "not_found"})
            return
        try:
            body = self.read_body()
            result = fn(body)
            audit_body = {k: v for k, v in body.items() if k != "bytesB64"}
            if "bytesB64" in body:
                audit_body["bytesB64Len"] = len(body.get("bytesB64") or "")
            audit(path.strip("/"), True, audit_body, result=result)
            self.send_json(200, result)
        except LookupError as exc:
            body = locals().get("body", {})
            audit(path.strip("/"), False, {k: v for k, v in body.items() if k != "bytesB64"}, error=str(exc))
            self.send_json(404, {"error": str(exc)})
        except ValueError as exc:
            body = locals().get("body", {})
            audit(path.strip("/"), False, {k: v for k, v in body.items() if k != "bytesB64"}, error=str(exc))
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            body = locals().get("body", {})
            audit(path.strip("/"), False, {k: v for k, v in body.items() if k != "bytesB64"}, error=str(exc))
            self.send_json(409, {"error": str(exc)})

def main():
    CFG.validate()
    with snap_conn():
        pass
    if "--check" in sys.argv:
        print(json.dumps({"ok": True, "version": VERSION, "bind": CFG.bind, "port": CFG.port}))
        return
    httpd = ThreadingHTTPServer((CFG.bind, CFG.port), Handler)
    print("connect-pbx-route-helper listening on %s:%s" % (CFG.bind, CFG.port), flush=True)
    httpd.serve_forever()

if __name__ == "__main__":
    main()
PYHELPER

chmod 0755 /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py

cat >/etc/connect-pbx-helper.env <<EOF
CONNECT_PBX_HELPER_BIND=${HELPER_BIND}
CONNECT_PBX_HELPER_PORT=${HELPER_PORT}
CONNECT_PBX_HELPER_SECRET=${HELPER_SECRET}

OMBU_MYSQL_HOST=127.0.0.1
OMBU_MYSQL_PORT=3306
OMBU_MYSQL_DB=ombutel
OMBU_MYSQL_USER=connect_route_helper
OMBU_MYSQL_PASSWORD=${MYSQL_PASS}

CONNECT_PBX_CONNECT_DESTINATION_ID=${CONNECT_DESTINATION_ID}
CONNECT_PBX_HELPER_APPLY_COMMAND='asterisk -rx "dialplan reload"'
CONNECT_PBX_HELPER_DATA_DIR=/var/lib/connect-pbx-helper
CONNECT_PBX_HELPER_SOUNDS_DIR=/var/lib/asterisk/sounds/custom
CONNECT_PBX_HELPER_SOUNDS_OWNER_USER=asterisk
CONNECT_PBX_HELPER_SOUNDS_OWNER_GROUP=asterisk
CONNECT_PBX_HELPER_SOUNDS_FILE_MODE=0o644
CONNECT_PBX_HELPER_VOICEMAIL_DIR=/var/spool/asterisk/voicemail
CONNECT_PBX_HELPER_VOICEMAIL_OWNER_USER=asterisk
CONNECT_PBX_HELPER_VOICEMAIL_OWNER_GROUP=asterisk
CONNECT_PBX_HELPER_VOICEMAIL_FILE_MODE=0o644
CONNECT_PBX_VM_RECORD_CHANNEL_TEMPLATE='${VM_RECORD_CHANNEL_TEMPLATE}'
CONNECT_PBX_VM_RECORD_APP=${VM_RECORD_APP}
EOF

chmod 0600 /etc/connect-pbx-helper.env
chown root:root /etc/connect-pbx-helper.env

echo "Creating narrow MySQL user connect_route_helper..."
mysql ${MYSQL_ROOT_ARGS} <<SQL
CREATE USER IF NOT EXISTS 'connect_route_helper'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASS}';
ALTER USER 'connect_route_helper'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASS}';
GRANT SELECT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_destinations TO 'connect_route_helper'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

chown -R connect-route-helper:connect-route-helper /var/lib/connect-pbx-helper
if id asterisk >/dev/null 2>&1; then
  chown -R asterisk:asterisk /var/lib/connect-pbx-helper
fi

cat >/etc/systemd/system/connect-pbx-helper.service <<'EOF'
[Unit]
Description=Connect VitalPBX inbound route helper
After=network-online.target mariadb.service mysql.service

[Service]
Type=simple
EnvironmentFile=/etc/connect-pbx-helper.env
ExecStart=/opt/connect-pbx-helper/.venv/bin/python /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py
Restart=on-failure
RestartSec=3
User=asterisk
Group=asterisk
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/connect-pbx-helper /var/lib/asterisk/sounds/custom /var/spool/asterisk/voicemail /run/asterisk
SupplementaryGroups=asterisk

[Install]
WantedBy=multi-user.target
EOF

env \
  CONNECT_PBX_HELPER_BIND="${HELPER_BIND}" \
  CONNECT_PBX_HELPER_PORT="${HELPER_PORT}" \
  CONNECT_PBX_HELPER_SECRET="${HELPER_SECRET}" \
  OMBU_MYSQL_HOST=127.0.0.1 \
  OMBU_MYSQL_PORT=3306 \
  OMBU_MYSQL_DB=ombutel \
  OMBU_MYSQL_USER=connect_route_helper \
  OMBU_MYSQL_PASSWORD="${MYSQL_PASS}" \
  CONNECT_PBX_CONNECT_DESTINATION_ID="${CONNECT_DESTINATION_ID}" \
  CONNECT_PBX_HELPER_APPLY_COMMAND='asterisk -rx "dialplan reload"' \
  CONNECT_PBX_HELPER_DATA_DIR=/var/lib/connect-pbx-helper \
  CONNECT_PBX_HELPER_SOUNDS_DIR=/var/lib/asterisk/sounds/custom \
  CONNECT_PBX_HELPER_SOUNDS_OWNER_USER=asterisk \
  CONNECT_PBX_HELPER_SOUNDS_OWNER_GROUP=asterisk \
  CONNECT_PBX_HELPER_SOUNDS_FILE_MODE=0o644 \
  CONNECT_PBX_HELPER_VOICEMAIL_DIR=/var/spool/asterisk/voicemail \
  CONNECT_PBX_HELPER_VOICEMAIL_OWNER_USER=asterisk \
  CONNECT_PBX_HELPER_VOICEMAIL_OWNER_GROUP=asterisk \
  CONNECT_PBX_HELPER_VOICEMAIL_FILE_MODE=0o644 \
  CONNECT_PBX_VM_RECORD_CHANNEL_TEMPLATE="${VM_RECORD_CHANNEL_TEMPLATE}" \
  CONNECT_PBX_VM_RECORD_APP="${VM_RECORD_APP}" \
  /opt/connect-pbx-helper/.venv/bin/python /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py --check >/tmp/connect-pbx-helper-check.json

systemctl daemon-reload
systemctl enable connect-pbx-helper
systemctl restart connect-pbx-helper
sleep 1

echo
echo "Health:"
curl -sS "http://${HELPER_BIND}:${HELPER_PORT}/health" || true
echo
echo

if [[ -n "${TEST_DID}" ]]; then
  if [[ -z "${TEST_TENANT_ID}" ]]; then
    echo "TEST_DID was set but TEST_TENANT_ID is empty; skipping inspect smoke test."
  else
    echo "Inspect test DID ${TEST_DID} tenant ${TEST_TENANT_ID}:"
    curl -sS -X POST "http://${HELPER_BIND}:${HELPER_PORT}/inspect" \
      -H 'content-type: application/json' \
      -H "x-connect-pbx-helper-secret: ${HELPER_SECRET}" \
      -d "{\"did\":\"${TEST_DID}\",\"tenantId\":\"${TEST_TENANT_ID}\"}" || true
    echo
    echo
  fi
fi

echo "DONE."
echo "This helper is generic. Connect can call it for any DID + VitalPBX tenant_id,"
echo "and the selected Connect DID mapping decides which IVR profile answers."
echo
echo "Put these in Connect API env:"
echo "PBX_ROUTE_HELPER_BASE_URL=http://<PBX_PRIVATE_OR_LOCAL_REACHABLE_IP>:${HELPER_PORT}"
echo "PBX_ROUTE_HELPER_SECRET=${HELPER_SECRET}"
echo "PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID=${CONNECT_DESTINATION_ID}"
echo
echo "If Connect runs on the same PBX host, use:"
echo "PBX_ROUTE_HELPER_BASE_URL=http://${HELPER_BIND}:${HELPER_PORT}"
echo
echo "Helper now also accepts /upload-prompt for Connect-uploaded IVR audio."
echo "When an admin uploads a greeting in Connect's IVR section, the API"
echo "POSTs the normalised WAV to ${HELPER_BIND}:${HELPER_PORT}/upload-prompt and"
echo "this service writes it to /var/lib/asterisk/sounds/custom/<base>.wav."
echo
echo "Helper also accepts PBX voicemail greeting endpoints:"
echo "  POST /voicemail/greeting/upload"
echo "  POST /voicemail/greeting/get"
echo "  POST /voicemail/greeting/reset"
echo "  POST /voicemail/greeting/record-call"
echo "and writes custom greetings under /var/spool/asterisk/voicemail/<tenant>/<extension>/."
echo
echo "Verify with:"
echo "  curl -sS http://${HELPER_BIND}:${HELPER_PORT}/health"
echo "  ls -la /var/lib/asterisk/sounds/custom/   # connect-route-helper must be in 'asterisk' group"
echo
echo "Service status:"
systemctl status connect-pbx-helper --no-pager -l || true
