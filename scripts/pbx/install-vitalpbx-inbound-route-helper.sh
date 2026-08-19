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
#   CONNECT_PBX_HELPER_VM_SPOOL_LIST_DEFAULT_LIMIT=2000   # per-request page default
#   CONNECT_PBX_HELPER_VM_SPOOL_LIST_MAX_LIMIT=20000       # hard cap for ?limit in JSON body
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
# Default expansion is intentionally split off into its own variable. Inlining
# 'Local/{recordingExten}@connect-vm-greeting-dispatch/n' into a `${X:-default}`
# substitution causes bash to match the FIRST `}` (after `recordingExten}`) as
# the closing brace of the substitution, producing a corrupted value that grows
# every install. Always assign the default to a normal variable first.
DEFAULT_VM_RECORD_CHANNEL_TEMPLATE='Local/{recordingExten}@connect-vm-greeting-dispatch/n'
VM_RECORD_CHANNEL_TEMPLATE="${REQUESTED_VM_RECORD_CHANNEL_TEMPLATE:-${CONNECT_PBX_VM_RECORD_CHANNEL_TEMPLATE:-${DEFAULT_VM_RECORD_CHANNEL_TEMPLATE}}}"
VM_RECORD_APP="${REQUESTED_VM_RECORD_APP:-${CONNECT_PBX_VM_RECORD_APP:-Goto}}"
if [[ -z "${REQUESTED_VM_RECORD_APP}" && "${VM_RECORD_APP}" == "VoiceMailMain" ]]; then
  # Older helper installs used VoiceMailMain after answer. On VitalPBX this can
  # ring the user but leave them with no guided recording audio, so upgrade the
  # default to Connect's explicit recording dialplan unless the operator
  # deliberately supplied CONNECT_PBX_VM_RECORD_APP for this run.
  VM_RECORD_APP="Goto"
fi
if [[ -z "${REQUESTED_VM_RECORD_CHANNEL_TEMPLATE}" ]]; then
  case "${VM_RECORD_CHANNEL_TEMPLATE}" in
    "PJSIP/{extension}"|"Local/{extension}@T{tenantId}_cos-all"|"PJSIP/T{tenantId}_{extension}")
      # Upgrade older defaults to the dispatch-context Local channel which rings
      # all registered devices for the user's extension at once and avoids
      # accidental fall-through into the normal tenant dialplan/voicemail.
      VM_RECORD_CHANNEL_TEMPLATE="${DEFAULT_VM_RECORD_CHANNEL_TEMPLATE}"
      ;;
  esac
  # Heal previously-corrupted values written by a prior installer that suffered
  # from the brace-parsing quirk above.
  if [[ "${VM_RECORD_CHANNEL_TEMPLATE}" == *"@T{tenantId_cos-all}"* \
     || "${VM_RECORD_CHANNEL_TEMPLATE}" == *"}}"* \
     || "${VM_RECORD_CHANNEL_TEMPLATE}" != *"{recordingExten}"*"connect-vm-greeting-dispatch"* ]]; then
    VM_RECORD_CHANNEL_TEMPLATE="${DEFAULT_VM_RECORD_CHANNEL_TEMPLATE}"
  fi
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
# X4 (2026-07-23): queue-conf backups live under the data dir — the unit runs
# ProtectSystem=strict, so /opt is READ-ONLY to the service at runtime.
install -d -o asterisk -g asterisk -m 0750 /var/lib/connect-pbx-helper/backups 2>/dev/null || \
  install -d -m 0750 /var/lib/connect-pbx-helper/backups
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
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import ssl
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pymysql

VERSION = "2026.08.19.4"
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
        # transport-wss cert self-heal (certfix, 2026-07): the DEFAULT [transport-wss]
        # object in the base pjsip.conf is hand-maintained (not VitalPBX-generated) and
        # references a static self-signed cert under /etc/asterisk/keys/. If that
        # directory is ever lost (e.g. during unrelated cert/cleanup work), every
        # `pjsip reload` fails to create the transport-wss object, which silently
        # blocks any NEW outbound registration object from starting (existing
        # registrations that already loaded keep refreshing). This action repoints
        # cert_file/priv_key_file to the Let's-Encrypt-renewed bundle VitalPBX's own
        # certificate manager already keeps current, instead of a static astgenkey cert.
        self.transport_wss_conf_path = os.environ.get("CONNECT_PBX_TRANSPORT_WSS_CONF_PATH", "/etc/asterisk/pjsip.conf").strip()
        self.transport_wss_section = os.environ.get("CONNECT_PBX_TRANSPORT_WSS_SECTION", "transport-wss").strip()
        self.transport_wss_desired_cert_file = os.environ.get(
            "CONNECT_PBX_TRANSPORT_WSS_DESIRED_CERT_FILE",
            "/usr/share/vitalpbx/certificates/m.connectcomunications.com/bundle.pem",
        ).strip()
        self.transport_wss_desired_key_file = os.environ.get(
            "CONNECT_PBX_TRANSPORT_WSS_DESIRED_KEY_FILE",
            "/usr/share/vitalpbx/certificates/m.connectcomunications.com/private.pem",
        ).strip()
        self.transport_wss_reload_command = os.environ.get(
            "CONNECT_PBX_TRANSPORT_WSS_RELOAD_COMMAND", 'asterisk -rx "module reload res_pjsip.so"'
        ).strip()
        # M3/M4/M10 native config writes (2026-07-28): VitalPBX BAKES inbound-route
        # destinations, IVR menu options and queue members into the generated conf
        # (verified live: exten => _<DID> ... Goto(T21_cos-all,101,1)), so a DB
        # write alone never becomes live. The ONLY sanctioned regen is VitalPBX's
        # own per-tenant apply: PUT /api/v2/tenants/<id>/apply_changes — same code
        # path as the GUI "Apply Changes" button. Key comes from the Connect app
        # key already provisioned for the VitalPBX REST API.
        self.vitalpbx_api_url = os.environ.get("CONNECT_PBX_VITALPBX_API_URL", "https://127.0.0.1").strip()
        self.vitalpbx_api_key = os.environ.get("CONNECT_PBX_VITALPBX_API_KEY", "").strip()
        self.apply_changes_timeout = int(os.environ.get("CONNECT_PBX_APPLY_CHANGES_TIMEOUT_SEC", "180"))
        self.static_dir = Path(os.environ.get("CONNECT_PBX_STATIC_DIR", "/var/lib/vitalpbx/static"))
        # Overload guard (2026-08-12): ThreadingHTTPServer spawns one thread per
        # connection with NO cap. Under loopcom's voicemail-spool polling (~126
        # req/min against mailboxes with 9k+ messages) threads piled up past 700,
        # the GIL convoy pushed every response over the api's 15s abort, aborted
        # clients left CLOSE-WAIT sockets held by still-grinding threads, and the
        # process wedged at the 1024-fd soft limit (every open() -> Errno 24).
        # max_inflight bounds concurrent request threads; excess connections get
        # an immediate 503 instead of a thread. socket_timeout bounds how long a
        # dead/silent peer can hold a thread on a blocking read/write.
        self.max_inflight = int(os.environ.get("CONNECT_PBX_HELPER_MAX_INFLIGHT", "32"))
        self.socket_timeout = int(os.environ.get("CONNECT_PBX_HELPER_SOCKET_TIMEOUT_SEC", "30"))
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
    # M3 (agent route change) ??? ISOLATED snapshot table. Deliberately has NO
    # current_connect_destination_id column: the agent endpoint must NEVER touch
    # the connect/pbx mode signal (that field, in inbound_route_snapshots, is what
    # /inspect uses to decide "connect mode"). Keeping agent snapshots separate
    # means an agent route change can never make a native route look Connect-managed.
    conn.execute("""
    CREATE TABLE IF NOT EXISTS agent_route_snapshots (
      route_id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      did_digits TEXT NOT NULL,
      did_e164 TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      captured_by TEXT,
      request_id TEXT,
      original_row_json TEXT NOT NULL,
      original_destination_id TEXT NOT NULL,
      last_set_destination_id TEXT
    )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_snap_did ON agent_route_snapshots(tenant_id, did_digits)")
    # Migration for pre-2026-07-28 databases: the drift guard needs to know the
    # destination WE last wrote, or a second agent retarget of the same DID is
    # falsely rejected as route_drifted_since_capture (live bug 2026-07-28).
    try:
        conn.execute("ALTER TABLE agent_route_snapshots ADD COLUMN last_set_destination_id TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists
    conn.execute("""
    CREATE TABLE IF NOT EXISTS transport_cert_snapshots (
      conf_path TEXT PRIMARY KEY,
      section TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      captured_by TEXT,
      request_id TEXT,
      original_file_text TEXT NOT NULL,
      original_cert_file TEXT,
      original_priv_key_file TEXT
    )
    """)
    return conn

def audit(action, ok, payload, result=None, error=None):
    entry = {"ts": utc_now(), "version": VERSION, "action": action, "ok": ok, "payload": payload, "result": result, "error": error}
    # Best-effort: audit runs BETWEEN the action and the response, so an OSError
    # here (fd exhaustion, full disk) would report a COMPLETED action as failed
    # to the client — which then retries a write that already happened.
    try:
        with CFG.audit_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")
    except OSError as exc:
        sys.stderr.write("audit_write_failed: %s\n" % exc)

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

def music_group_exists(conn, music_group_id):
    with conn.cursor() as cur:
        cur.execute("SELECT music_group_id FROM ombu_music_groups WHERE music_group_id = %s", (music_group_id,))
        return cur.fetchone() is not None

# ────────────────────────── Connect doorway (2026-08-05) ─────────────────────
# The single PBX object that hands an inbound route to Connect's tenant IVR.
#
# History: the original doorway was a per-tenant Custom Application (T21 ext
# 8001, ombu_destinations id 607) created by hand in April 2026. A panel
# cleanup deleted it — the FK cascade took the destination row with it — and
# from that moment every switch-to-connect on the platform failed with
# connect_destination_not_found (nobody noticed until 2026-08-05, because
# nobody had flipped a number since).
#
# The replacement is designed so that class of failure cannot recur:
#   • The doorway is a GLOBAL Custom Context (context "connect-doorway") —
#     tenant-agnostic; the dialplan resolves the owning tenant from the
#     connect/didmap AstDB family that Connect publishes BEFORE every switch.
#   • It is DISCOVERED BY NAME, never by a pinned id: retarget looks the
#     destination up by context name at flip time, so a recreated row with a
#     new id is found automatically. Explicit/env ids are honoured only if
#     they still exist; a stale id silently falls through to discovery
#     instead of failing the switch.
#   • It is SELF-HEALING: if the DB rows or the dialplan file are missing at
#     flip time, the helper recreates them (rows in the same transaction as
#     the flip, dialplan file + reload just before) — a panel deletion costs
#     one automatic rebuild, not an outage.
#   • /doorway-status reports all of it read-only for monitoring.

CONNECT_DOORWAY_CONTEXT = "connect-doorway"
CONNECT_DOORWAY_DESCRIPTION = "Connect IVR doorway - managed by connect-pbx-helper, auto-recreated if deleted"
CONNECT_DOORWAY_DIALPLAN_PATH = "/etc/asterisk/vitalpbx/extensions__96-connect-doorway.conf"
# Double-underscore prefix REQUIRED: it is what VitalPBX's
# `#include vitalpbx/extensions__*.conf` glob matches (same as extensions__95).
CONNECT_DOORWAY_DIALPLAN_BODY = """\
; ============================================================================
; Connect doorway — the single entry point that hands a VitalPBX inbound route
; to Connect's tenant IVR ([connect-tenant-ivr] in extensions__60_custom.conf).
;
; MANAGED BY connect-pbx-helper (ensure_connect_doorway): if this file is
; deleted, or the [connect-doorway] context vanishes from the running
; dialplan, the helper rewrites this file and reloads before the next number
; switch. Hand-edits are overwritten on the next self-heal — change the
; embedded copy in vitalpbx-inbound-route-helper.py instead.
; ============================================================================

[connect-doorway]
; VitalPBX renders a Custom Context destination as Goto(connect-doorway,s,1),
; so the dialled number is no longer in ${EXTEN} — recover it from DNID (the
; same variable the April-era custom-app doorway used, proven on T21), resolve
; the owning tenant from the didmap Connect published before the switch, then
; enter the tenant IVR with the DID as the extension.
exten => s,1,NoOp(Connect doorway - dnid=${CALLERID(dnid)} slug=${TENANT_SLUG})
 same => n,Set(CONNECT_DOORWAY_DID=${FILTER(0-9,${CALLERID(dnid)})})
 same => n,GotoIf($["${CONNECT_DOORWAY_DID}" = ""]?nodid)
 same => n,Set(DOORWAY_DID_TENANT=${DB(connect/didmap/${CONNECT_DOORWAY_DID}/tenant)})
 same => n,ExecIf($["${DOORWAY_DID_TENANT}" != ""]?Set(__TENANT_SLUG=${DOORWAY_DID_TENANT}))
 same => n,GotoIf($["${DOORWAY_DID_TENANT}" != "" & "${DB(connect/t_${DOORWAY_DID_TENANT}/interrupted)}" = "yes"]?interrupted)
 same => n,Goto(connect-tenant-ivr,${CONNECT_DOORWAY_DID},1)
 same => n(nodid),NoOp(Connect doorway: no DNID on channel - fallback)
 same => n,Goto(connect-default-fallback,s,1)
; Overdue-account service interruption: Connect sets connect/t_<slug>/interrupted=yes
; when a customer is cut off for non-payment. Callers hear BUSY - never the IVR and
; never dead air (dead air is indistinguishable from an outage). AstDB is read at
; call time, so switching a tenant back on needs no regen and no reload.
 same => n(interrupted),NoOp(Connect doorway: ${DOORWAY_DID_TENANT} interrupted for non-payment - busy)
 same => n,Busy(10)
 same => n,Hangup()

; Direct-DID entry: works if a future render (or a hand-built Goto) passes the
; dialled number through as the extension instead of "s".
exten => _[+0-9].,1,NoOp(Connect doorway direct - did=${EXTEN})
 same => n,Set(CONNECT_DOORWAY_DID=${FILTER(0-9,${EXTEN})})
 same => n,Set(DOORWAY_DID_TENANT=${DB(connect/didmap/${CONNECT_DOORWAY_DID}/tenant)})
 same => n,ExecIf($["${DOORWAY_DID_TENANT}" != ""]?Set(__TENANT_SLUG=${DOORWAY_DID_TENANT}))
 same => n,GotoIf($["${DOORWAY_DID_TENANT}" != "" & "${DB(connect/t_${DOORWAY_DID_TENANT}/interrupted)}" = "yes"]?interrupted)
 same => n,Goto(connect-tenant-ivr,${CONNECT_DOORWAY_DID},1)
 same => n(interrupted),NoOp(Connect doorway direct: ${DOORWAY_DID_TENANT} interrupted for non-payment - busy)
 same => n,Busy(10)
 same => n,Hangup()

exten => i,1,Goto(connect-default-fallback,s,1)
exten => t,1,Goto(connect-default-fallback,s,1)
"""

def _doorway_context_live():
    """READ-ONLY: is [connect-doorway] present in the running dialplan?"""
    try:
        proc = subprocess.run(
            ["asterisk", "-rx", "dialplan show " + CONNECT_DOORWAY_CONTEXT],
            capture_output=True, text=True, timeout=15, check=False,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return ("'" + CONNECT_DOORWAY_CONTEXT + "'" in out) and ("no existence" not in out.lower())
    except (OSError, subprocess.SubprocessError):
        return False

def ensure_connect_doorway_dialplan(strict=False):
    """Idempotent: doorway dialplan file present with the embedded content and
    the context live in Asterisk. Reloads only when something actually changed.
    strict=True (the retarget path) raises instead of soft-logging, because a
    flip must never proceed toward a doorway the dialplan cannot answer."""
    evidence = {"filePath": CONNECT_DOORWAY_DIALPLAN_PATH, "fileRewritten": False, "reloaded": False}
    try:
        target = Path(CONNECT_DOORWAY_DIALPLAN_PATH)
        target.parent.mkdir(parents=True, exist_ok=True)
        existing = target.read_text() if target.is_file() else ""
        changed = existing != CONNECT_DOORWAY_DIALPLAN_BODY
        if changed:
            # Atomic write: never leave a half-written dialplan for Asterisk to read.
            tmp = target.with_name(target.name + ".tmp")
            tmp.write_text(CONNECT_DOORWAY_DIALPLAN_BODY)
            os.replace(str(tmp), str(target))
            evidence["fileRewritten"] = True
        _apply_dialplan_owner(target)
        live = _doorway_context_live()
        if changed or not live:
            subprocess.run(["asterisk", "-rx", "dialplan reload"], capture_output=True, timeout=15, check=False)
            evidence["reloaded"] = True
            live = _doorway_context_live()
        evidence["contextLive"] = live
        if strict and not live:
            raise RuntimeError("doorway_dialplan_install_failed")
        return evidence
    except (OSError, PermissionError) as exc:
        evidence["error"] = str(exc)
        if strict:
            raise RuntimeError("doorway_dialplan_install_failed: " + str(exc))
        sys.stderr.write("ensure_connect_doorway_dialplan_failed: " + str(exc) + "\n")
        return evidence

def _find_doorway_rows(conn, include_invalid=False):
    """Custom-context rows named connect-doorway joined to their (FK-live)
    destination rows, oldest first, each carrying a `valid` verdict.

    ⛔ 2026-08-06, THE HIJACK: a destination row's EXISTENCE means nothing.
    VitalPBX's panel rewrote our doorway destination (903) IN PLACE — it became
    category=ivr index=1 ("Home Main" on tenant 2) when someone saved that
    tenant's inbound route in the GUI. The custom-context row still pointed at
    903, so every id-equality check (route.destination_id == snapshot's
    connect id, doorway_status "row exists") kept reporting CONNECTED while
    both live numbers pointing at 903 rendered to a PBX IVR. `valid` is the
    semantic check that catches it: the destination must still sit in the
    custom_contexts category AND its index must still be the cc_id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cc.cc_id, cc.destination_id, d.id AS dest_id, d.`index` AS dest_index,
                   m.name AS dest_category_module
            FROM ombu_custom_contexts cc
            JOIN ombu_destinations d ON d.id = cc.destination_id
            LEFT JOIN ombu_destinations_category c ON c.id = d.category_id
            LEFT JOIN ombu_modules m ON m.module_id = c.module_id
            WHERE cc.context = %s
            ORDER BY cc.cc_id ASC
            """,
            (CONNECT_DOORWAY_CONTEXT,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    out = []
    for r in rows:
        r["valid"] = (
            str(r.get("dest_category_module") or "") == "custom_contexts"
            and str(r.get("dest_index") or "") == str(r.get("cc_id"))
        )
        if r["valid"] or include_invalid:
            out.append(r)
    return out


def _doorway_goto(conn):
    """The Goto triple that enters the doorway.

    ⛔ Deliberately NOT derived from a destination row. The row is mutable by
    the panel (see _find_doorway_rows); the CONTEXT is ours and constant. Read
    extension/priority from the cc row when it looks sane, else fall back to
    the values this helper always writes."""
    exten, prio = "s", "1"
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT extension, priority FROM ombu_custom_contexts WHERE context = %s ORDER BY cc_id ASC LIMIT 1",
                (CONNECT_DOORWAY_CONTEXT,),
            )
            row = cur.fetchone()
        if row:
            e = str(row.get("extension") or "").strip()
            p = str(row.get("priority") or "").strip()
            if re.match(r"^[A-Za-z0-9_\-]{1,64}$", e):
                exten = e
            if re.match(r"^[A-Za-z0-9_\-]{1,16}$", p):
                prio = p
    except Exception:
        pass
    return "%s,%s,%s" % (CONNECT_DOORWAY_CONTEXT, exten, prio)


def _route_is_connect_mode(route_id, current_dest):
    """Did CONNECT put this route where it is? Read from our own snapshot db,
    never from the PBX's destination semantics."""
    try:
        with snap_conn() as sconn:
            row = sconn.execute(
                "SELECT current_connect_destination_id FROM inbound_route_snapshots WHERE route_id = ?",
                (int(route_id),),
            ).fetchone()
        return bool(row) and str(row[0] or "") == str(current_dest)
    except Exception:
        return False

def ensure_connect_doorway_rows(conn, evidence):
    """Return the ombu_destinations id routes should point at, creating the
    Custom Context + destination pair when missing. Runs inside the caller's
    transaction so a failed flip never leaves half a doorway behind."""
    all_rows = _find_doorway_rows(conn, include_invalid=True)
    valid = [r for r in all_rows if r["valid"]]
    if valid:
        evidence["doorwayCreated"] = False
        evidence["doorwayDestinationId"] = int(valid[0]["dest_id"])
        return str(valid[0]["dest_id"])
    # ⛔ HIJACK REPAIR (2026-08-06): when no VALID pair survives we build a
    # brand-new one rather than repointing the old custom-context row —
    # deliberately, on two grounds. The helper's DB user has INSERT but not
    # UPDATE on ombu_custom_contexts (least privilege, and asking for more
    # grants is a human round-trip mid-outage), and a fresh pair is the same
    # code path a first-time install takes, so there is one creation path to
    # reason about instead of two. The hijacked row is left in place as inert
    # clutter: `valid` already makes it invisible to every routing decision.
    if all_rows:
        evidence["doorwayHijackedRowsIgnored"] = [
            {"ccId": int(r["cc_id"]), "destinationId": int(r["dest_id"]),
             "nowLooksLike": r.get("dest_category_module"), "nowIndex": r.get("dest_index")}
            for r in all_rows
        ]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT c.id FROM ombu_destinations_category c JOIN ombu_modules m ON m.module_id = c.module_id WHERE m.name = 'custom_contexts'"
        )
        cat = cur.fetchone()
        if not cat:
            raise RuntimeError("custom_contexts_module_missing")
        # ombu_destinations.module_id names the module that POINTS AT the
        # destination (ivr=31, inbound_route=29, ...), not the category's own
        # module. Doorway destinations are targeted by inbound routes.
        cur.execute("SELECT module_id FROM ombu_modules WHERE name = 'inbound_route'")
        mod = cur.fetchone()
        if not mod:
            raise RuntimeError("inbound_route_module_missing")
        # The pair is circular (cc.destination_id NOT NULL ⇄ d.index = cc_id):
        # placeholder index first, then backfill once the cc_id exists.
        cur.execute(
            "INSERT INTO ombu_destinations (category_id, module_id, `index`) VALUES (%s, %s, %s)",
            (int(cat["id"]), int(mod["module_id"]), "0"),
        )
        dest_id = int(cur.lastrowid)
        cur.execute("SELECT tenant_id FROM ombu_tenants WHERE name = 'vitalpbx'")
        main_tenant = cur.fetchone()
        cur.execute(
            "INSERT INTO ombu_custom_contexts (description, context, extension, priority, destination_id, tenant_id) VALUES (%s, %s, %s, %s, %s, %s)",
            (
                CONNECT_DOORWAY_DESCRIPTION,
                CONNECT_DOORWAY_CONTEXT,
                "s",
                "1",
                dest_id,
                int(main_tenant["tenant_id"]) if main_tenant else None,
            ),
        )
        cc_id = int(cur.lastrowid)
        cur.execute("UPDATE ombu_destinations SET `index` = %s WHERE id = %s", (str(cc_id), dest_id))
    evidence["doorwayCreated"] = True
    evidence["doorwayDestinationId"] = dest_id
    evidence["doorwayCustomContextId"] = cc_id
    return str(dest_id)

def resolve_connect_destination(conn, requested, evidence):
    """The destination id a flip should use. Explicit request first, then the
    env pin — each honoured ONLY if the row still exists — then the doorway
    discovered by name (created if missing). A stale pinned id is recorded and
    skipped, never fatal: that staleness is exactly what broke every switch
    between April and August 2026."""
    # A requested/pinned id must be a REAL doorway destination, not merely an
    # existing row: destination 903 existed the whole time it meant "tenant 2's
    # Home Main IVR" (the 2026-08-06 hijack). Existence checks are what let a
    # repurposed row keep passing for the doorway.
    valid_ids = {str(r["dest_id"]) for r in _find_doorway_rows(conn)}
    for source, raw in (("request", requested), ("config", CFG.connect_destination_id)):
        value = str(raw or "").strip()
        if not value:
            continue
        if NUM_RE.match(value) and value in valid_ids:
            evidence["connectDestinationSource"] = source
            return value
        evidence.setdefault("staleDestinationIdsIgnored", []).append({"source": source, "id": value})
    dest = ensure_connect_doorway_rows(conn, evidence)
    evidence["connectDestinationSource"] = "doorway"
    return dest

def doorway_status(body):
    """READ-ONLY doorway health: dialplan file, running context, DB rows, and
    what id a flip would use right now. Never creates anything."""
    target = Path(CONNECT_DOORWAY_DIALPLAN_PATH)
    file_present = target.is_file()
    file_current = False
    if file_present:
        try:
            file_current = target.read_text() == CONNECT_DOORWAY_DIALPLAN_BODY
        except OSError:
            pass
    with db_conn() as conn:
        all_rows = _find_doorway_rows(conn, include_invalid=True)
        rows = [r for r in all_rows if r["valid"]]
        hijacked = [r for r in all_rows if not r["valid"]]
        env_id = str(CFG.connect_destination_id or "").strip()
        env_id_valid = bool(env_id) and env_id in {str(r["dest_id"]) for r in rows}
        # Routes Connect owns whose RENDER no longer enters the doorway — the
        # only question that matters to a caller. Cheap enough for a monitor:
        # one snapshot read + one file read per Connect-managed route.
        drifted = []
        try:
            with snap_conn() as sconn:
                snaps = sconn.execute(
                    "SELECT route_id, tenant_id, did_digits, did_e164, current_connect_destination_id FROM inbound_route_snapshots"
                ).fetchall()
            for route_id, tenant_id, did_digits, did_e164, connect_dest in snaps:
                try:
                    route = find_route(conn, tenant_id, did_digits)
                except Exception:
                    continue
                if str(route.get("destination_id")) != str(connect_dest or ""):
                    continue  # handed back to the PBX on purpose
                rendered = read_rendered_route_gotos(tenant_id, did_digits)
                if not any(str(g).startswith(CONNECT_DOORWAY_CONTEXT + ",") for g in rendered.get("gotos") or []):
                    drifted.append({
                        "routeId": int(route_id), "tenantId": str(tenant_id), "did": str(did_e164),
                        "rendered": rendered.get("gotos") or [],
                    })
        except Exception as exc:
            drifted = [{"error": "render_scan_failed: %s" % exc}]
    return {
        "ok": True,
        "version": VERSION,
        "context": CONNECT_DOORWAY_CONTEXT,
        "dialplanFilePath": CONNECT_DOORWAY_DIALPLAN_PATH,
        "dialplanFilePresent": file_present,
        "dialplanFileCurrent": file_current,
        "contextLive": _doorway_context_live(),
        "rows": [{"customContextId": int(r["cc_id"]), "destinationId": int(r["dest_id"])} for r in rows],
        # A destination row the panel repurposed out from under us. Its mere
        # existence used to read as "doorway fine" — never again.
        "hijackedRows": [
            {"customContextId": int(r["cc_id"]), "destinationId": int(r["dest_id"]),
             "nowLooksLike": r.get("dest_category_module"), "nowIndex": r.get("dest_index")}
            for r in hijacked
        ],
        "renderDriftedRoutes": drifted,
        "envPinnedId": env_id or None,
        "envPinnedIdExists": env_id_valid,
        "wouldUse": (env_id if env_id_valid else (str(rows[0]["dest_id"]) if rows else None)),
        # healthy means CALLER-VISIBLE health: the context answers, a VALID
        # doorway destination exists, and every Connect-owned route still
        # RENDERS into the doorway.
        #
        # ⛔ hijackedRows deliberately does NOT count against health. Once
        # repair mints a fresh pair, the repurposed old row is inert clutter
        # that no routing decision can see — but it never goes away (the helper
        # has no UPDATE/DELETE on that table). Gating health on it would email
        # an unfixable alert forever, and an alert nobody can clear is an alert
        # everybody learns to ignore. It stays reported for diagnosis; only
        # renderDriftedRoutes (what callers actually get) gates health.
        "healthy": (
            _doorway_context_live()
            and bool(rows)
            and not drifted
        ),
    }


def doorway_repair(body):
    """Repair the doorway end-to-end: valid destination row, cc row pointing at
    it, every Connect-owned route pointing at it, and every render entering it.

    Idempotent and safe on a timer. Only touches routes whose own snapshot says
    CONNECT put them where they are — a number a human handed back to the PBX
    is left alone. Never invents Connect-mode for a route."""
    evidence = {"dialplan": ensure_connect_doorway_dialplan(strict=False)}
    with db_conn() as conn:
        try:
            conn.begin()
            good_dest = ensure_connect_doorway_rows(conn, evidence)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        goto = _doorway_goto(conn)
    repaired = []
    with snap_conn() as sconn:
        snaps = sconn.execute(
            "SELECT route_id, tenant_id, did_digits, did_e164, current_connect_destination_id FROM inbound_route_snapshots"
        ).fetchall()
    for route_id, tenant_id, did_digits, did_e164, connect_dest in snaps:
        item = {"routeId": int(route_id), "did": str(did_e164), "tenantId": str(tenant_id),
                "destRepointed": False, "rebaked": 0, "error": None}
        try:
            with db_conn() as conn:
                route = find_route(conn, tenant_id, did_digits)
                current = str(route.get("destination_id"))
                if current != str(connect_dest or ""):
                    continue  # deliberately on the PBX — not ours to touch
                if current != str(good_dest):
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE ombu_inbound_routes SET destination_id = %s WHERE inbound_route_id = %s AND tenant_id = %s AND destination_id = %s",
                            (good_dest, int(route_id), tenant_id, current),
                        )
                        if cur.rowcount != 1:
                            raise RuntimeError("route_repoint_guard_failed")
                    conn.commit()
                    with snap_conn() as sconn:
                        sconn.execute(
                            "UPDATE inbound_route_snapshots SET current_connect_destination_id = ? WHERE route_id = ?",
                            (str(good_dest), int(route_id)),
                        )
                        sconn.commit()
                    item["destRepointed"] = True
            bake = _bake_goto(tenant_id, did_digits, goto)
            if bake.get("error"):
                raise RuntimeError("route_bake_failed:%s" % bake["error"])
            item["rebaked"] = int(bake.get("changed") or 0)
            item["rendered"] = (read_rendered_route_gotos(tenant_id, did_digits).get("gotos") or [])
        except Exception as exc:
            item["error"] = str(exc)
        repaired.append(item)
    return {"ok": True, "version": VERSION, "doorwayDestinationId": good_dest, "goto": goto,
            "doorway": evidence, "routes": repaired}

def queue_moh_table_name(conn):
    """Queue hold music comes from queues.conf / this table, not inbound CHANNEL(musicclass)."""
    candidates = ("ombu_queues", "ombu_call_queues")
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT TABLE_NAME,
                   SUM(CASE WHEN COLUMN_NAME = 'tenant_id' THEN 1 ELSE 0 END) AS has_tenant,
                   SUM(CASE WHEN COLUMN_NAME = 'music_group_id' THEN 1 ELSE 0 END) AS has_moh
              FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN %s
               AND COLUMN_NAME IN ('tenant_id', 'music_group_id')
             GROUP BY TABLE_NAME
            HAVING has_tenant = 1 AND has_moh = 1
             ORDER BY FIELD(TABLE_NAME, 'ombu_queues', 'ombu_call_queues')
             LIMIT 1
            """,
            (candidates,),
        )
        row = cur.fetchone()
    if not row:
        return None
    name = str(row.get("TABLE_NAME") or "").strip()
    return name or None

def sample_queue_moh_rows(conn, table, tenant_id):
    with conn.cursor() as cur:
        cur.execute(f"SELECT * FROM `{table}` WHERE tenant_id = %s ORDER BY 1 LIMIT 10", (tenant_id,))
        return cur.fetchall()

def count_rows_for_tenant(conn, table, tenant_id):
    if table not in {"ombu_inbound_routes", "ombu_extensions"}:
        raise ValueError("invalid_count_table")
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS n FROM {table} WHERE tenant_id = %s", (tenant_id,))
        row = cur.fetchone() or {}
        return int(row.get("n") or 0)

def sample_music_groups(conn, table, tenant_id):
    if table == "ombu_inbound_routes":
        sql = """
            SELECT inbound_route_id AS id, did AS label, description, music_group_id
            FROM ombu_inbound_routes
            WHERE tenant_id = %s
            ORDER BY inbound_route_id
            LIMIT 20
        """
    elif table == "ombu_extensions":
        sql = """
            SELECT extension_id AS id, extension AS label, name AS description, music_group_id
            FROM ombu_extensions
            WHERE tenant_id = %s
            ORDER BY extension_id
            LIMIT 20
        """
    else:
        raise ValueError("invalid_sample_table")
    with conn.cursor() as cur:
        cur.execute(sql, (tenant_id,))
        return cur.fetchall()

def run_apply_command(command):
    start = time.time()
    proc = subprocess.run(shlex.split(command), text=True, capture_output=True, timeout=CFG.apply_timeout, check=False)
    return {
        "argv": shlex.split(command),
        "exitCode": proc.returncode,
        "elapsedMs": int((time.time() - start) * 1000),
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
    }

def apply_changes(reload_moh=False, reload_queues=False):
    if not CFG.apply_command:
        return {"ran": False, "reason": "apply_command_not_configured"}
    commands = [CFG.apply_command]
    if reload_moh:
        commands.append('asterisk -rx "moh reload"')
    if reload_queues:
        # X4 (2026-07-23): queue hold music lives in queues.conf ??? app_queue only
        # picks up a musicclass change on a queue reload. Waiting callers keep
        # their position (same reload a VitalPBX GUI queue edit triggers).
        commands.append('asterisk -rx "queue reload all"')
    results = [run_apply_command(command) for command in commands]
    failed = next((r for r in results if r["exitCode"] != 0), None)
    return {
        "ran": True,
        "reloadMoh": reload_moh,
        "reloadQueues": reload_queues,
        "exitCode": int(failed["exitCode"]) if failed else 0,
        "commands": results,
        "stdout": "\n".join(str(r.get("stdout") or "") for r in results)[-4000:],
        "stderr": "\n".join(str(r.get("stderr") or "") for r in results)[-4000:],
    }

PEM_HEADER_RE = re.compile(r"^-----BEGIN [A-Z0-9 ]+-----")
SECTION_LINE_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:\(([^)]*)\))?\s*$")


def _is_valid_pem_file(path_str):
    try:
        p = Path(path_str)
        if not p.is_file():
            return False
        with p.open("rb") as fh:
            head = fh.read(4096)
        return b"-----BEGIN" in head
    except OSError:
        return False


def _find_section_span(lines, section_name):
    """Return (start_idx, end_idx) for the exact-named section's body lines
    (start_idx is the line AFTER the `[section]` header; end_idx is exclusive,
    the index of the next `[...]` header or len(lines)). Returns None if the
    section is not found. Only matches an exact, non-templated `[name]` header
    (not `[name](template)` or `[name](!)`), since transport-wss is a concrete object."""
    start = None
    for i, line in enumerate(lines):
        m = SECTION_LINE_RE.match(line)
        if not m:
            continue
        if start is None and m.group(1) == section_name:
            start = i + 1
            continue
        if start is not None:
            return start, i
    if start is not None:
        return start, len(lines)
    return None


def _extract_kv_in_span(lines, start, end, key):
    pattern = re.compile(r"^\s*" + re.escape(key) + r"\s*=\s*(.*?)\s*$")
    for i in range(start, end):
        m = pattern.match(lines[i])
        if m:
            return i, m.group(1)
    return None, None


def transport_wss_status(_body=None):
    """Read-only: report the current cert_file/priv_key_file for the configured
    transport section and whether both resolve to a readable PEM file. Never
    writes anything. Safe to call at any time, including before authorization
    to change anything."""
    conf_path = Path(CFG.transport_wss_conf_path)
    result = {
        "ok": True,
        "confPath": str(conf_path),
        "section": CFG.transport_wss_section,
        "confPresent": conf_path.is_file(),
        "sectionFound": False,
        "currentCertFile": None,
        "currentPrivKeyFile": None,
        "currentCertFileValid": False,
        "currentPrivKeyFileValid": False,
        "desiredCertFile": CFG.transport_wss_desired_cert_file,
        "desiredPrivKeyFile": CFG.transport_wss_desired_key_file,
        "desiredCertFileValid": _is_valid_pem_file(CFG.transport_wss_desired_cert_file),
        "desiredPrivKeyFileValid": _is_valid_pem_file(CFG.transport_wss_desired_key_file),
        "healthy": False,
    }
    if not conf_path.is_file():
        return result
    lines = conf_path.read_text(errors="replace").splitlines()
    span = _find_section_span(lines, CFG.transport_wss_section)
    if span is None:
        return result
    result["sectionFound"] = True
    start, end = span
    _, cert_val = _extract_kv_in_span(lines, start, end, "cert_file")
    _, key_val = _extract_kv_in_span(lines, start, end, "priv_key_file")
    result["currentCertFile"] = cert_val
    result["currentPrivKeyFile"] = key_val
    result["currentCertFileValid"] = _is_valid_pem_file(cert_val) if cert_val else False
    result["currentPrivKeyFileValid"] = _is_valid_pem_file(key_val) if key_val else False
    result["healthy"] = result["currentCertFileValid"] and result["currentPrivKeyFileValid"]
    try:
        proc = subprocess.run(["asterisk", "-rx", "pjsip show transports"], text=True, capture_output=True, timeout=10, check=False)
        output = proc.stdout + proc.stderr
        result["pjsipShowTransportsOutput"] = output[-4000:]
        result["transportPresentLive"] = (CFG.transport_wss_section in output)
    except Exception as exc:
        result["pjsipShowTransportsError"] = str(exc)
    return result


def ensure_transport_wss_cert(body):
    """Idempotent self-heal for the default [transport-wss] object's cert paths.

    No-ops (changed=False) if the CURRENT cert_file/priv_key_file already point
    at readable PEM files -- this makes it safe to call unconditionally on a
    schedule or on every deploy, exactly like the MOH sync action. Only writes
    when the current paths are missing/unreadable AND the desired replacement
    files (already-valid, VitalPBX-managed certs) pass a PEM sanity check.
    Snapshots the pre-image on first write for auditability. Edits ONLY the
    cert_file/priv_key_file lines inside the named section span -- every other
    line in the file, and every other section, is left byte-for-byte unchanged.
    """
    dry_run = bool(body.get("dryRun", False))
    actor = str(body.get("actor") or "")[:128]
    request_id = str(body.get("requestId") or "")[:128]
    conf_path = Path(CFG.transport_wss_conf_path)
    if not conf_path.is_file():
        raise RuntimeError("transport_wss_conf_path_missing: " + str(conf_path))
    original_text = conf_path.read_text(errors="replace")
    lines = original_text.splitlines()
    had_trailing_newline = original_text.endswith("\n")
    span = _find_section_span(lines, CFG.transport_wss_section)
    if span is None:
        raise RuntimeError("section_not_found: " + CFG.transport_wss_section)
    start, end = span
    cert_idx, cert_val = _extract_kv_in_span(lines, start, end, "cert_file")
    key_idx, key_val = _extract_kv_in_span(lines, start, end, "priv_key_file")
    cert_ok = _is_valid_pem_file(cert_val) if cert_val else False
    key_ok = _is_valid_pem_file(key_val) if key_val else False
    if cert_ok and key_ok:
        return {
            "ok": True,
            "changed": False,
            "reason": "cert_files_already_present",
            "currentCertFile": cert_val,
            "currentPrivKeyFile": key_val,
        }
    if not _is_valid_pem_file(CFG.transport_wss_desired_cert_file):
        raise RuntimeError("desired_cert_file_invalid_or_missing: " + CFG.transport_wss_desired_cert_file)
    if not _is_valid_pem_file(CFG.transport_wss_desired_key_file):
        raise RuntimeError("desired_priv_key_file_invalid_or_missing: " + CFG.transport_wss_desired_key_file)
    plan = {
        "confPath": str(conf_path),
        "section": CFG.transport_wss_section,
        "before": {"certFile": cert_val, "privKeyFile": key_val},
        "after": {"certFile": CFG.transport_wss_desired_cert_file, "privKeyFile": CFG.transport_wss_desired_key_file},
    }
    if dry_run:
        return {"ok": True, "changed": False, "dryRun": True, "plan": plan}
    with snap_conn() as sconn:
        existing = sconn.execute(
            "SELECT conf_path FROM transport_cert_snapshots WHERE conf_path = ?", (str(conf_path),)
        ).fetchone()
        if not existing:
            sconn.execute(
                """
                INSERT INTO transport_cert_snapshots
                  (conf_path, section, captured_at, captured_by, request_id,
                   original_file_text, original_cert_file, original_priv_key_file)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (str(conf_path), CFG.transport_wss_section, utc_now(), actor, request_id, original_text, cert_val, key_val),
            )
            sconn.commit()

    def _set_kv_line(idx, key, value):
        new_line = key + "=" + value
        if idx is not None:
            lines[idx] = new_line
        else:
            lines.insert(end, new_line)
    # Replace priv_key_file first if it comes after cert_file so cert_idx stays valid
    # when inserting a brand-new line (insertion only happens if the key was absent,
    # which is not expected here since the section already had both keys per the
    # confirmed diagnosis, but handled defensively).
    if cert_idx is not None:
        lines[cert_idx] = "cert_file=" + CFG.transport_wss_desired_cert_file
    else:
        lines.insert(end, "cert_file=" + CFG.transport_wss_desired_cert_file)
        end += 1
    if key_idx is not None:
        lines[key_idx] = "priv_key_file=" + CFG.transport_wss_desired_key_file
    else:
        lines.insert(end, "priv_key_file=" + CFG.transport_wss_desired_key_file)
        end += 1
    new_text = "\n".join(lines) + ("\n" if had_trailing_newline else "")
    orig_stat = conf_path.stat()
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".pjsip.conf.", suffix=".tmp", dir=str(conf_path.parent))
    try:
        with os.fdopen(tmp_fd, "w") as fh:
            fh.write(new_text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_path, orig_stat.st_mode & 0o777)
        try:
            os.chown(tmp_path, orig_stat.st_uid, orig_stat.st_gid)
        except (PermissionError, OSError, AttributeError):
            pass
        os.replace(tmp_path, conf_path)
    except Exception:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    reload_result = run_apply_command(CFG.transport_wss_reload_command)
    status_after = transport_wss_status()
    return {
        "ok": True,
        "changed": True,
        "plan": plan,
        "reload": reload_result,
        "statusAfter": status_after,
    }


# ?????? X4 queue MOH coverage (2026-07-23) ??????????????????????????????????????????????????????????????????????????????????????????????????????????????????
# Queue hold music is the `musicclass=` line in the VitalPBX-generated
# /etc/asterisk/vitalpbx/queues__50-<tenant>-main.conf. The DB update alone
# (music_group_id) never reaches the running config until a GUI edit forces a
# regen. These functions converge the generated file to what VitalPBX would
# itself render from the already-updated DB row ??? regen-free, tenant-scoped,
# backed up, and scope-verified line by line. FAIL-SAFE: on ANY doubt the file
# is left untouched and the error is reported in the response evidence.

QUEUE_CONF_DIR = "/etc/asterisk/vitalpbx"
# Backups live in the service's own data dir: the systemd unit runs with
# ProtectSystem=strict and /var/lib/connect-pbx-helper is in ReadWritePaths
# (/opt is read-only to the service ??? learned the hard way, 2026-07-23).
QUEUE_BACKUP_DIR = "/var/lib/connect-pbx-helper/backups"

# The VitalPBX web GUI (PHP-FPM) writes every generated tenant conf as
# www-data:www-data 0644. A helper-triggered regen (apply_tenant_changes)
# rewrites them as asterisk:asterisk instead, after which every panel
# Save/Apply for that tenant crashes with file_put_contents(...) Permission
# denied in OmbuSystemConf.php (verified live on tenants 2 + 35, 2026-08-05).
# Every helper write to these files must therefore leave them GUI-writable.
GUI_CONF_OWNER_USER = "www-data"
GUI_CONF_OWNER_GROUP = "www-data"
GUI_CONF_MODE = 0o644

def _chown_gui_conf(path):
    """Best-effort: leave one generated tenant conf owned www-data:www-data
    0644 so the GUI can rewrite it. Never raises."""
    out = {"file": str(path), "changed": False, "error": None}
    try:
        uid = pwd.getpwnam(GUI_CONF_OWNER_USER).pw_uid
        gid = grp.getgrnam(GUI_CONF_OWNER_GROUP).gr_gid
        st = os.stat(path)
        if st.st_uid != uid or st.st_gid != gid:
            os.chown(path, uid, gid)
            out["changed"] = True
        if (st.st_mode & 0o777) != GUI_CONF_MODE:
            os.chmod(path, GUI_CONF_MODE)
            out["changed"] = True
    except (KeyError, OSError) as exc:
        out["error"] = str(exc)
    return out

def restore_gui_conf_ownership(tenant_id):
    """Chown the tenant's regenerated conf files back to the GUI convention
    after a regen. Tenant-scoped and non-fatal: chown trouble is reported in
    the evidence, never raised, so it can't abort a doorway/IVR switch."""
    t = int(tenant_id)
    files = []
    for name in ("extensions__50-%d-dialplan.conf" % t, "queues__50-%d-main.conf" % t):
        path = Path(QUEUE_CONF_DIR) / name
        if not path.is_file():
            files.append({"file": str(path), "changed": False, "error": "missing"})
            continue
        files.append(_chown_gui_conf(path))
    return {"files": files}

def target_class_for_group(music_group_id):
    """VitalPBX renders music group N as Asterisk class 'mohN'; seed group 1 is 'default'."""
    gid = int(music_group_id)
    return "default" if gid == 1 else "moh%d" % gid

def moh_class_generated(target_class):
    """The target class must already exist in the generated MOH confs ???
    otherwise patching queues would point them at a nonexistent class."""
    pat = re.compile(r"^\[%s\]\s*$" % re.escape(target_class), re.M)
    for p in Path(QUEUE_CONF_DIR).glob("musiconhold__*.conf"):
        try:
            if pat.search(p.read_text(errors="replace")):
                return True
        except OSError:
            continue
    return False

def _patch_queue_musicclass_text(text, tenant_id, target_class):
    """Pure text transform (unit-tested offline). Refuses if ANY section in the
    file is not [T<tenant>_Q<digits>] ??? a foreign section means the filename
    convention changed and we must not touch the file."""
    lines = text.splitlines(keepends=True)
    section_re = re.compile(r"^\[([^\]]+)\]\s*$")
    own_re = re.compile(r"^T%d_Q\d+$" % int(tenant_id))
    sections = []
    for ln in lines:
        m = section_re.match(ln.strip())
        if m:
            sections.append(m.group(1))
    foreign = [s for s in sections if not own_re.match(s)]
    if foreign:
        return {"error": "foreign_sections_present", "foreign": foreign[:5], "sections": len(sections), "changed": 0, "oldClasses": [], "newText": None}
    mc_re = re.compile(r"^(musicclass=)(.*?)(\r?\n?)$")
    old_classes = []
    changed = 0
    out = []
    for ln in lines:
        m = mc_re.match(ln)
        if m:
            old_classes.append(m.group(2))
            if m.group(2) != target_class:
                ln = m.group(1) + target_class + m.group(3)
                changed += 1
        out.append(ln)
    return {"error": None, "foreign": [], "sections": len(sections), "changed": changed, "oldClasses": old_classes, "newText": "".join(out)}

def patch_tenant_queue_musicclass(tenant_id, music_group_id, target_class=None):
    """Tenant-scoped, backed-up, atomic musicclass patch. Never raises.
    target_class overrides the group mapping (used to re-apply a connect_*
    class after a VitalPBX regen — see reapply_moh_patches_after_regen)."""
    evidence = {"attempted": False, "patched": 0, "sections": 0, "targetClass": None, "file": None, "backup": None, "oldClasses": [], "error": None}
    try:
        t = int(tenant_id)
        target = target_class or target_class_for_group(music_group_id)
        evidence["targetClass"] = target
        conf = Path(QUEUE_CONF_DIR) / ("queues__50-%d-main.conf" % t)
        evidence["file"] = str(conf)
        if not conf.is_file():
            evidence["error"] = "queue_conf_missing"  # tenant has no queue conf ??? nothing to do
            return evidence
        if not moh_class_generated(target):
            evidence["error"] = "moh_class_not_generated"
            return evidence
        evidence["attempted"] = True
        original = conf.read_text(errors="replace")
        res = _patch_queue_musicclass_text(original, t, target)
        evidence["sections"] = res["sections"]
        evidence["oldClasses"] = res["oldClasses"]
        if res["error"]:
            evidence["error"] = res["error"]
            return evidence
        if res["changed"] == 0:
            return evidence  # already carries the target class
        # SCOPE VERIFICATION: the new text must differ from the original in
        # exactly `changed` lines, every one of them a musicclass line.
        orig_lines = original.splitlines()
        new_lines = res["newText"].splitlines()
        if len(orig_lines) != len(new_lines):
            evidence["error"] = "patch_line_count_mismatch"
            return evidence
        diff_idx = [i for i, (a, b) in enumerate(zip(orig_lines, new_lines)) if a != b]
        if len(diff_idx) != res["changed"] or any(not orig_lines[i].startswith("musicclass=") for i in diff_idx):
            evidence["error"] = "patch_scope_violation"
            return evidence
        backup_dir = Path(QUEUE_BACKUP_DIR)
        backup_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        backup = backup_dir / ("%s.%s.bak" % (conf.name, dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
        st = os.stat(conf)
        backup.write_text(original)
        evidence["backup"] = str(backup)
        tmp = conf.with_name(conf.name + ".connect-tmp")  # suffix ??? *.conf ??? never picked up by the include glob
        tmp.write_text(res["newText"])
        os.chmod(tmp, st.st_mode & 0o777)
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except PermissionError:
            pass
        os.replace(tmp, conf)
        evidence["ownership"] = _chown_gui_conf(conf)
        evidence["patched"] = res["changed"]
        return evidence
    except Exception as exc:
        evidence["error"] = "patch_failed: %s" % exc
        return evidence

# ?????? X5 full MOH convergence (2026-07-26) ???????????????????????????????????????????????????????????????????????????????????????????????????????????????
# Root-caused on live call C-0000319b (2026-07-26): VitalPBX HARD-CODES each
# object's MOH class into the generated tenant dialplan
# (/etc/asterisk/vitalpbx/extensions__50-<tenant>-dialplan.conf) as
#   Gosub(sub-set-moh,s,1(<class>,YES))
# right before Queue()/Dial(). That Set(CHANNEL(musicclass)) BEATS queues.conf
# and the Connect tenant AstDB keys, so the X4 DB+queues.conf sync left queue
# callers hearing the old class until a GUI apply regenerated the dialplan.
# X5 therefore converges, in one call: EVERY MOH-bearing DB table, the queue
# conf (X4), the generated dialplan's hard-coded classes, and the per-queue /
# per-extension AstDB `moh` keys the baseplan reads behind FORCE_QUEUE_MOH.
# Same fail-safe rules as X4: backups, atomic replace, strict scope
# verification, and on ANY doubt the file is left untouched and the error is
# reported in the response evidence.

# Meta-table that DEFINES the music groups ??? must never be rewritten.
MOH_TABLE_EXCLUDE = {"ombu_music_groups"}

# Only genuine music-class tokens are rewritten in the dialplan. `ringback`
# (ring groups set to ring instead of music) and any other special tokens are
# deliberately left alone.
DIALPLAN_MOH_TOKEN = r"(?:default|moh\d+|connect_[A-Za-z0-9_]+)"

def moh_bearing_tables(conn):
    """Every ombu_* table with BOTH tenant_id and music_group_id columns ???
    i.e. every object type whose MOH VitalPBX renders from the DB (inbound
    routes, extensions, queues, ring groups, conferences, parking lots,
    trunks, follow-me, dial profiles, ...). Discovered dynamically so a
    VitalPBX upgrade that adds a new MOH-bearing object type is covered
    without a helper change."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT TABLE_NAME
              FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND COLUMN_NAME IN ('tenant_id', 'music_group_id')
             GROUP BY TABLE_NAME
            HAVING COUNT(DISTINCT COLUMN_NAME) = 2
            """
        )
        rows = cur.fetchall()
    names = sorted(str(r.get("TABLE_NAME") or "") for r in rows)
    return [n for n in names if n.startswith("ombu_") and n not in MOH_TABLE_EXCLUDE]

def _patch_dialplan_moh_text(text, target_class):
    """Pure text transform (offline-testable). Rewrites ONLY the class token
    inside `sub-set-moh,s,1(<class>` occurrences, preserving the rest of each
    line byte-for-byte. Line count is always preserved."""
    moh_re = re.compile(r"(sub-set-moh,s,1\()(" + DIALPLAN_MOH_TOKEN + r")([,)])")
    lines = text.splitlines(keepends=True)
    old_classes = []
    changed = 0
    out = []
    for ln in lines:
        def _sub(m):
            old_classes.append(m.group(2))
            return m.group(1) + target_class + m.group(3)
        new_ln, n = moh_re.subn(_sub, ln)
        if n and new_ln != ln:
            changed += 1
            ln = new_ln
        out.append(ln)
    return {"error": None, "changed": changed, "oldClasses": old_classes, "newText": "".join(out)}

def patch_tenant_dialplan_moh(tenant_id, music_group_id, target_class=None):
    """Tenant-scoped (per-tenant generated file), backed-up, atomic patch of
    the hard-coded MOH classes in the generated dialplan. Never raises. The
    standard apply command (`dialplan reload`) must run afterwards ??? the
    caller's apply_changes() does that. NOTE: unlike the queue conf, the
    tenant dialplan legitimately contains non-T<t>_ sections (IVR-<n>,
    ARS-<n>, parking-<t>-*), so scope safety here is the tenant-scoped
    FILENAME plus the strict line-level diff check below, not section names."""
    evidence = {"attempted": False, "patched": 0, "targetClass": None, "file": None, "backup": None, "oldClasses": [], "error": None}
    try:
        t = int(tenant_id)
        target = target_class or target_class_for_group(music_group_id)
        evidence["targetClass"] = target
        conf = Path(QUEUE_CONF_DIR) / ("extensions__50-%d-dialplan.conf" % t)
        evidence["file"] = str(conf)
        if not conf.is_file():
            evidence["error"] = "dialplan_conf_missing"  # tenant has no generated dialplan ??? nothing to do
            return evidence
        if not moh_class_generated(target):
            evidence["error"] = "moh_class_not_generated"
            return evidence
        evidence["attempted"] = True
        original = conf.read_text(errors="replace")
        res = _patch_dialplan_moh_text(original, target)
        evidence["oldClasses"] = sorted(set(res["oldClasses"]))
        if res["changed"] == 0:
            return evidence  # already converged
        # SCOPE VERIFICATION: same line count, and every differing line must
        # contain a sub-set-moh call ??? anything else means the transform did
        # something unexpected and the file must not be replaced.
        orig_lines = original.splitlines()
        new_lines = res["newText"].splitlines()
        if len(orig_lines) != len(new_lines):
            evidence["error"] = "patch_line_count_mismatch"
            return evidence
        diff_idx = [i for i, (a, b) in enumerate(zip(orig_lines, new_lines)) if a != b]
        if len(diff_idx) != res["changed"] or any("sub-set-moh,s,1(" not in orig_lines[i] for i in diff_idx):
            evidence["error"] = "patch_scope_violation"
            return evidence
        backup_dir = Path(QUEUE_BACKUP_DIR)
        backup_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        backup = backup_dir / ("%s.%s.bak" % (conf.name, dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
        st = os.stat(conf)
        backup.write_text(original)
        evidence["backup"] = str(backup)
        tmp = conf.with_name(conf.name + ".connect-tmp")  # suffix ??? *.conf ??? never picked up by the include glob
        tmp.write_text(res["newText"])
        os.chmod(tmp, st.st_mode & 0o777)
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except PermissionError:
            pass
        os.replace(tmp, conf)
        evidence["ownership"] = _chown_gui_conf(conf)
        evidence["patched"] = res["changed"]
        return evidence
    except Exception as exc:
        evidence["error"] = "patch_failed: %s" % exc
        return evidence

def sync_tenant_moh_astdb(tenant_id, music_group_id, queue_table):
    """Converge the per-queue and per-extension AstDB `moh` keys to the target
    class. The baseplan reads `${DB(<path>/queues/<n>/moh)}` behind
    FORCE_QUEUE_MOH (and the per-extension analog); VitalPBX only rewrites
    these keys on a GUI apply, so a DB-only sync leaves them stale. Fail-safe:
    reports per-family counts, never raises."""
    out = {"attempted": False, "tenantPath": None, "targetClass": None, "queueKeys": 0, "extensionKeys": 0, "failed": 0, "error": None}
    try:
        target = target_class_for_group(music_group_id)
        out["targetClass"] = target
        exts = []
        queues = []
        with db_conn() as conn:
            path = resolve_tenant_path(conn, tenant_id)
            if not path:
                out["error"] = "tenant_path_not_found"
                return out
            out["tenantPath"] = path
            with conn.cursor() as cur:
                cur.execute("SELECT extension FROM ombu_extensions WHERE tenant_id = %s", (tenant_id,))
                exts = [str((r or {}).get("extension") or "").strip() for r in cur.fetchall()]
                if queue_table:
                    cur.execute(f"SELECT extension FROM `{queue_table}` WHERE tenant_id = %s", (tenant_id,))
                    queues = [str((r or {}).get("extension") or "").strip() for r in cur.fetchall()]
        out["attempted"] = True
        for q in queues:
            if not re.match(r"^\d{1,10}$", q):
                continue
            if _astdb_put("%s/queues/%s" % (path, q), "moh", target):
                out["queueKeys"] += 1
            else:
                out["failed"] += 1
        for e in exts:
            if not re.match(r"^\d{1,10}$", e):
                continue
            if _astdb_put("%s/extensions/%s" % (path, e), "moh", target):
                out["extensionKeys"] += 1
            else:
                out["failed"] += 1
        return out
    except Exception as exc:
        out["error"] = "astdb_sync_failed: %s" % exc
        return out

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
    # `mode` reflects the DB row. `rendered` reflects what CALLERS FOLLOW —
    # the two can disagree after any regen (see read_rendered_route_gotos).
    # renderedMatchesMode is the one field a monitor should trust.
    rendered = read_rendered_route_gotos(tenant_id, did_digits)
    doorway_ctx = CONNECT_DOORWAY_CONTEXT + ","
    points_at_doorway = any(str(g).startswith(doorway_ctx) for g in rendered.get("gotos") or [])
    rendered["pointsAtDoorway"] = points_at_doorway
    rendered_mode = "connect" if points_at_doorway else ("pbx" if rendered.get("gotos") else "unknown")
    rendered["mode"] = rendered_mode
    return {
        "ok": True, "version": VERSION, "did": did_e164, "didDigits": did_digits,
        "tenantId": tenant_id, "route": route, "snapshot": snapshot, "mode": mode,
        "rendered": rendered,
        "renderedMatchesMode": rendered_mode == mode,
    }

def retarget_route(body):
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    force = bool(body.get("force", False))
    actor = str(body.get("actor") or "")[:128]
    request_id = str(body.get("requestId") or "")[:128]
    # Doorway self-heal, dialplan half: BEFORE the transaction (it shells out
    # to Asterisk). strict — never flip a route toward a context that is not
    # answering in the running dialplan.
    doorway = {"dialplan": ensure_connect_doorway_dialplan(strict=True)}
    with db_conn() as conn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            current_dest = str(route["destination_id"])
            # Doorway self-heal, DB half: resolve by request id → env pin →
            # discovery by name (creating the rows inside THIS transaction if
            # they are missing). Stale pinned ids are skipped, not fatal.
            connect_dest = resolve_connect_destination(conn, body.get("connectDestinationId"), doorway)
            if current_dest == connect_dest:
                conn.commit()  # keep any doorway rows created during resolution
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route, "doorway": doorway}
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
    # 2026-08-05: same lesson agent_set learned 2026-07-28 — the legacy apply
    # only reloads, it never regenerates the tenant conf, so the DB retarget
    # stayed invisible to callers. Real per-tenant regen + direct Goto bake.
    apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_INBOUND_ROUTE,))
    # 2026-08-06: bake the doorway as a CONSTANT. Decoding connect_dest here is
    # what re-baked a hijacked row's meaning (a PBX IVR) over a live Connect
    # number. VitalPBX's own regen never renders the doorway either — this bake
    # IS the routing, so it must not depend on a row the panel can rewrite.
    with db_conn() as conn:
        goto = _doorway_goto(conn)
    bake = _bake_goto(tenant_id, did_digits, goto)
    if bake.get("error"):
        raise RuntimeError("route_bake_failed:%s" % bake["error"])
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {"ok": True, "did": did_e164, "tenantId": tenant_id, "routeId": route_id, "before": route, "after": after, "connectDestinationId": connect_dest, "doorway": doorway, "apply": apply_result, "bake": bake}

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
    # 2026-08-05: hand-back needs the same real regen + bake as the flip —
    # see retarget_route above.
    apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_INBOUND_ROUTE,))
    bake = None
    with db_conn() as conn:
        decoded = _decode_destination(conn, original_dest)
    if decoded and decoded.get("type") in BAKEABLE_TARGET_TYPES and decoded.get("targetId"):
        bake = bake_route_goto(tenant_id, did_digits, decoded["type"], decoded["targetId"])
        if bake.get("error"):
            raise RuntimeError("route_bake_failed:%s" % bake["error"])
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {"ok": True, "did": did_e164, "tenantId": tenant_id, "routeId": route_id, "before": route, "after": after, "restoredDestinationId": original_dest, "apply": apply_result, "bake": bake}

# ?????? M3 (agent route change) ??? ISOLATED native-route destination change ?????????????????????
# Changes ombu_inbound_routes.destination_id for a tenant's DID to a target the
# CONNECT side already proved is a tenant-owned, in-use destination. Uses its own
# agent_route_snapshots table and NEVER writes current_connect_destination_id, so
# it cannot corrupt the connect/pbx mode signal. Refuses Connect-managed routes.

def _route_is_connect_managed(route_id, current_dest):
    """Defense-in-depth: refuse if this route is currently Connect-dispatched
    (its destination equals a stored current_connect_destination_id, equals
    the configured connect destination, or IS the named Connect doorway). The
    Connect side already fences this; this is the belt-and-suspenders check on
    the PBX itself."""
    if CFG.connect_destination_id and str(current_dest) == str(CFG.connect_destination_id):
        return True
    try:
        with db_conn() as conn:
            # include_invalid: a HIJACKED doorway destination must still count as
            # Connect-managed here, or M3 would happily retarget a route Connect
            # owns just because the panel repurposed the row underneath it.
            for row in _find_doorway_rows(conn, include_invalid=True):
                if str(row["dest_id"]) == str(current_dest):
                    return True
    except Exception:
        pass  # doorway lookup is best-effort here; the snapshot check below still runs
    with snap_conn() as sconn:
        row = sconn.execute("SELECT current_connect_destination_id FROM inbound_route_snapshots WHERE route_id = ?", (route_id,)).fetchone()
    return bool(row and row[0] and str(row[0]) == str(current_dest))

def agent_set_route_destination(body):
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    dest = require_num("destination_id", body.get("destinationId"))
    force = bool(body.get("force", False))
    actor = str(body.get("actor") or "")[:128]
    request_id = str(body.get("requestId") or "")[:128]
    with db_conn() as conn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            current_dest = str(route["destination_id"])
            if _route_is_connect_managed(route_id, current_dest):
                raise RuntimeError("connect_managed_route_refused")
            if current_dest == dest:
                conn.rollback()
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route, "after": route, "destinationId": dest}
            if not destination_exists(conn, dest):
                raise RuntimeError("destination_not_found")
            with snap_conn() as sconn:
                existing = sconn.execute("SELECT original_destination_id, last_set_destination_id FROM agent_route_snapshots WHERE route_id = ?", (route_id,)).fetchone()
                if existing and not force:
                    original = str(existing[0])
                    last_set = str(existing[1]) if existing[1] is not None else None
                    # Drift guard: current must be our captured original or the
                    # destination WE last wrote (agent retarget → retarget again).
                    if current_dest != original and current_dest != last_set:
                        raise RuntimeError("route_drifted_since_capture")
                if not existing:
                    sconn.execute("""
                    INSERT INTO agent_route_snapshots
                      (route_id, tenant_id, did_digits, did_e164, captured_at, captured_by, request_id, original_row_json, original_destination_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (route_id, tenant_id, did_digits, did_e164, utc_now(), actor, request_id, json.dumps(route, sort_keys=True), current_dest))
                sconn.execute("UPDATE agent_route_snapshots SET last_set_destination_id = ? WHERE route_id = ?", (str(dest), route_id))
                sconn.commit()
            with conn.cursor() as cur:
                cur.execute("""
                UPDATE ombu_inbound_routes
                SET destination_id = %s
                WHERE inbound_route_id = %s AND tenant_id = %s AND destination_id = %s
                """, (dest, route_id, tenant_id, current_dest))
                if cur.rowcount != 1:
                    raise RuntimeError("agent_set_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    # 2026-07-28: destinations are BAKED into the generated dialplan — the old
    # `dialplan reload` apply never surfaced this write. Real per-tenant regen.
    apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_INBOUND_ROUTE,))
    bake = None
    with db_conn() as conn:
        decoded = _decode_destination(conn, dest)
    if decoded and decoded.get("type") in DEST_TARGET_TYPES and decoded.get("targetId"):
        bake = bake_route_goto(tenant_id, did_digits, decoded["type"], decoded["targetId"])
        if bake.get("error"):
            raise RuntimeError("route_bake_failed:%s" % bake["error"])
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {"ok": True, "did": did_e164, "tenantId": tenant_id, "routeId": route_id, "before": route, "after": after, "destinationId": dest, "apply": apply_result, "bake": bake}

def agent_restore_route_destination(body):
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    with db_conn() as conn, snap_conn() as sconn:
        try:
            conn.begin()
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            snap = sconn.execute("SELECT original_destination_id FROM agent_route_snapshots WHERE route_id = ?", (route_id,)).fetchone()
            if not snap:
                raise LookupError("agent_snapshot_not_found")
            original_dest = str(snap[0])
            current_dest = str(route["destination_id"])
            if current_dest == original_dest:
                conn.rollback()
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route, "after": route, "restoredDestinationId": original_dest}
            if not destination_exists(conn, original_dest):
                raise RuntimeError("original_destination_not_found")
            with conn.cursor() as cur:
                cur.execute("""
                UPDATE ombu_inbound_routes
                SET destination_id = %s
                WHERE inbound_route_id = %s AND tenant_id = %s AND destination_id = %s
                """, (original_dest, route_id, tenant_id, current_dest))
                if cur.rowcount != 1:
                    raise RuntimeError("agent_restore_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    # 2026-07-28: same as agent_set — restore needs the real per-tenant regen.
    apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_INBOUND_ROUTE,))
    bake = None
    with db_conn() as conn:
        decoded = _decode_destination(conn, original_dest)
    if decoded and decoded.get("type") in DEST_TARGET_TYPES and decoded.get("targetId"):
        bake = bake_route_goto(tenant_id, did_digits, decoded["type"], decoded["targetId"])
        if bake.get("error"):
            raise RuntimeError("route_bake_failed:%s" % bake["error"])
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {"ok": True, "did": did_e164, "tenantId": tenant_id, "routeId": route_id, "before": route, "after": after, "restoredDestinationId": original_dest, "apply": apply_result, "bake": bake}

# ?????? M11 (agent extension features) ??? DND / call-forward via live AstDB ?????????????????????
# Real DND/CF are live AstDB keys <tenantPath>/diversions/<ext>/<F>/{enable,
# destination}. The dialplan reads them live ??? this is `database put`, NOT
# gen-conf, so NO config regen and no reload. The scrambled tenant path is
# ombu_tenants.path (16-hex), looked up by tenant_id. Everything is validated:
# feature allow-listed, extension numeric, destination digits/+ only.

DIVERSION_FEATURES = {"DND", "CFU", "CFB", "CFN", "CFI"}
DIVERSION_DEST_RE = re.compile(r"^\+?\d{1,20}$")

def resolve_tenant_path(conn, tenant_id):
    with conn.cursor() as cur:
        cur.execute("SELECT path FROM ombu_tenants WHERE tenant_id = %s", (tenant_id,))
        row = cur.fetchone()
    p = str((row or {}).get("path") or "").strip()
    return p if re.match(r"^[0-9a-f]{8,32}$", p) else None

def _astdb_get(family, key):
    proc = subprocess.run(["asterisk", "-rx", "database get %s %s" % (family, key)], text=True, capture_output=True, timeout=15, check=False)
    m = re.search(r"^Value:\s*(.*)$", (proc.stdout or ""), re.M)
    return m.group(1).strip() if m else ""

def _astdb_put(family, key, value):
    proc = subprocess.run(["asterisk", "-rx", "database put %s %s %s" % (family, key, value)], text=True, capture_output=True, timeout=15, check=False)
    return proc.returncode == 0

def _ext_feature_args(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    ext = require_num("extension", body.get("extension"))
    feature = str(body.get("feature") or "").upper().strip()
    if feature not in DIVERSION_FEATURES:
        raise ValueError("invalid_feature")
    return tenant_id, ext, feature

def ext_feature_get(body):
    tenant_id, ext, feature = _ext_feature_args(body)
    with db_conn() as conn:
        path = resolve_tenant_path(conn, tenant_id)
    if not path:
        raise RuntimeError("tenant_path_not_found")
    fam = "%s/diversions/%s/%s" % (path, ext, feature)
    return {"ok": True, "tenantId": tenant_id, "extension": ext, "feature": feature,
            "enable": _astdb_get(fam, "enable") or "no", "destination": _astdb_get(fam, "destination") or ""}

def ext_feature_set(body):
    tenant_id, ext, feature = _ext_feature_args(body)
    enable = "yes" if str(body.get("enable")).lower() in ("yes", "1", "true") else "no"
    destination = str(body.get("destination") or "").strip()
    if destination and not DIVERSION_DEST_RE.match(destination):
        raise ValueError("invalid_destination")
    if feature != "DND" and enable == "yes" and not destination:
        raise ValueError("destination_required_for_call_forward")
    with db_conn() as conn:
        path = resolve_tenant_path(conn, tenant_id)
    if not path:
        raise RuntimeError("tenant_path_not_found")
    fam = "%s/diversions/%s/%s" % (path, ext, feature)
    before = {"enable": _astdb_get(fam, "enable") or "no", "destination": _astdb_get(fam, "destination") or ""}
    if not _astdb_put(fam, "enable", enable):
        raise RuntimeError("astdb_put_enable_failed")
    # Always write destination (empty clears it) so state is unambiguous.
    _astdb_put(fam, "destination", destination)
    after = {"enable": _astdb_get(fam, "enable") or "no", "destination": _astdb_get(fam, "destination") or ""}
    return {"ok": True, "tenantId": tenant_id, "extension": ext, "feature": feature, "before": before, "after": after}

def sync_tenant_moh(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    music_group_id = require_num("music_group_id", body.get("musicGroupId"))
    queue_table = None
    queues_total = 0
    queue_sample = []
    table_results = {}
    with db_conn() as conn:
        try:
            conn.begin()
            if not music_group_exists(conn, music_group_id):
                raise RuntimeError("music_group_not_found")
            inbound_total = count_rows_for_tenant(conn, "ombu_inbound_routes", tenant_id)
            extension_total = count_rows_for_tenant(conn, "ombu_extensions", tenant_id)
            queue_table = queue_moh_table_name(conn)
            if queue_table:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT COUNT(*) AS n FROM `{queue_table}` WHERE tenant_id = %s", (tenant_id,))
                    row = cur.fetchone() or {}
                    queues_total = int(row.get("n") or 0)
            # X5 (2026-07-26): "sync tenant MOH" means EVERY MOH-bearing object
            # type, not just inbound/extensions/queues ??? ring groups,
            # conferences, parking lots, trunks, follow-me, and dial profiles
            # all render their own hard-coded class into the generated
            # dialplan, so a partial DB update leaves them regen-inconsistent.
            with conn.cursor() as cur:
                for table in moh_bearing_tables(conn):
                    cur.execute(f"SELECT COUNT(*) AS n FROM `{table}` WHERE tenant_id = %s", (tenant_id,))
                    total = int((cur.fetchone() or {}).get("n") or 0)
                    cur.execute(f"""
                    UPDATE `{table}`
                    SET music_group_id = %s
                    WHERE tenant_id = %s
                      AND (music_group_id IS NULL OR music_group_id <> %s)
                    """, (music_group_id, tenant_id, music_group_id))
                    table_results[table] = {"total": total, "updated": int(cur.rowcount or 0)}
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    inbound_updated = int((table_results.get("ombu_inbound_routes") or {}).get("updated") or 0)
    extensions_updated = int((table_results.get("ombu_extensions") or {}).get("updated") or 0)
    queues_updated = int((table_results.get(queue_table) or {}).get("updated") or 0) if queue_table else 0
    # X4: converge the generated queue conf to the (already-committed) DB row,
    # then reload app_queue so the change is live ??? the missing step behind
    # "queues keep the old music until a GUI edit".
    queue_patch = patch_tenant_queue_musicclass(tenant_id, music_group_id)
    # X5: converge the hard-coded classes in the generated tenant dialplan and
    # the per-queue / per-extension AstDB keys ??? without these, callers keep
    # hearing the old class (see the X5 block comment for the live-call proof).
    dialplan_patch = patch_tenant_dialplan_moh(tenant_id, music_group_id)
    astdb_sync = sync_tenant_moh_astdb(tenant_id, music_group_id, queue_table)
    apply_result = apply_changes(reload_moh=True, reload_queues=bool(queue_patch.get("patched")))
    with db_conn() as conn:
        inbound_sample = sample_music_groups(conn, "ombu_inbound_routes", tenant_id)
        extension_sample = sample_music_groups(conn, "ombu_extensions", tenant_id)
        if queue_table and queues_total:
            queue_sample = sample_queue_moh_rows(conn, queue_table, tenant_id)
    return {
        "ok": True,
        "tenantId": tenant_id,
        "musicGroupId": music_group_id,
        "inboundTotal": inbound_total,
        "inboundUpdated": inbound_updated,
        "extensionsTotal": extension_total,
        "extensionsUpdated": extensions_updated,
        "queuesTotal": queues_total,
        "queuesUpdated": queues_updated,
        "queueTable": queue_table or "",
        "queuePatch": queue_patch,
        "tables": table_results,
        "dialplanPatch": dialplan_patch,
        "astdbSync": astdb_sync,
        "inboundSample": inbound_sample,
        "extensionSample": extension_sample,
        "queueSample": queue_sample,
        "apply": apply_result,
    }

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

VM_CONTEXT_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")

def resolve_voicemail_context_from_conf(tenant_id, extension):
    """Resolve the Asterisk voicemail context for <extension> within VitalPBX tenant <tenant_id>.

    VitalPBX stores per-tenant voicemail mailboxes in
    /etc/asterisk/vitalpbx/voicemail__50-<N>-main.conf under named contexts
    (e.g. [test-voicemail], [comfort_control-voicemail]).  The spool path that
    Asterisk's VoiceMail() reads is /var/spool/asterisk/voicemail/<context>/<ext>/.

    Returns the context name string (e.g. "test-voicemail") or None if the
    config file is absent or the extension is not found.  The return value is
    validated against VM_CONTEXT_RE before use so it is safe to embed in paths.
    """
    conf = Path("/etc/asterisk/vitalpbx/voicemail__50-" + str(tenant_id) + "-main.conf")
    if not conf.is_file():
        return None
    try:
        content = conf.read_text(errors="replace")
    except OSError:
        return None
    current_context = None
    ext_prefix = re.compile(r"^" + re.escape(str(extension)) + r"\s*=>")
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current_context = stripped[1:-1]
        elif current_context is not None and ext_prefix.match(stripped):
            if VM_CONTEXT_RE.match(current_context):
                return current_context
    return None

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
    # Prefer the actual VitalPBX voicemail context directory (e.g. test-voicemail/101/)
    # over the legacy numeric/T-prefix guesses. VitalPBX names contexts after tenant
    # slugs (voicemail__50-<N>-main.conf  ???  [<slug>-voicemail]), so the numeric path
    # "21/101/" is wrong for most installs. resolve_voicemail_context_from_conf() reads
    # the tenant's conf file to find the correct context for this extension.
    candidates = []
    vm_context = resolve_voicemail_context_from_conf(tenant, ext)
    if vm_context:
        candidates.append(root / vm_context / ext)
    candidates += [root / tenant / ext, root / ("T" + tenant) / ext, root / "default" / ext]
    for p in candidates:
        if p.is_dir():
            apply_vm_dir_owner(p)
            return p
    target = candidates[0]
    target.mkdir(mode=0o750, parents=True, exist_ok=True)
    apply_vm_dir_owner(target)
    return target

MAX_VM_SPOOL_AUDIO_BYTES = 25 * 1024 * 1024
VM_SPOOL_AUDIO_FOLDERS = frozenset({"INBOX", "Old", "Urgent"})
VM_SPOOL_LIST_FOLDERS = ("INBOX", "Old", "Urgent")
MSG_NUM_STEM_RE = re.compile(r"^msg[0-9]+$")


def _parse_vm_txt(path):
    out = {}
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def _vm_spool_int(val, default):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


# ── spool scan cache (2026-08-12) ─────────────────────────────────────────────
# Gesheft ext 101's INBOX holds 18k+ files; a single /voicemail/spool/list
# parsed EVERY msg*.txt on EVERY poll (~68/min from loopcom), which is what
# drove the thread pile-up. Asterisk touches the folder directory's mtime on
# any message add/move/delete, so a (mtime_ns, size, ino) signature over the
# three folder dirs is a reliable change detector: scan once per actual
# mailbox change, serve every other poll from memory. The per-mailbox lock
# makes concurrent cache misses scan once, not once per waiting request.
_VM_SPOOL_CACHE = {}
_VM_SPOOL_CACHE_MAX_ENTRIES = 512
_VM_SPOOL_CACHE_LOCK = threading.Lock()
_VM_SPOOL_MBOX_LOCKS = {}


def _vm_spool_dir_sig(mbox_dir):
    sig = []
    for sub in VM_SPOOL_LIST_FOLDERS:
        try:
            st = (mbox_dir / sub).stat()
            sig.append((sub, st.st_mtime_ns, st.st_size, st.st_ino))
        except OSError:
            sig.append((sub, None, None, None))
    return tuple(sig)


def _vm_spool_mbox_lock(key):
    with _VM_SPOOL_CACHE_LOCK:
        lock = _VM_SPOOL_MBOX_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _VM_SPOOL_MBOX_LOCKS[key] = lock
        return lock


def _vm_spool_scan_mailbox(mbox_dir):
    """Parse every msg*.txt under INBOX/Old/Urgent. Returns records (with the
    integer origtime under "_oti") sorted newest-first. Unfiltered: since/limit
    are applied per-request on top of the cached result."""
    records = []
    for sub in VM_SPOOL_LIST_FOLDERS:
        d = mbox_dir / sub
        if not d.is_dir():
            continue
        try:
            entries = list(d.glob("msg*.txt"))
        except OSError:
            continue
        for txt_path in entries:
            stem = txt_path.stem
            if not re.match(r"^msg[0-9]+$", stem):
                continue
            kv = _parse_vm_txt(txt_path)
            ot = str(kv.get("origtime") or "").strip()
            if not ot or ot == "0":
                continue
            try:
                oti = int(ot)
            except ValueError:
                continue
            cid = str(kv.get("callerid") or kv.get("caller_id") or "")
            dur = str(kv.get("duration") or "0")
            wav = txt_path.with_suffix(".wav")
            recfile = str(wav) if wav.is_file() else ""
            records.append(
                {
                    "folder": sub,
                    "origtime": ot,
                    "callerid": cid,
                    "duration": dur,
                    "filename": txt_path.name,
                    "msg_num": stem,
                    "recfile": recfile,
                    "_oti": oti,
                }
            )
    records.sort(key=lambda r: r["_oti"], reverse=True)
    return records


def _vm_spool_records_cached(mbox_dir):
    key = str(mbox_dir)
    sig = _vm_spool_dir_sig(mbox_dir)
    with _VM_SPOOL_CACHE_LOCK:
        ent = _VM_SPOOL_CACHE.get(key)
        if ent is not None and ent["sig"] == sig:
            return ent["records"]
    lock = _vm_spool_mbox_lock(key)
    with lock:
        # Re-check under the mailbox lock: a concurrent miss may have refreshed.
        sig = _vm_spool_dir_sig(mbox_dir)
        with _VM_SPOOL_CACHE_LOCK:
            ent = _VM_SPOOL_CACHE.get(key)
            if ent is not None and ent["sig"] == sig:
                return ent["records"]
        records = _vm_spool_scan_mailbox(mbox_dir)
        with _VM_SPOOL_CACHE_LOCK:
            _VM_SPOOL_CACHE.pop(key, None)
            while len(_VM_SPOOL_CACHE) >= _VM_SPOOL_CACHE_MAX_ENTRIES:
                _VM_SPOOL_CACHE.pop(next(iter(_VM_SPOOL_CACHE)))
            _VM_SPOOL_CACHE[key] = {"sig": sig, "records": records}
        return records


def vm_spool_list_messages(body):
    """
    Read-only: list msg*.txt under INBOX/Old/Urgent for one mailbox (no file moves).

    Semantics (schema 2):
    - Scans all three folders, parses origtime from each msg*.txt.
    - Sorts by origtime unix seconds descending (newest first). Filename order is NOT used.
    - Paginates with limit/offset (defaults from env). Never silently drops newest messages
      when returning a partial page: maxOrigtimeAll and totalCount describe the full mailbox.
    """
    extension = require_ext(body.get("extension"))
    raw_ctx = str(body.get("voicemailContext") or body.get("context") or "").strip()
    tenant_raw = str(body.get("tenantId") or "").strip()
    root = CFG.voicemail_dir.resolve()
    resolved_ctx = None
    if raw_ctx and VM_CONTEXT_RE.match(raw_ctx):
        mbox_dir = (root / raw_ctx / extension).resolve()
        if root not in mbox_dir.parents and mbox_dir != root:
            raise ValueError("voicemail_mailbox_outside_root")
        resolved_ctx = raw_ctx
    else:
        if not tenant_raw:
            raise ValueError("tenantId_required_without_valid_voicemailContext")
        tenant_id = require_num("tenant_id", tenant_raw)
        mbox_dir = voicemail_mailbox_dir(tenant_id, extension).resolve()
        resolved_ctx = resolve_voicemail_context_from_conf(tenant_id, extension)

    default_limit = _vm_spool_int(os.environ.get("CONNECT_PBX_HELPER_VM_SPOOL_LIST_DEFAULT_LIMIT"), 2000)
    max_limit_cap = _vm_spool_int(os.environ.get("CONNECT_PBX_HELPER_VM_SPOOL_LIST_MAX_LIMIT"), 20000)
    if default_limit < 1:
        default_limit = 2000
    if max_limit_cap < 1:
        max_limit_cap = 20000

    limit = _vm_spool_int(body.get("limit"), default_limit)
    offset = _vm_spool_int(body.get("offset"), 0)
    if limit < 1:
        limit = default_limit
    limit = min(limit, max_limit_cap)
    if offset < 0:
        offset = 0

    since_raw = body.get("sinceOrigtime") if body.get("sinceOrigtime") is not None else body.get("since_origtime")
    since_ot = _vm_spool_int(since_raw, 0)

    if not mbox_dir.is_dir():
        return {
            "ok": True,
            "mailboxPath": str(mbox_dir),
            "resolvedContext": resolved_ctx,
            "messages": [],
            "spoolListSchema": 2,
            "totalCount": 0,
            "returnedCount": 0,
            "offset": offset,
            "limit": limit,
            "truncated": False,
            "maxOrigtimeAll": "",
            "sort": "origtime_desc",
            "folderMsgCounts": {},
        }

    all_records = _vm_spool_records_cached(mbox_dir)
    if since_ot:
        records = [r for r in all_records if r["_oti"] >= since_ot]
    else:
        records = all_records
    folder_msg_counts = {sub: 0 for sub in VM_SPOOL_LIST_FOLDERS}
    for r in records:
        folder_msg_counts[r["folder"]] = folder_msg_counts.get(r["folder"], 0) + 1
    total_matching = len(records)
    max_ot = max((r["_oti"] for r in records), default=None)

    page = records[offset : offset + limit]
    truncated = offset + len(page) < total_matching

    messages = []
    for r in page:
        r_out = {k: v for k, v in r.items() if k != "_oti"}
        messages.append(r_out)

    return {
        "ok": True,
        "mailboxPath": str(mbox_dir),
        "resolvedContext": resolved_ctx,
        "messages": messages,
        "spoolListSchema": 2,
        "totalCount": total_matching,
        "returnedCount": len(messages),
        "offset": offset,
        "limit": limit,
        "truncated": truncated,
        "maxOrigtimeAll": str(max_ot) if max_ot is not None else "",
        "sort": "origtime_desc",
        "folderMsgCounts": folder_msg_counts,
    }


def vm_spool_read_audio(body):
    """
    Read-only: return (content_type, bytes) for one voicemail message file under the spool.
    Validates folder + msg stem; resolves mailbox dir like vm_spool_list_messages.
    Raises ValueError on bad input, LookupError if file missing.
    """
    extension = require_ext(body.get("extension"))
    folder = str(body.get("folder") or "").strip()
    if folder not in VM_SPOOL_AUDIO_FOLDERS:
        raise ValueError("invalid_folder")
    msg_num = str(body.get("msgNum") or body.get("msg_num") or "").strip()
    if not MSG_NUM_STEM_RE.match(msg_num):
        raise ValueError("invalid_msgNum")
    raw_ctx = str(body.get("voicemailContext") or body.get("context") or "").strip()
    tenant_raw = str(body.get("tenantId") or "").strip()
    root = CFG.voicemail_dir.resolve()
    if raw_ctx and VM_CONTEXT_RE.match(raw_ctx):
        mbox_dir = (root / raw_ctx / extension).resolve()
        if root not in mbox_dir.parents and mbox_dir != root:
            raise ValueError("voicemail_mailbox_outside_root")
    else:
        if not tenant_raw:
            raise ValueError("tenantId_required_without_valid_voicemailContext")
        tenant_id = require_num("tenant_id", tenant_raw)
        mbox_dir = voicemail_mailbox_dir(tenant_id, extension).resolve()
    if root not in mbox_dir.parents and mbox_dir != root:
        raise ValueError("voicemail_mailbox_outside_root")
    wav_path = (mbox_dir / folder / (msg_num + ".wav")).resolve()
    if root not in wav_path.parents:
        raise ValueError("voicemail_path_outside_root")
    if not wav_path.is_file():
        raise LookupError("audio_not_found")
    size = wav_path.stat().st_size
    if size > MAX_VM_SPOOL_AUDIO_BYTES:
        raise ValueError("audio_too_large")
    return ("audio/wav", wav_path.read_bytes())


def safe_vm_path(tenant_id, extension, greeting_type):
    mbox = voicemail_mailbox_dir(tenant_id, extension).resolve()
    root = CFG.voicemail_dir.resolve()
    if root not in mbox.parents and mbox != root:
        raise ValueError("voicemail_path_outside_root")
    return mbox / GREETING_TYPES[require_greeting_type(greeting_type)]

def pjsip_contact_endpoints_for_extension(extension):
    proc = subprocess.run(["asterisk", "-rx", "pjsip show contacts"], text=True, capture_output=True, timeout=10, check=False)
    if proc.returncode != 0:
        raise RuntimeError("pjsip_contacts_failed: " + ((proc.stdout + proc.stderr).strip() or str(proc.returncode)))
    endpoints = []
    extension_endpoint_re = re.compile(r"^(?:T\d+_)?" + re.escape(extension) + r"(?:_\d+)?$")
    for line in (proc.stdout + proc.stderr).splitlines():
        match = re.search(r"\bContact:\s+([A-Za-z0-9_.-]+)\/", line)
        if not match:
            continue
        endpoint = match.group(1)
        if extension_endpoint_re.match(endpoint):
            if endpoint not in endpoints:
                endpoints.append(endpoint)
    return endpoints

def tenant_endpoints_for_extension(tenant_id, extension):
    contacts = pjsip_contact_endpoints_for_extension(extension)
    prefix = "T" + tenant_id + "_"
    return [c for c in contacts if c == prefix + extension or c.startswith(prefix + extension + "_")]

def resolve_record_channel(channel, tenant_id, extension):
    if not channel.startswith("PJSIP/"):
        return channel, "template"
    requested_endpoint = channel[len("PJSIP/"):]
    if not re.match(r"^[A-Za-z0-9_.-]+$", requested_endpoint):
        raise ValueError("invalid_pjsip_endpoint_template")
    tenant_matches = tenant_endpoints_for_extension(tenant_id, extension)
    if requested_endpoint in tenant_matches:
        return "PJSIP/" + requested_endpoint, "tenant_template_match"
    if tenant_matches:
        return "PJSIP/" + tenant_matches[0], "tenant_first_registered:" + ",".join(tenant_matches)
    contacts = pjsip_contact_endpoints_for_extension(extension)
    if requested_endpoint in contacts:
        return "PJSIP/" + requested_endpoint, "template_registered"
    if len(contacts) == 1:
        return "PJSIP/" + contacts[0], "single_registered_match"
    if contacts:
        raise ValueError("ambiguous_pjsip_endpoint_for_extension: " + ",".join(contacts[:10]))
    raise ValueError("no_registered_pjsip_endpoint_for_extension")

def endpoint_hint_channel(body, extension):
    raw = str(body.get("pjsipEndpoint") or body.get("pbxSipUsername") or "").strip()
    if raw.startswith("PJSIP/"):
        raw = raw[len("PJSIP/"):]
    if raw:
        if not re.match(r"^[A-Za-z0-9_.-]+$", raw):
            raise ValueError("invalid_pjsip_endpoint_hint")
        return "PJSIP/" + raw
    endpoint_tenant_id = str(body.get("endpointTenantId") or "").strip()
    if endpoint_tenant_id:
        endpoint_tenant_id = require_num("endpointTenantId", endpoint_tenant_id)
        return "PJSIP/T" + endpoint_tenant_id + "_" + extension
    return None

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

def poll_pjsip_endpoint_registered(endpoint_name, max_wait_secs=20, interval_secs=2):
    """Poll 'pjsip show contacts' until endpoint_name appears with Avail status.
    Returns True if found, False on timeout. Used to wait for mobile SIP
    re-registration after an FCM wake before originating the dispatch call."""
    deadline = time.time() + max_wait_secs
    while time.time() < deadline:
        try:
            result = subprocess.run(
                ["asterisk", "-rx", "pjsip show contacts"],
                text=True, capture_output=True, timeout=8, check=False,
            )
            output = result.stdout + result.stderr
            for line in output.splitlines():
                if endpoint_name in line and "Avail" in line:
                    return True
        except Exception:
            pass
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        time.sleep(min(interval_secs, remaining))
    return False

def vm_record_call(body):
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    extension = require_ext(body.get("extension"))
    greeting_type = require_greeting_type(body.get("greetingType"))
    job_id = str(uuid.uuid4())
    target = safe_vm_path(tenant_id, extension, greeting_type)
    backup = backup_vm_greeting(target, remove_original=False)
    target.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    apply_vm_dir_owner(target.parent)
    # Use explicit token replacement instead of str.format so Asterisk context
    # suffixes like `T{tenantId}_cos-all` cannot be misparsed as a single
    # `{tenantId_cos-all}` field if an operator edits the env by hand.
    recording_exten = tenant_id + "_" + extension + "_" + target.stem
    channel = (
        CFG.vm_record_channel_template
        .replace("{tenantId}", tenant_id)
        .replace("{extension}", extension)
        .replace("{recordingExten}", recording_exten)
        .replace("{tenantId_cos-all}", tenant_id + "_cos-all")
    )
    if "{" in channel or "}" in channel:
        # Fail open to the dispatch local channel which rings all of the
        # extension's registered devices and runs the recording dialplan.
        channel = "Local/" + recording_exten + "@connect-vm-greeting-dispatch/n"
    dispatch_dial_string = ""
    dispatch_endpoints: list = []
    if channel.startswith("Local/") and "connect-vm-greeting-dispatch" in channel:
        # Build the dial string from KNOWN endpoint names rather than querying
        # pjsip show contacts. The dispatch dialplan context includes Wait(5)
        # as a small buffer. The real registration wait is done synchronously
        # in poll_pjsip_endpoint_registered() before the originate command,
        # so the mobile is confirmed registered before Asterisk's Dial() runs.
        #
        # Build the dial string from BOTH the base endpoint AND the device-specific
        # hint endpoint (if provided). Using both in parallel is more robust than
        # targeting only one: the base endpoint T{tenant}_{ext} covers desk phones
        # and any multi-device AOR configured in VitalPBX, while the hint endpoint
        # T{tenant}_{ext}_{device} covers the specific mobile/WebRTC registration.
        # This handles cases where the contacts output ordering is non-obvious and
        # prevents silent failures when only one endpoint type is registered.
        base_ep = "T" + tenant_id + "_" + extension
        hint_raw = str(body.get("pjsipEndpoint") or "").strip()
        if hint_raw.lower().startswith("pjsip/"):
            hint_raw = hint_raw[len("pjsip/"):]
        valid_ep_re = re.compile(r"^[A-Za-z0-9_.-]+$")
        tenant_prefix = "T" + tenant_id + "_" + extension
        if (hint_raw
                and valid_ep_re.match(hint_raw)
                and hint_raw.startswith(tenant_prefix)
                and hint_raw != base_ep):
            # Include both base endpoint and device-specific hint endpoint.
            # Asterisk's Dial() will ring whichever is currently registered.
            dispatch_endpoints = [base_ep, hint_raw]
        else:
            # No valid hint or hint equals base ??? just use the base endpoint.
            dispatch_endpoints = [base_ep]
        dispatch_dial_string = "&".join("PJSIP/" + ep for ep in dispatch_endpoints)
        astdb_key = "T" + tenant_id + "_" + extension
        try:
            subprocess.run(
                ["asterisk", "-rx", "database put connect_vm_dial " + astdb_key + " " + dispatch_dial_string],
                capture_output=True, timeout=10, check=False,
            )
        except Exception as exc:
            sys.stderr.write("astdb_put_failed: " + str(exc) + "\n")
        # Store the resolved VitalPBX voicemail context so the dialplan writes
        # to the correct spool path (e.g. test-voicemail/101/ not 21/101/).
        vm_context_for_astdb = resolve_voicemail_context_from_conf(tenant_id, extension)
        if vm_context_for_astdb:
            try:
                subprocess.run(
                    ["asterisk", "-rx", "database put connect_vm_context " + astdb_key + " " + vm_context_for_astdb],
                    capture_output=True, timeout=10, check=False,
                )
                sys.stderr.write("astdb_vm_context: key=%s context=%s\n" % (astdb_key, vm_context_for_astdb))
            except Exception as exc:
                sys.stderr.write("astdb_vm_context_put_failed: " + str(exc) + "\n")
        channel_source = "dispatch_local:" + ",".join(dispatch_endpoints)
        # Poll for the hint endpoint (typically the mobile device) to appear in
        # pjsip show contacts before originating. The API sends an FCM wake ~2s
        # before calling us; the mobile typically re-registers within 10???20s.
        # Polling here prevents Dial() from running against an empty contact list.
        # The dialplan Wait() is reduced to 5s (small buffer only) since the real
        # wait is now done here in Python before the originate command.
        poll_registered = False
        poll_elapsed_secs = 0.0
        if hint_raw and hint_raw != base_ep:
            t_poll_start = time.time()
            poll_registered = poll_pjsip_endpoint_registered(hint_raw, max_wait_secs=20, interval_secs=2)
            poll_elapsed_secs = round(time.time() - t_poll_start, 1)
            sys.stderr.write(
                "poll_pjsip_endpoint: endpoint=%s registered=%s elapsed=%.1fs\n"
                % (hint_raw, poll_registered, poll_elapsed_secs)
            )
        else:
            poll_registered = True
        # Phase B (2026-05-07): the prompt-before-answer race that the old
        # direct_pjsip override tried to dodge is now solved correctly inside
        # the dialplan. [connect-vm-greeting-dispatch] dials the AstDB-driven
        # fan-out string and uses Dial(...,U(connect-vm-greeting-record-sub^...))
        # which runs the recording flow as a Gosub on the answered party's
        # channel only AFTER pickup. We therefore keep the Local/dispatch
        # originate and never short-circuit to a single PJSIP endpoint.
        #
        # We still poll the mobile hint endpoint above purely as a diagnostic
        # signal (so the API can tell pre-deploy users that mobile re-registered
        # in time), but the originate channel and channel_source are unchanged.
        sys.stderr.write(
            "vm_record_call: dispatch_local fan-out preserved hint=%s base=%s poll_registered=%s\n"
            % (hint_raw or "", base_ep, poll_registered)
        )
    else:
        poll_registered = True
        poll_elapsed_secs = 0.0
        channel = endpoint_hint_channel(body, extension) or channel
        channel, channel_source = resolve_record_channel(channel, tenant_id, extension)
    if CFG.vm_record_app.lower() == "goto":
        target_descriptor = recording_exten + "@connect-vm-greeting-record"
        cmd_str = "channel originate " + channel + " extension " + target_descriptor
    else:
        target_descriptor = extension + "@" + tenant_id
        cmd_str = "channel originate " + channel + " application " + CFG.vm_record_app + " " + target_descriptor
    cmd = ["asterisk", "-rx", cmd_str]
    job = {"ok": True, "jobId": job_id, "tenantId": tenant_id, "extension": extension, "greetingType": greeting_type, "targetPath": str(target), "backupPath": str(backup) if backup else None, "status": "ringing", "callId": job_id, "createdAt": utc_now(), "channel": channel, "channelSource": channel_source, "asteriskCommand": cmd_str, "targetDescriptor": target_descriptor, "dispatchEndpoints": dispatch_endpoints, "dispatchDialString": dispatch_dial_string, "pollRegistered": poll_registered, "pollElapsedSecs": poll_elapsed_secs}
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

# ── media-sync trigger (2026-07-28) ─────────────────────────────────────────
# POST /media-sync: touch a trigger file in the helper's own state dir. A
# root-owned systemd .path unit (connect-media-sync.path) watches the file and
# runs /usr/local/sbin/connect-media-sync immediately — near-instant MOH (and
# later IVR) media sync without this unprivileged process needing root or
# asterisk-write access itself. The 5-minute cron stays as reconciliation.
MEDIA_SYNC_TRIGGER_PATH = Path(os.environ.get(
    "CONNECT_MEDIA_SYNC_TRIGGER",
    "/var/lib/connect-pbx-helper/media-sync.trigger",
))

# ---------------------------------------------------------------------------
# The MIRROR: create a tenant WITHOUT the panel (2026-08-19).
# The unlicensed VitalPBX panel refuses ONLY "create tenant"; every other panel
# path Connect uses (Apply Changes, CSV import, devices, ring groups, forwards,
# inbound routes, trunks) keeps working (clone rehearsal, handoff §11). So the
# helper writes the exact rows the panel writes for a new tenant — see
# mirror_writes.py::create_tenant beside this file, derived empirically from
# panel-made tenants — queues the base modules, creates the tenant's static /
# provisioning dirs, and lets the panel's own regenerator render the files at
# the very next Apply Changes (which Connect runs right after this call).
# ---------------------------------------------------------------------------
def _load_mirror_writes():
    import importlib
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    return importlib.import_module("mirror_writes")


def _load_console_writes():
    """The PBX Console's direct writes (phone provisioning + geo firewall).

    ⛔ These two are the ONLY operations the unlicensed panel refuses outright
    (20 phones / 1 country), so they write their rows here and then render with
    VitalPBX's OWN generator — never a re-implementation. Everything else the
    console does still goes through the panel. See console_writes.py."""
    import importlib
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    return importlib.import_module("console_writes")


def _console_conn():
    """Write connection for the console: the helper's own user, which the
    installer grants INSERT/UPDATE/DELETE on exactly two provisioning tables and
    UPDATE on ombu_geo_firewall — nothing wider."""
    return db_conn()


def console_phone_save(body):
    """Create or update one provisioned phone and render its config."""
    cw = _load_console_writes()
    conn = _console_conn()
    try:
        return cw.save_phone(
            conn,
            phone_id=(int(body["phoneId"]) if body.get("phoneId") else None),
            mac=body.get("mac"),
            tenant_id=require_num("tenantId", body.get("tenantId")),
            model_id=require_num("modelId", body.get("modelId")),
            template_id=(int(body["templateId"]) if body.get("templateId") else None),
            description=str(body.get("description") or ""),
            accounts=body.get("accounts"),
        )
    finally:
        conn.close()


def console_phone_delete(body):
    cw = _load_console_writes()
    conn = _console_conn()
    try:
        return cw.delete_phone(conn, require_num("phoneId", body.get("phoneId")))
    finally:
        conn.close()


def console_phone_render(body):
    """Re-render one phone's config from its current rows (no row change).
    ⛔ The config is a STATIC file — a row edited any other way leaves the
    handset on stale settings until this runs."""
    cw = _load_console_writes()
    conn = _console_conn()
    try:
        mac = cw.norm_mac(body.get("mac"))
        cw.remove_config(conn, mac, require_num("tenantId", body.get("tenantId")))
        return {"ok": True, "mac": mac, "rendered": cw.generate_config(mac)}
    finally:
        conn.close()


def console_geo_state(body):
    cw = _load_console_writes()
    conn = _console_conn()
    try:
        state = cw.geo_state(conn)
        state["whitelist"] = cw.whitelist_state(conn)
        # Which channel could actually run a rebuild right now: "direct", "sudo",
        # "unit" (the root connect-geo-build.path watcher) or None. Lets the
        # console show "geo writes are armed" without attempting one — the
        # probe ASKS and never runs the builder (see geo_build_available).
        runner = cw.geo_build_available()
        state["buildChannel"] = runner[0] if runner else None
        return state
    finally:
        conn.close()


def console_geo_set(body):
    """Block/unblock whole countries, then rebuild the firewall."""
    cw = _load_console_writes()
    conn = _console_conn()
    try:
        return cw.set_geo_blocks(conn, block=body.get("block") or [], unblock=body.get("unblock") or [])
    finally:
        conn.close()


def mirror_tenant_create(body):
    mw = _load_mirror_writes()
    description = str(body.get("description") or "").strip()
    name = str(body.get("name") or "").strip() or None
    if not description:
        raise ValueError("description required")
    if name and not re.fullmatch(r"[a-z0-9_]{1,255}", name):
        raise ValueError("name must be a slug (lowercase, digits, underscore)")
    dids = [re.sub(r"\D", "", str(d)) for d in (body.get("dids") or [])]
    dids = [d for d in dids if d]
    profiles = [int(x) for x in (body.get("outboundProfileIds") or []) if str(x).strip()]
    user_id = int(body.get("userId") or 45)
    conn = db_conn()
    try:
        plan = mw.create_tenant(conn, description, name=name, user_id=user_id, outbound_profile_ids=profiles,
                                dids=dids, queue_base_modules=True)
        ids = plan.execute(conn)  # ONE transaction; rollback on any failure
        with conn.cursor() as cur:
            cur.execute("SELECT tenant_id, name, path FROM ombu_tenants WHERE tenant_id=%s", (ids.get("tenant_id"),))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("tenant row not found after insert")
    fs = None
    try:
        fs = mw.apply_tenant_fs(row["path"])
    except Exception as exc:  # the dirs are created lazily by the panel too; report, never fail the tenant
        fs = {"error": str(exc)}
    # ⛔ THE CRUCIAL STEP ON PROD (VitalPBX 4.5.3-1): the panel's Apply Changes only does INCREMENTAL
    # regen — it will NOT do the FIRST generation of a tenant that has never been rendered (proven
    # live 2026-08-19: rows + panel Apply produced zero files; the byte-identical renderer produced
    # the full 17-file set and both endpoints loaded). So we render the baseline ourselves here.
    # Once the baseline exists, every later panel Apply (extensions, routes, edits) works normally —
    # which is why EXISTING tenants keep working unchanged after the licence lapses.
    render = None
    try:
        render = mw.render_and_install_pbx(_mirror_read_conn(), int(row["tenant_id"]))
    except Exception as exc:
        render = {"error": str(exc)}
    return {"ok": True, "tenantId": int(row["tenant_id"]), "name": row["name"], "path": row["path"],
            "rows": plan.rows_by_table(), "ids": {k: int(v) for k, v in ids.items()}, "fs": fs, "render": render}


def _mirror_read_conn():
    """A read connection for the renderer, which needs SELECT across the whole ombutel schema.
    Uses OMBU_MYSQL_RO_* if set (e.g. connect_read), else the helper's own user (grant it
    SELECT ON ombutel.* — the installer does)."""
    import pymysql
    host = os.environ.get("OMBU_MYSQL_RO_HOST") or CFG.mysql_host
    port = int(os.environ.get("OMBU_MYSQL_RO_PORT") or CFG.mysql_port or 3306)
    user = os.environ.get("OMBU_MYSQL_RO_USER") or CFG.mysql_user
    pw = os.environ.get("OMBU_MYSQL_RO_PASSWORD")
    if pw is None:
        pw = CFG.mysql_password
    db = os.environ.get("OMBU_MYSQL_RO_DB") or CFG.mysql_db
    kw = dict(user=user, password=pw, database=db, charset="utf8mb4",
              cursorclass=pymysql.cursors.DictCursor, autocommit=True)
    sock = os.environ.get("OMBU_MYSQL_RO_SOCKET") or CFG.mysql_socket
    if sock:
        return pymysql.connect(unix_socket=sock, **kw)
    return pymysql.connect(host=host, port=port, **kw)


def mirror_tenant_render(body):
    """Re-render an EXISTING tenant's files from its current DB rows (belt-and-braces after a build,
    or to repair a new tenant). Never touches other tenants."""
    mw = _load_mirror_writes()
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    res = mw.render_and_install_pbx(_mirror_read_conn(), int(tenant_id))
    return {"ok": True, "tenantId": int(tenant_id), "fileCount": res.get("fileCount"),
            "files": res.get("files"), "reloads": res.get("reloads")}


def media_sync_trigger(body):
    reason = str(body.get("reason") or "api")[:200]
    MEDIA_SYNC_TRIGGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with MEDIA_SYNC_TRIGGER_PATH.open("w") as fh:
        fh.write("%s %s\n" % (utc_now(), reason))
    return {"ok": True, "trigger": str(MEDIA_SYNC_TRIGGER_PATH), "reason": reason}

# ── M3/M4/M10 native config layer (2026-07-28) ──────────────────────────────
# Everything below writes VitalPBX's OWN ombu_* tables (the GUI's source of
# truth) and then triggers VitalPBX's OWN per-tenant regen (apply_changes REST
# call — the GUI "Apply Changes" button). Root cause this exists: destinations,
# IVR menus and queue members are baked into the generated conf; the previous
# apply (`dialplan reload`) alone can never surface a DB-only write.
#
# Destination model (verified live 2026-07-28):
#   ombu_destinations(id, category_id, module_id, `index`)
#   - category_id → ombu_destinations_category.id → module of the TARGET type
#   - module_id   → module that OWNS the destination row (inbound_routes=29,
#                   ivr=31, queues=21, ...)
#   - `index`     → PRIMARY KEY of the target row (extension_id, queue_id, ...)

DEST_TARGET_TYPES = {
    # type → (module name for category lookup, table, pk column, tenant column, label SQL)
    "extension": ("extensions", "ombu_extensions", "extension_id", "tenant_id", "CONCAT(extension, ' ', name)"),
    "queue": ("queues", "ombu_queues", "queue_id", "tenant_id", "CONCAT(extension, ' ', COALESCE(description,''))"),
    "ring_group": ("ring_group", "ombu_ring_groups", "ring_group_id", "tenant_id", "CONCAT(extension, ' ', COALESCE(description,''))"),
    "ivr": ("ivr", "ombu_ivrs", "ivr_id", "tenant_id", "COALESCE(description,'')"),
    "time_condition": ("time_conditions", "ombu_time_conditions", "time_condition_id", "tenant_id", "COALESCE(description,'')"),
    "custom_application": ("custom_app", "ombu_custom_applications", "custom_application_id", "tenant_id", "CONCAT(extension, ' ', COALESCE(description,''))"),
}
# custom_context (the Connect doorway) is bakeable but deliberately NOT in
# DEST_TARGET_TYPES: M3's tenant-scoped target validation must keep refusing
# it (doorway rows live on the main tenant, and agents must never point a
# route at an arbitrary custom context).
BAKEABLE_TARGET_TYPES = frozenset(DEST_TARGET_TYPES) | {"custom_context"}
# Verified live 2026-07-28: ombu_modules names are singular for these two.
OWNER_MODULE_INBOUND_ROUTE = "inbound_route"
OWNER_MODULE_IVR = "ivr"
IVR_OPTION_RE = re.compile(r"^(?:\d{1,2}|\*|#)$")

def _module_id_by_name(conn, name):
    with conn.cursor() as cur:
        cur.execute("SELECT module_id FROM ombu_modules WHERE name = %s", (name,))
        row = cur.fetchone()
    if not row:
        raise LookupError("module_not_found:%s" % name)
    return int(row["module_id"])

def _category_id_for_module(conn, module_name):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.id FROM ombu_destinations_category c
            JOIN ombu_modules m ON m.module_id = c.module_id
            WHERE m.name = %s
            """,
            (module_name,),
        )
        row = cur.fetchone()
    if not row:
        raise LookupError("destination_category_not_found:%s" % module_name)
    return int(row["id"])

def _verify_target(conn, tenant_id, target_type, target_id):
    """Target row must exist AND belong to this tenant. Returns a human label."""
    spec = DEST_TARGET_TYPES.get(target_type)
    if not spec:
        raise ValueError("unsupported_target_type:%s" % target_type)
    _, table, pk, tenant_col, label_sql = spec
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {label_sql} AS label FROM `{table}` WHERE `{pk}` = %s AND `{tenant_col}` = %s",
            (target_id, tenant_id),
        )
        row = cur.fetchone()
    if not row:
        raise LookupError("target_not_found_for_tenant:%s:%s" % (target_type, target_id))
    return str(row.get("label") or "").strip()

def _ensure_destination(conn, owner_module_name, target_type, target_id):
    """Find-or-create the ombu_destinations row for (owner, target). VitalPBX's
    GUI creates these lazily per owner+target pair; we mirror that exactly."""
    category_id = _category_id_for_module(conn, DEST_TARGET_TYPES[target_type][0])
    owner_module_id = _module_id_by_name(conn, owner_module_name)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM ombu_destinations WHERE category_id = %s AND module_id = %s AND `index` = %s LIMIT 1",
            (category_id, owner_module_id, str(target_id)),
        )
        row = cur.fetchone()
        if row:
            return int(row["id"]), False
        cur.execute(
            "INSERT INTO ombu_destinations (category_id, module_id, `index`) VALUES (%s, %s, %s)",
            (category_id, owner_module_id, str(target_id)),
        )
        return int(cur.lastrowid), True

def _decode_destination(conn, destination_id):
    """destination_id → {type, targetId, label} (best effort, read-only)."""
    if destination_id in (None, "", 0, "0"):
        return None
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT d.id, d.`index` AS idx, m.name AS target_module
            FROM ombu_destinations d
            JOIN ombu_destinations_category c ON c.id = d.category_id
            JOIN ombu_modules m ON m.module_id = c.module_id
            WHERE d.id = %s
            """,
            (destination_id,),
        )
        row = cur.fetchone()
    if not row:
        return {"destinationId": int(destination_id), "type": "unknown", "targetId": None, "label": None}
    module_to_type = {spec[0]: t for t, spec in DEST_TARGET_TYPES.items()}
    module_to_type["custom_contexts"] = "custom_context"
    ttype = module_to_type.get(str(row["target_module"]))
    if ttype == "custom_context":
        out = {"destinationId": int(row["id"]), "type": ttype, "targetId": str(row["idx"]), "label": None}
        with conn.cursor() as cur:
            cur.execute("SELECT description FROM ombu_custom_contexts WHERE cc_id = %s", (out["targetId"],))
            cc = cur.fetchone()
        if cc:
            out["label"] = str(cc.get("description") or "").strip()
        return out
    out = {"destinationId": int(row["id"]), "type": ttype or str(row["target_module"]), "targetId": str(row["idx"]), "label": None}
    if ttype:
        try:
            out["label"] = _verify_target_any_tenant(conn, ttype, out["targetId"])
        except Exception:
            pass
    return out

def _verify_target_any_tenant(conn, target_type, target_id):
    spec = DEST_TARGET_TYPES.get(target_type)
    if not spec:
        return None
    _, table, pk, _tenant_col, label_sql = spec
    with conn.cursor() as cur:
        cur.execute(f"SELECT {label_sql} AS label FROM `{table}` WHERE `{pk}` = %s", (target_id,))
        row = cur.fetchone()
    return str(row.get("label") or "").strip() if row else None

# ── M3 route bake ── VitalPBX's REST apply_changes returns success WITHOUT
# regenerating the tenant conf on this build (verified live 2026-07-28: pending
# flags consumed, file mtime unchanged, GUI Apply works). Until VitalPBX fixes
# the API, bake the route's Goto line directly into the generated dialplan —
# same guarded pattern as the MOH patcher (backup + line-scope check + atomic
# replace) — then dialplan reload. If a future VitalPBX build makes the REST
# apply actually regen, the patcher simply finds the Goto already converged.
# Goto formats verified against live generated confs across tenants:
#   extension/custom_app → Goto(T<t>_cos-all,<ext>,1)
#   queue                → Goto(T<t>_ext-queues,<ext>,1)
#   ring_group           → Goto(T<t>_ext-ringgroups,<ext>,1)
#   ivr                  → Goto(T<t>_app-ivr,IVR-<id>,1)
#   time_condition       → Goto(T<t>_app-time-condition,TC-<id>,1)

def _goto_target_for(conn, tenant_id, target_type, target_id):
    t = int(tenant_id)
    if target_type in ("extension", "queue", "ring_group", "custom_application"):
        _, table, pk, tenant_col, _ = DEST_TARGET_TYPES[target_type]
        with conn.cursor() as cur:
            cur.execute(f"SELECT extension FROM `{table}` WHERE `{pk}` = %s AND `{tenant_col}` = %s", (target_id, tenant_id))
            row = cur.fetchone()
        if not row:
            raise LookupError("bake_target_not_found:%s:%s" % (target_type, target_id))
        ext = str(row["extension"]).strip()
        ctx = {"extension": "T%d_cos-all", "custom_application": "T%d_cos-all",
               "queue": "T%d_ext-queues", "ring_group": "T%d_ext-ringgroups"}[target_type] % t
        return "%s,%s,1" % (ctx, ext)
    if target_type == "ivr":
        return "T%d_app-ivr,IVR-%s,1" % (t, int(target_id))
    if target_type == "time_condition":
        return "T%d_app-time-condition,TC-%s,1" % (t, int(target_id))
    if target_type == "custom_context":
        # The Goto triple IS the custom-context row (doorway rows are
        # (connect-doorway, s, 1) on the main tenant — not tenant-scoped).
        with conn.cursor() as cur:
            cur.execute("SELECT context, extension, priority FROM ombu_custom_contexts WHERE cc_id = %s", (target_id,))
            row = cur.fetchone()
        if not row:
            raise LookupError("bake_target_not_found:custom_context:%s" % target_id)
        return "%s,%s,%s" % (str(row["context"]), str(row["extension"] or "s"), str(row["priority"] or "1"))
    raise ValueError("unsupported_bake_target:%s" % target_type)

def _patch_route_goto_text(text, did_digits, goto_target):
    """Pure text transform: inside every `exten => _<did>[/...],1,NoOp(INBOUND_ROUTE:`
    block, replace the single `same => n,Goto(...)` line. Refuses ambiguous blocks."""
    header_re = re.compile(r"^exten => _?%s(?:/[^,]*)?,1,NoOp\(INBOUND_ROUTE:" % re.escape(str(did_digits)))
    goto_re = re.compile(r"^(\s*)same => n,Goto\(([^)]*)\)\s*$")
    lines = text.splitlines()
    out = list(lines)
    changed = 0
    old = []
    i = 0
    while i < len(lines):
        if header_re.match(lines[i]):
            block_gotos = []
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith("same =>"):
                m = goto_re.match(lines[j])
                if m:
                    block_gotos.append((j, m.group(1), m.group(2)))
                j += 1
            if len(block_gotos) != 1:
                return {"changed": 0, "newText": text, "old": [], "error": "route_block_goto_ambiguous:%d" % len(block_gotos)}
            idx, indent, current = block_gotos[0]
            if current != goto_target:
                out[idx] = "%ssame => n,Goto(%s)" % (indent, goto_target)
                old.append(current)
                changed += 1
            i = j
        else:
            i += 1
    new_text = "\n".join(out) + ("\n" if text.endswith("\n") else "")
    return {"changed": changed, "newText": new_text, "old": old, "error": None if changed or not old else None}

def read_rendered_route_gotos(tenant_id, did_digits):
    """READ-ONLY: the Goto target(s) actually rendered for this DID in the
    generated tenant dialplan — i.e. WHAT CALLERS FOLLOW.

    ⛔ This, not ombu_inbound_routes.destination_id, is the ground truth for
    "where does this number go". Proven live 2026-08-06: A plus center's route
    row said destination 903 (the Connect doorway) while the regenerated file
    said Goto(T2_app-ivr,IVR-1,1) and every caller reached the old PBX menu.
    VitalPBX's own regenerator does NOT render a Connect doorway destination —
    our bake is the only thing that does — so ANY regen (panel Save/Apply,
    another tool, a tenant edit) silently reverts a live number to the PBX.
    Anything that verifies routing MUST read this."""
    out = {"file": None, "gotos": [], "error": None}
    try:
        conf = Path(QUEUE_CONF_DIR) / ("extensions__50-%d-dialplan.conf" % int(tenant_id))
        out["file"] = str(conf)
        if not conf.is_file():
            out["error"] = "dialplan_conf_missing"
            return out
        header_re = re.compile(r"^exten => _?%s(?:/[^,]*)?,1,NoOp\(INBOUND_ROUTE:" % re.escape(str(did_digits)))
        goto_re = re.compile(r"^\s*same => n,Goto\(([^)]*)\)\s*$")
        lines = conf.read_text(errors="replace").splitlines()
        i = 0
        while i < len(lines):
            if header_re.match(lines[i]):
                j = i + 1
                while j < len(lines) and lines[j].strip().startswith("same =>"):
                    m = goto_re.match(lines[j])
                    if m:
                        out["gotos"].append(m.group(1))
                    j += 1
                i = j
            else:
                i += 1
    except OSError as exc:
        out["error"] = "read_failed: %s" % exc
    return out


def rebake_route(body):
    """Re-apply the baked Goto for a DID from its CURRENT DB destination.

    The repair half of the render-drift problem documented on
    read_rendered_route_gotos: the DB is right, the rendered file is wrong,
    and nothing about the DB needs changing. Touches ONLY the generated
    dialplan (same guarded patcher as every other bake: backup, line-scope
    check, atomic replace, dialplan reload) and NEVER the route row, the
    snapshot, or Connect-side state — so it cannot desync anything and is
    safe to run on a timer. Idempotent: already-converged renders report
    changed=0 and rewrite nothing."""
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    with db_conn() as conn:
        route = find_route(conn, tenant_id, did_digits)
        dest = str(route.get("destination_id") or "")
        decoded = _decode_destination(conn, dest)
        # Is this route one CONNECT owns? Our snapshot answers that — the PBX's
        # destination semantics cannot be trusted (2026-08-06 hijack).
        connect_owned = _route_is_connect_mode(route.get("inbound_route_id"), dest)
        doorway_goto = _doorway_goto(conn) if connect_owned else None
    before = read_rendered_route_gotos(tenant_id, did_digits)
    if connect_owned:
        bake = _bake_goto(tenant_id, did_digits, doorway_goto)
        if bake.get("error"):
            raise RuntimeError("route_bake_failed:%s" % bake["error"])
        return {
            "ok": True, "did": did_e164, "tenantId": tenant_id, "destinationId": dest,
            "connectOwned": True, "goto": doorway_goto, "baked": True,
            "changed": int(bake.get("changed") or 0), "bake": bake,
            "before": before, "after": read_rendered_route_gotos(tenant_id, did_digits),
        }
    if not decoded or decoded.get("type") not in BAKEABLE_TARGET_TYPES or not decoded.get("targetId"):
        return {
            "ok": True, "did": did_e164, "tenantId": tenant_id, "destinationId": dest,
            "decoded": decoded, "baked": False, "reason": "destination_not_bakeable",
            "before": before, "after": before,
        }
    bake = bake_route_goto(tenant_id, did_digits, decoded["type"], decoded["targetId"])
    if bake.get("error"):
        raise RuntimeError("route_bake_failed:%s" % bake["error"])
    after = read_rendered_route_gotos(tenant_id, did_digits)
    return {
        "ok": True, "did": did_e164, "tenantId": tenant_id, "destinationId": dest,
        "decoded": decoded, "baked": True, "changed": int(bake.get("changed") or 0),
        "bake": bake, "before": before, "after": after,
    }


def bake_route_goto(tenant_id, did_digits, target_type, target_id):
    """Bake the Goto for a NATIVE destination (type+id decoded from the DB)."""
    try:
        with db_conn() as conn:
            goto = _goto_target_for(conn, int(tenant_id), target_type, target_id)
    except Exception as exc:
        return {"attempted": False, "changed": 0, "goto": None, "file": None, "backup": None,
                "old": [], "reload": None, "error": "bake_failed: %s" % exc}
    return _bake_goto(tenant_id, did_digits, goto)


def _bake_goto(tenant_id, did_digits, goto):
    """Write an EXPLICIT Goto target into the generated tenant dialplan.

    Split out from bake_route_goto on 2026-08-06 so the doorway can be baked
    as a CONSTANT. Deriving it by decoding ombu_destinations is exactly how the
    hijack (see _find_doorway_rows) turned a Connect-owned number back into a
    PBX IVR — and how the first re-bake attempt cheerfully re-baked the wrong
    target. Connect-owned routes bake `connect-doorway,s,1`, full stop."""
    evidence = {"attempted": False, "changed": 0, "goto": goto, "file": None, "backup": None, "old": [], "reload": None, "error": None}
    try:
        t = int(tenant_id)
        conf = Path(QUEUE_CONF_DIR) / ("extensions__50-%d-dialplan.conf" % t)
        evidence["file"] = str(conf)
        if not conf.is_file():
            evidence["error"] = "dialplan_conf_missing"
            return evidence
        evidence["attempted"] = True
        original = conf.read_text(errors="replace")
        res = _patch_route_goto_text(original, did_digits, goto)
        evidence["old"] = res["old"]
        if res.get("error"):
            evidence["error"] = res["error"]
            return evidence
        if res["changed"] == 0:
            return evidence  # already converged (regen worked, or same destination)
        orig_lines = original.splitlines()
        new_lines = res["newText"].splitlines()
        if len(orig_lines) != len(new_lines):
            evidence["error"] = "patch_line_count_mismatch"
            return evidence
        diff_idx = [i for i, (a, b) in enumerate(zip(orig_lines, new_lines)) if a != b]
        if len(diff_idx) != res["changed"] or any("Goto(" not in orig_lines[i] for i in diff_idx):
            evidence["error"] = "patch_scope_violation"
            return evidence
        backup_dir = Path(QUEUE_BACKUP_DIR)
        backup_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        backup = backup_dir / ("%s.%s.bak" % (conf.name, dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
        st = os.stat(conf)
        backup.write_text(original)
        evidence["backup"] = str(backup)
        tmp = conf.with_name(conf.name + ".connect-tmp")
        tmp.write_text(res["newText"])
        os.chmod(tmp, st.st_mode & 0o777)
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except PermissionError:
            pass
        os.replace(tmp, conf)
        evidence["ownership"] = _chown_gui_conf(conf)
        evidence["changed"] = res["changed"]
        evidence["reload"] = run_apply_command('asterisk -rx "dialplan reload"')
        if evidence["reload"]["exitCode"] != 0:
            evidence["error"] = "dialplan_reload_failed"
    except Exception as exc:
        evidence["error"] = "bake_failed: %s" % exc
    return evidence

def _mark_pending_changes(tenant_id, module_names):
    """VitalPBX's apply_changes only regenerates modules queued in
    ombu_queued_changes plus the (per-tenant-prefixed) reload_dialplan setting —
    the GUI stamps both on every Save. Our direct DB writes bypass that
    bookkeeping, so stamp it ourselves or apply_changes regenerates nothing
    (verified live 2026-07-28: apply returned success while the generated conf
    stayed stale)."""
    marked = {"modules": [], "dialplan": None}
    with db_conn() as conn:
        try:
            with conn.cursor() as cur:
                for name in module_names:
                    try:
                        mid = _module_id_by_name(conn, name)
                    except LookupError:
                        marked["modules"].append({"name": name, "error": "module_not_found"})
                        continue
                    cur.execute(
                        "INSERT IGNORE INTO ombu_queued_changes (tenant_id, module_id) VALUES (%s, %s)",
                        (tenant_id, mid),
                    )
                    marked["modules"].append({"name": name, "moduleId": mid})
                cur.execute("SELECT prefix FROM ombu_tenants WHERE tenant_id = %s", (tenant_id,))
                row = cur.fetchone()
                prefix = str(row["prefix"] or "") if row else ""
                setting_name = (prefix + "reload_dialplan") if prefix else "reload_dialplan"
                cur.execute("UPDATE ombu_settings SET value = 'yes' WHERE name = %s", (setting_name,))
                marked["dialplan"] = {"setting": setting_name, "updated": cur.rowcount}
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return marked

def apply_tenant_changes(tenant_id, extra_reloads=(), pending_modules=()):
    """Official VitalPBX per-tenant regen (same as GUI Apply Changes):
    UPDATE /api/v2/tenants/<id>/apply_changes with the provisioned app-key
    (custom HTTP verb — PUT returns 501 "Invalid Operation", verified live).
    Falls back to the legacy apply command when no key is configured (which
    only reloads — sufficient for nothing baked, so log loudly)."""
    if not CFG.vitalpbx_api_key:
        legacy = apply_changes()
        legacy["mode"] = "legacy_no_api_key"
        return legacy
    pending = _mark_pending_changes(tenant_id, pending_modules) if pending_modules else None
    url = "%s/api/v2/tenants/%s/apply_changes" % (CFG.vitalpbx_api_url.rstrip("/"), tenant_id)
    req = urllib.request.Request(
        url,
        method="UPDATE",
        data=b"{}",
        headers={"app-key": CFG.vitalpbx_api_key, "content-type": "application/json", "accept": "application/json"},
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=CFG.apply_changes_timeout, context=ctx) as resp:
            status = resp.status
            body_text = resp.read(4000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        body_text = (exc.read(4000) or b"").decode("utf-8", "replace")
    result = {
        "mode": "vitalpbx_apply_changes",
        "ran": True,
        "httpStatus": status,
        "elapsedMs": int((time.time() - start) * 1000),
        "body": body_text[:2000],
        "pending": pending,
    }
    if status not in (200, 201, 202, 204):
        raise RuntimeError("apply_changes_failed_http_%s %s" % (status, body_text[:300]))
    extras = [run_apply_command(c) for c in extra_reloads]
    if extras:
        result["extraReloads"] = extras
    # The regen just rewrote the tenant conf files as asterisk:asterisk; hand
    # them back to the GUI (www-data:www-data 0644) or every subsequent panel
    # Save/Apply for this tenant dies on Permission denied. Runs BEFORE the
    # MOH re-apply below so those patch writers inherit the fixed ownership.
    result["guiOwnership"] = restore_gui_conf_ownership(tenant_id)
    # A regen rewrites the tenant dialplan + queue conf from the ombu DB. If the
    # tenant is currently on a Connect-uploaded MOH class (connect_*), that class
    # exists only in the patched text + AstDB — re-apply it or callers fall back
    # to native music until the next M1 action.
    result["mohReapply"] = reapply_moh_patches_after_regen(tenant_id)
    return result

def reapply_moh_patches_after_regen(tenant_id):
    out = {"attempted": False, "class": None, "queuePatch": None, "dialplanPatch": None, "error": None}
    try:
        with db_conn() as conn:
            path = resolve_tenant_path(conn, tenant_id)
            if not path:
                return out
            with conn.cursor() as cur:
                cur.execute("SELECT extension FROM ombu_extensions WHERE tenant_id = %s ORDER BY extension LIMIT 1", (tenant_id,))
                row = cur.fetchone()
        ext = str((row or {}).get("extension") or "").strip()
        cls = _astdb_get("%s/extensions/%s" % (path, ext), "moh") if ext else ""
        if not re.match(r"^connect_[A-Za-z0-9_]+$", cls or ""):
            return out
        out["attempted"] = True
        out["class"] = cls
        out["queuePatch"] = patch_tenant_queue_musicclass(tenant_id, 1, target_class=cls)
        out["dialplanPatch"] = patch_tenant_dialplan_moh(tenant_id, 1, target_class=cls)
        run_apply_command('asterisk -rx "dialplan reload"')
        run_apply_command('asterisk -rx "queue reload all"')
        return out
    except Exception as exc:
        out["error"] = str(exc)
        return out

def tenant_catalog(body):
    """READ-ONLY one-stop inventory for a tenant: everything the agent needs to
    resolve names → IDs, answer diagnostics, and ground its LLM extraction."""
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    out = {"ok": True, "tenantId": tenant_id}
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT extension_id, extension, name FROM ombu_extensions WHERE tenant_id = %s ORDER BY extension", (tenant_id,))
            out["extensions"] = [{"id": int(r["extension_id"]), "extension": str(r["extension"]), "name": str(r["name"] or "")} for r in cur.fetchall()]
            cur.execute(
                "SELECT queue_id, extension, description, strategy, music_group_id, announcement_id, periodic_announcement_id, join_announcement_id FROM ombu_queues WHERE tenant_id = %s ORDER BY extension",
                (tenant_id,),
            )
            queues = cur.fetchall()
            cur.execute(
                """
                SELECT qm.queue_member_id, qm.queue_id, qm.extension_id, qm.penalty, qm.type, e.extension, e.name
                FROM ombu_queue_members qm JOIN ombu_extensions e ON e.extension_id = qm.extension_id
                WHERE qm.queue_id IN (SELECT queue_id FROM ombu_queues WHERE tenant_id = %s)
                """,
                (tenant_id,),
            )
            members_by_queue = {}
            for r in cur.fetchall():
                members_by_queue.setdefault(int(r["queue_id"]), []).append(
                    {
                        "memberId": int(r["queue_member_id"]),
                        "extensionId": int(r["extension_id"]),
                        "extension": str(r["extension"]),
                        "name": str(r["name"] or ""),
                        "penalty": int(r["penalty"]),
                        "type": str(r["type"]),
                    }
                )
            out["queues"] = [
                {
                    "id": int(q["queue_id"]),
                    "extension": str(q["extension"]),
                    "description": str(q["description"] or ""),
                    "strategy": str(q["strategy"] or ""),
                    "musicGroupId": int(q["music_group_id"]) if q["music_group_id"] is not None else None,
                    "announcementId": int(q["announcement_id"]) if q["announcement_id"] is not None else None,
                    "periodicAnnouncementId": int(q["periodic_announcement_id"]) if q["periodic_announcement_id"] is not None else None,
                    "joinAnnouncementId": int(q["join_announcement_id"]) if q["join_announcement_id"] is not None else None,
                    "members": members_by_queue.get(int(q["queue_id"]), []),
                }
                for q in queues
            ]
            cur.execute("SELECT ring_group_id, extension, description FROM ombu_ring_groups WHERE tenant_id = %s ORDER BY extension", (tenant_id,))
            out["ringGroups"] = [{"id": int(r["ring_group_id"]), "extension": str(r["extension"]), "description": str(r["description"] or "")} for r in cur.fetchall()]
            cur.execute("SELECT ivr_id, description, welcome_msg_id, timeout, invalid_destination_id, timeout_destination_id FROM ombu_ivrs WHERE tenant_id = %s ORDER BY ivr_id", (tenant_id,))
            ivrs = cur.fetchall()
            cur.execute(
                "SELECT id, ivr_id, `option`, destination_id, enabled, sort FROM ombu_ivr_entries WHERE ivr_id IN (SELECT ivr_id FROM ombu_ivrs WHERE tenant_id = %s) ORDER BY ivr_id, sort",
                (tenant_id,),
            )
            entries_by_ivr = {}
            for r in cur.fetchall():
                entries_by_ivr.setdefault(int(r["ivr_id"]), []).append(
                    {
                        "entryId": int(r["id"]),
                        "option": str(r["option"] or ""),
                        "destinationId": int(r["destination_id"]) if r["destination_id"] is not None else None,
                        "enabled": str(r["enabled"]),
                    }
                )
            cur.execute("SELECT recording_id, name, duration FROM ombu_recordings WHERE tenant_id = %s ORDER BY recording_id", (tenant_id,))
            out["recordings"] = [{"id": int(r["recording_id"]), "name": str(r["name"] or ""), "durationSec": int(r["duration"] or 0)} for r in cur.fetchall()]
            cur.execute("SELECT time_condition_id, description, code FROM ombu_time_conditions WHERE tenant_id = %s ORDER BY time_condition_id", (tenant_id,))
            out["timeConditions"] = [{"id": int(r["time_condition_id"]), "description": str(r["description"] or ""), "code": str(r["code"] or "")} for r in cur.fetchall()]
            cur.execute("SELECT custom_application_id, extension, description FROM ombu_custom_applications WHERE tenant_id = %s ORDER BY extension", (tenant_id,))
            out["customApplications"] = [{"id": int(r["custom_application_id"]), "extension": str(r["extension"]), "description": str(r["description"] or "")} for r in cur.fetchall()]
            cur.execute("SELECT inbound_route_id, did, description, destination_id FROM ombu_inbound_routes WHERE tenant_id = %s AND did IS NOT NULL AND did != '' ORDER BY did", (tenant_id,))
            routes = cur.fetchall()
        out["ivrs"] = []
        for ivr in ivrs:
            rec_name = None
            if ivr["welcome_msg_id"] is not None:
                rec_name = next((r["name"] for r in out["recordings"] if r["id"] == int(ivr["welcome_msg_id"])), None)
            entries = entries_by_ivr.get(int(ivr["ivr_id"]), [])
            for e in entries:
                e["target"] = _decode_destination(conn, e["destinationId"]) if e["destinationId"] else None
            out["ivrs"].append(
                {
                    "id": int(ivr["ivr_id"]),
                    "description": str(ivr["description"] or ""),
                    "welcomeRecordingId": int(ivr["welcome_msg_id"]) if ivr["welcome_msg_id"] is not None else None,
                    "welcomeRecordingName": rec_name,
                    "timeoutSec": int(ivr["timeout"]) if ivr["timeout"] is not None else None,
                    "entries": entries,
                }
            )
        out["routes"] = [
            {
                "routeId": int(r["inbound_route_id"]),
                "did": str(r["did"]),
                "description": str(r["description"] or ""),
                "destinationId": int(r["destination_id"]) if r["destination_id"] is not None else None,
                "target": _decode_destination(conn, r["destination_id"]) if r["destination_id"] is not None else None,
            }
            for r in routes
        ]
    return out

# ── IVR migration mapping ── READ-ONLY. Produces the complete call-flow graph
# for a tenant (or every tenant) so Connect can rebuild an existing VitalPBX
# menu inside the IVR Studio without anyone retyping it.
#
# `tenant_catalog` above is deliberately NOT reused: it is the agent's
# name→id resolver and returns only the fields the agent grounds on. A
# migration needs the parts it omits — the retry/timeout/invalid prompt ids
# and their fall-through destinations, the time-condition match/mismatch
# branches, the weekly schedule strings behind each time group, and the
# on-disk path of every recording. Widening tenant_catalog to carry all of
# that would change the payload the agent already depends on, so this is a
# separate read.
#
# Recording files: VitalPBX stores each recording at
#   /var/lib/vitalpbx/static/<tenant.path>/recordings/<md5(recording_id)>
# with NO extension (Asterisk picks the format). Verified live 2026-08-03
# against tenant 2's generated dialplan:
#   BackGround(/var/lib/vitalpbx/static/f3df739ac62197cd/recordings/
#              c81e728d9d4c2f636f067f89cc14862c)   # md5("2"), welcome_msg_id=2
# The path is reported, never opened — the caller decides what to do with it.

def _rec_static_path(tenant_path, recording_id):
    """On-disk path of a VitalPBX recording. Returns None when unknowable.
    2026-08-06: this build stores <md5>.wav (extension INCLUDED) — the older
    extensionless form still exists in the wild. Report whichever is actually
    on disk, falling back to the bare path when neither is (A plus go-live
    debugging chased the wrong path because of the missing .wav)."""
    if not tenant_path or recording_id in (None, "", 0, "0"):
        return None
    digest = hashlib.md5(str(int(recording_id)).encode("utf-8")).hexdigest()
    base = "%s/%s/recordings/%s" % (str(CFG.static_dir).rstrip("/"), tenant_path, digest)
    for cand in (base + ".wav", base):
        try:
            if os.path.isfile(cand):
                return cand
        except OSError:
            pass
    return base


def recording_export(body):
    """Copy native VitalPBX recordings into the Connect prompt sounds dir
    under stable caller-supplied names — the missing half of an IVR menu
    migration (menus copied fine; their audio never left VitalPBX's private
    static tree, so every migrated menu greeted callers with the generic
    fallback). Per-item results, never all-or-nothing: one bad recording must
    not block the rest of a go-live. Only tenant-owned recordings, only
    shape-checked target names, only real RIFF/WAVE sources copied verbatim —
    anything else is reported, not guessed at. Idempotent: re-copy overwrites."""
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    items = body.get("recordings") or []
    if not isinstance(items, list) or not items:
        raise ValueError("recordings_required")
    if len(items) > 100:
        raise ValueError("too_many_recordings")
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT path FROM ombu_tenants WHERE tenant_id = %s", (tenant_id,))
            row = cur.fetchone()
        tenant_path = str((row or {}).get("path") or "").strip()
        if not tenant_path:
            raise LookupError("tenant_path_not_found")
        with conn.cursor() as cur:
            cur.execute("SELECT recording_id FROM ombu_recordings WHERE tenant_id = %s", (tenant_id,))
            owned = {int(r["recording_id"]) for r in cur.fetchall()}
    base_re = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,118}$")
    src_dir = Path(str(CFG.static_dir).rstrip("/")) / tenant_path / "recordings"
    results = []
    for item in items:
        rid = _nullable_int((item or {}).get("recordingId"))
        target = str((item or {}).get("targetBase") or "").strip()
        out = {"recordingId": rid, "targetBase": target, "copied": False, "error": None}
        results.append(out)
        if rid is None or not base_re.match(target):
            out["error"] = "invalid_item"
            continue
        if rid not in owned:
            out["error"] = "recording_not_owned_by_tenant"
            continue
        digest = hashlib.md5(str(rid).encode("utf-8")).hexdigest()
        src = None
        for cand in (src_dir / (digest + ".wav"), src_dir / digest):
            if cand.is_file():
                src = cand
                break
        if src is None:
            out["error"] = "source_file_missing"
            continue
        try:
            with src.open("rb") as fh:
                head = fh.read(4)
        except OSError as exc:
            out["error"] = "source_unreadable: %s" % exc
            continue
        if head != b"RIFF":
            out["error"] = "source_not_wav"
            continue
        dst = Path(CFG.sounds_dir) / (target + ".wav")
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            os.chmod(dst, 0o644)
            try:
                uid = pwd.getpwnam(CFG.sounds_owner_user).pw_uid
                gid = grp.getgrnam(CFG.sounds_owner_group).gr_gid
                os.chown(dst, uid, gid)
            except (KeyError, PermissionError):
                pass
            out["copied"] = True
            out["file"] = str(dst)
            out["bytes"] = int(dst.stat().st_size)
        except OSError as exc:
            out["error"] = "copy_failed: %s" % exc
    return {
        "ok": True,
        "tenantId": tenant_id,
        "soundsDir": str(CFG.sounds_dir),
        "copiedCount": sum(1 for r in results if r["copied"]),
        "results": results,
    }

def _nullable_int(value):
    if value in (None, "", 0, "0"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

def _flow_map_for_tenant(conn, tenant_row):
    tenant_id = int(tenant_row["tenant_id"])
    tenant_path = str(tenant_row.get("path") or "").strip()
    out = {
        "tenantId": tenant_id,
        "tenantSlug": str(tenant_row.get("name") or ""),
        "tenantName": str(tenant_row.get("description") or tenant_row.get("name") or ""),
        # The 16-char path hash. The panel switches tenant purely by setting
        # the `vpbx_tenant` cookie to this, so anything automating the panel
        # (creating ring groups / queues) needs it and cannot derive it from
        # the numeric tenant id.
        "tenantPath": tenant_path,
        "enabled": str(tenant_row.get("enabled") or "yes") == "yes",
    }

    with conn.cursor() as cur:
        cur.execute(
            "SELECT recording_id, name, original_filename, duration FROM ombu_recordings WHERE tenant_id = %s ORDER BY recording_id",
            (tenant_id,),
        )
        recordings = [
            {
                "id": int(r["recording_id"]),
                "name": str(r["name"] or ""),
                "originalFilename": str(r["original_filename"] or ""),
                "durationSec": int(r["duration"] or 0),
                "staticPath": _rec_static_path(tenant_path, r["recording_id"]),
            }
            for r in cur.fetchall()
        ]
        rec_by_id = {r["id"]: r for r in recordings}

        def rec_ref(recording_id):
            rid = _nullable_int(recording_id)
            if rid is None:
                return None
            row = rec_by_id.get(rid)
            return {
                "id": rid,
                "name": row["name"] if row else None,
                "staticPath": row["staticPath"] if row else _rec_static_path(tenant_path, rid),
                "durationSec": row["durationSec"] if row else None,
                "known": row is not None,
            }

        cur.execute(
            """
            SELECT ivr_id, description, welcome_msg_id, instructions_msg_id, freedial,
                   invalid_tries, invalid_retry_msg_id, invalid_destination_id, invalid_msg_id,
                   timeout, timeout_msg_id, timeout_retry_msg_id, timeout_destination_id, timeout_tries
            FROM ombu_ivrs WHERE tenant_id = %s ORDER BY ivr_id
            """,
            (tenant_id,),
        )
        ivr_rows = cur.fetchall()

        cur.execute(
            "SELECT id, ivr_id, `option`, destination_id, enabled, sort FROM ombu_ivr_entries "
            "WHERE ivr_id IN (SELECT ivr_id FROM ombu_ivrs WHERE tenant_id = %s) ORDER BY ivr_id, sort",
            (tenant_id,),
        )
        entries_by_ivr = {}
        for r in cur.fetchall():
            entries_by_ivr.setdefault(int(r["ivr_id"]), []).append(r)

        cur.execute(
            """
            SELECT time_condition_id, code, description, time_group_id, timezone, status,
                   match_destination_id, mismatch_destination_id
            FROM ombu_time_conditions WHERE tenant_id = %s ORDER BY time_condition_id
            """,
            (tenant_id,),
        )
        tc_rows = cur.fetchall()

        cur.execute("SELECT time_group_id, description FROM ombu_time_groups WHERE tenant_id = %s ORDER BY time_group_id", (tenant_id,))
        tg_rows = cur.fetchall()
        cur.execute(
            "SELECT time_group_id, `time`, sort FROM ombu_time_groups_schedules "
            "WHERE time_group_id IN (SELECT time_group_id FROM ombu_time_groups WHERE tenant_id = %s) ORDER BY time_group_id, sort",
            (tenant_id,),
        )
        sched_by_group = {}
        for r in cur.fetchall():
            sched_by_group.setdefault(int(r["time_group_id"]), []).append(str(r["time"] or ""))

        cur.execute(
            "SELECT inbound_route_id, did, description, destination_id FROM ombu_inbound_routes "
            "WHERE tenant_id = %s AND did IS NOT NULL AND did != '' ORDER BY did",
            (tenant_id,),
        )
        route_rows = cur.fetchall()

        # Directory: row-id → dialable number. _decode_destination reports the
        # ROW id (extension_id / queue_id / ring_group_id), but a Connect
        # destination ref needs the NUMBER you would dial. Its `label` happens
        # to start with that number today, but parsing a display string to
        # build live call routing is exactly the kind of guess that silently
        # misroutes calls, so resolve it properly here.
        cur.execute("SELECT extension_id, extension, name FROM ombu_extensions WHERE tenant_id = %s ORDER BY extension", (tenant_id,))
        directory_extensions = [
            {"id": int(r["extension_id"]), "number": str(r["extension"]), "name": str(r["name"] or "")}
            for r in cur.fetchall()
        ]
        cur.execute("SELECT queue_id, extension, description FROM ombu_queues WHERE tenant_id = %s ORDER BY extension", (tenant_id,))
        directory_queues = [
            {"id": int(r["queue_id"]), "number": str(r["extension"]), "name": str(r["description"] or "")}
            for r in cur.fetchall()
        ]
        cur.execute("SELECT ring_group_id, extension, description FROM ombu_ring_groups WHERE tenant_id = %s ORDER BY extension", (tenant_id,))
        directory_ring_groups = [
            {"id": int(r["ring_group_id"]), "number": str(r["extension"]), "name": str(r["description"] or "")}
            for r in cur.fetchall()
        ]
        cur.execute(
            "SELECT custom_application_id, extension, description FROM ombu_custom_applications WHERE tenant_id = %s ORDER BY extension",
            (tenant_id,),
        )
        directory_custom_apps = [
            {"id": int(r["custom_application_id"]), "number": str(r["extension"]), "name": str(r["description"] or "")}
            for r in cur.fetchall()
        ]

    out["directory"] = {
        "extensions": directory_extensions,
        "queues": directory_queues,
        "ringGroups": directory_ring_groups,
        "customApplications": directory_custom_apps,
    }
    out["recordings"] = recordings
    out["ivrs"] = [
        {
            "id": int(v["ivr_id"]),
            "description": str(v["description"] or ""),
            "directDialEnabled": str(v["freedial"] or "no") == "yes",
            "welcome": rec_ref(v["welcome_msg_id"]),
            "instructions": rec_ref(v["instructions_msg_id"]),
            "timeoutSec": _nullable_int(v["timeout"]),
            "timeoutTries": _nullable_int(v["timeout_tries"]),
            "timeoutPrompt": rec_ref(v["timeout_msg_id"]),
            "timeoutRetryPrompt": rec_ref(v["timeout_retry_msg_id"]),
            "timeoutTarget": _decode_destination(conn, v["timeout_destination_id"]),
            "invalidTries": _nullable_int(v["invalid_tries"]),
            "invalidPrompt": rec_ref(v["invalid_msg_id"]),
            "invalidRetryPrompt": rec_ref(v["invalid_retry_msg_id"]),
            "invalidTarget": _decode_destination(conn, v["invalid_destination_id"]),
            "options": [
                {
                    "entryId": int(e["id"]),
                    "digit": str(e["option"] or ""),
                    "enabled": str(e["enabled"] or "yes") == "yes",
                    "sort": _nullable_int(e["sort"]),
                    "target": _decode_destination(conn, e["destination_id"]),
                }
                for e in entries_by_ivr.get(int(v["ivr_id"]), [])
            ],
        }
        for v in ivr_rows
    ]

    tg_by_id = {
        int(g["time_group_id"]): {
            "id": int(g["time_group_id"]),
            "description": str(g["description"] or ""),
            # Raw Asterisk GotoIfTime strings, e.g. "09:30-17:00,mon-thu,*,*".
            # Parsed on the Connect side so the mapping is unit-testable.
            "schedules": sched_by_group.get(int(g["time_group_id"]), []),
        }
        for g in tg_rows
    }
    out["timeGroups"] = list(tg_by_id.values())
    out["timeConditions"] = [
        {
            "id": int(t["time_condition_id"]),
            "code": str(t["code"] or ""),
            "description": str(t["description"] or ""),
            "timezone": str(t["timezone"] or ""),
            # "default" = follow the schedule. Anything else is a manual
            # override an operator left engaged on the PBX — the copy must
            # surface it rather than silently assume normal hours.
            "status": str(t["status"] or "default"),
            "timeGroup": tg_by_id.get(_nullable_int(t["time_group_id"])),
            "matchTarget": _decode_destination(conn, t["match_destination_id"]),
            "mismatchTarget": _decode_destination(conn, t["mismatch_destination_id"]),
        }
        for t in tc_rows
    ]
    out["routes"] = [
        {
            "routeId": int(r["inbound_route_id"]),
            "did": str(r["did"]),
            "description": str(r["description"] or ""),
            "target": _decode_destination(conn, r["destination_id"]),
        }
        for r in route_rows
    ]
    return out

def flow_map(body):
    """READ-ONLY full call-flow map: inbound routes → time conditions → IVRs →
    per-digit destinations, plus every recording and weekly schedule behind
    them. Omit tenantId to map every enabled tenant on the PBX."""
    raw_tenant = body.get("tenantId")
    tenant_id = require_num("tenant_id", raw_tenant) if raw_tenant not in (None, "") else None
    with db_conn() as conn:
        with conn.cursor() as cur:
            if tenant_id is None:
                cur.execute(
                    "SELECT tenant_id, name, description, path, enabled FROM ombu_tenants "
                    "WHERE enabled = 'yes' ORDER BY tenant_id"
                )
            else:
                cur.execute(
                    "SELECT tenant_id, name, description, path, enabled FROM ombu_tenants WHERE tenant_id = %s",
                    (tenant_id,),
                )
            tenant_rows = cur.fetchall()
        if tenant_id is not None and not tenant_rows:
            raise LookupError("tenant_not_found:%s" % tenant_id)
        tenants = [_flow_map_for_tenant(conn, row) for row in tenant_rows]
    return {"ok": True, "version": VERSION, "capturedAt": utc_now(), "tenants": tenants}

def agent_set_route_destination_v2(body):
    """M3 v2: route a DID to ANY tenant-owned target (extension / queue /
    ring_group / ivr / time_condition / custom_application) by TYPE + ID.
    Ensures the ombu_destinations row exists (GUI creates them lazily), keeps
    the v1 snapshot + connect-managed fences, then runs the REAL per-tenant
    regen so the change actually reaches the dialplan."""
    did_digits, did_e164 = normalize_did(body.get("did"))
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    target_type = str(body.get("targetType") or "").strip()
    target_id = require_num("target_id", body.get("targetId"))
    force = bool(body.get("force", False))
    actor = str(body.get("actor") or "")[:128]
    request_id = str(body.get("requestId") or "")[:128]
    with db_conn() as conn:
        try:
            conn.begin()
            label = _verify_target(conn, tenant_id, target_type, target_id)
            route = find_route(conn, tenant_id, did_digits)
            route_id = int(route["inbound_route_id"])
            current_dest = str(route["destination_id"])
            if _route_is_connect_managed(route_id, current_dest):
                raise RuntimeError("connect_managed_route_refused")
            dest, created = _ensure_destination(conn, OWNER_MODULE_INBOUND_ROUTE, target_type, target_id)
            if current_dest == str(dest):
                conn.rollback()
                # DB already converged — but the BAKED dialplan may still disagree
                # (that is exactly how VitalPBX's broken REST regen bites), so run
                # the bake anyway and return the full after/destination fields the
                # agent's verify step compares against.
                bake = bake_route_goto(tenant_id, did_digits, target_type, target_id)
                if bake.get("error"):
                    raise RuntimeError("route_bake_failed:%s" % bake["error"])
                return {"ok": True, "noop": True, "did": did_e164, "tenantId": tenant_id, "route": route, "after": route, "destinationId": dest, "target": {"type": target_type, "id": target_id, "label": label}, "bake": bake}
            with snap_conn() as sconn:
                existing = sconn.execute("SELECT original_destination_id, last_set_destination_id FROM agent_route_snapshots WHERE route_id = ?", (route_id,)).fetchone()
                if existing and not force:
                    original = str(existing[0])
                    last_set = str(existing[1]) if existing[1] is not None else None
                    # Drift guard: current must be our captured original or the
                    # destination WE last wrote (agent retarget → retarget again).
                    if current_dest != original and current_dest != last_set:
                        raise RuntimeError("route_drifted_since_capture")
                if not existing:
                    sconn.execute(
                        """
                        INSERT INTO agent_route_snapshots
                          (route_id, tenant_id, did_digits, did_e164, captured_at, captured_by, request_id, original_row_json, original_destination_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (route_id, tenant_id, did_digits, did_e164, utc_now(), actor, request_id, json.dumps(route, sort_keys=True, default=str), current_dest),
                    )
                sconn.execute("UPDATE agent_route_snapshots SET last_set_destination_id = ? WHERE route_id = ?", (str(dest), route_id))
                sconn.commit()
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE ombu_inbound_routes SET destination_id = %s WHERE inbound_route_id = %s AND tenant_id = %s AND destination_id = %s",
                    (dest, route_id, tenant_id, current_dest),
                )
                if cur.rowcount != 1:
                    raise RuntimeError("agent_set_update_guard_failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_INBOUND_ROUTE,))
    bake = bake_route_goto(tenant_id, did_digits, target_type, target_id)
    if bake.get("error"):
        raise RuntimeError("route_bake_failed:%s" % bake["error"])
    with db_conn() as conn:
        after = find_route(conn, tenant_id, did_digits)
    return {
        "ok": True,
        "did": did_e164,
        "tenantId": tenant_id,
        "routeId": route_id,
        "before": route,
        "after": after,
        "destinationId": dest,
        "destinationCreated": created,
        "target": {"type": target_type, "id": target_id, "label": label},
        "apply": apply_result,
        "bake": bake,
    }

def _resolve_ivr(conn, tenant_id, ivr_id):
    with conn.cursor() as cur:
        cur.execute("SELECT ivr_id, description, welcome_msg_id FROM ombu_ivrs WHERE ivr_id = %s AND tenant_id = %s", (ivr_id, tenant_id))
        row = cur.fetchone()
    if not row:
        raise LookupError("ivr_not_found_for_tenant")
    return row

def _resolve_recording(conn, tenant_id, recording_id):
    with conn.cursor() as cur:
        cur.execute("SELECT recording_id, name FROM ombu_recordings WHERE recording_id = %s AND tenant_id = %s", (recording_id, tenant_id))
        row = cur.fetchone()
    if not row:
        raise LookupError("recording_not_found_for_tenant")
    return row

def _recordings_dir(conn, tenant_id):
    path = resolve_tenant_path(conn, tenant_id)
    if not path:
        raise RuntimeError("tenant_path_not_found")
    d = CFG.static_dir / path / "recordings"
    d.mkdir(mode=0o755, parents=True, exist_ok=True)
    return d

def ivr_action(body):
    """M4 native IVR operations on VitalPBX's own IVRs (ombu_ivrs):
    list / set_entry / clear_entry / set_welcome / upload_recording."""
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    action = str(body.get("action") or "").strip()
    actor = str(body.get("actor") or "")[:128]

    if action == "list":
        return tenant_catalog({"tenantId": tenant_id})

    if action == "upload_recording":
        name = str(body.get("name") or "").strip()[:120]
        if not name or not re.match(r"^[\w \-\.,()'&]{2,120}$", name):
            raise ValueError("invalid_recording_name")
        raw = base64.b64decode(str(body.get("bytesB64") or ""), validate=True)
        if not raw or len(raw) > MAX_WAV_BYTES:
            raise ValueError("wav_bytes_invalid_or_too_large")
        if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
            raise ValueError("not_a_wav_file")
        # 8 kHz 16-bit mono ⇒ 16000 bytes/sec. The Connect API transcodes
        # before sending, so this is a sanity estimate, not a decoder.
        duration = max(1, int((len(raw) - 44) / 16000))
        with db_conn() as conn:
            try:
                conn.begin()
                rec_dir = _recordings_dir(conn, tenant_id)
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO ombu_recordings (original_filename, name, duration, tenant_id) VALUES (%s, %s, %s, %s)",
                        (name + ".wav", name, duration, tenant_id),
                    )
                    recording_id = int(cur.lastrowid)
                # VitalPBX stores the audio as md5(recording_id) with no extension.
                fname = hashlib.md5(str(recording_id).encode()).hexdigest()
                fpath = rec_dir / fname
                fpath.write_bytes(raw)
                os.chmod(fpath, 0o644)
                try:
                    uid = pwd.getpwnam(CFG.sounds_owner_user).pw_uid
                    gid = grp.getgrnam(CFG.sounds_owner_group).gr_gid
                    os.chown(fpath, uid, gid)
                except (KeyError, PermissionError):
                    pass
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return {"ok": True, "tenantId": tenant_id, "recordingId": recording_id, "name": name, "file": str(fpath), "durationSec": duration}

    if action == "set_welcome":
        ivr_id = require_num("ivr_id", body.get("ivrId"))
        recording_id = require_num("recording_id", body.get("recordingId"))
        with db_conn() as conn:
            try:
                conn.begin()
                ivr = _resolve_ivr(conn, tenant_id, ivr_id)
                rec = _resolve_recording(conn, tenant_id, recording_id)
                before = int(ivr["welcome_msg_id"]) if ivr["welcome_msg_id"] is not None else None
                with conn.cursor() as cur:
                    cur.execute("UPDATE ombu_ivrs SET welcome_msg_id = %s WHERE ivr_id = %s AND tenant_id = %s", (recording_id, ivr_id, tenant_id))
                    if cur.rowcount > 1:
                        raise RuntimeError("welcome_update_guard_failed")
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_IVR,))
        return {"ok": True, "tenantId": tenant_id, "ivrId": int(ivr_id), "ivrName": str(ivr["description"] or ""), "beforeRecordingId": before, "afterRecordingId": int(recording_id), "recordingName": str(rec["name"]), "apply": apply_result}

    if action in ("set_entry", "clear_entry"):
        ivr_id = require_num("ivr_id", body.get("ivrId"))
        option = str(body.get("option") or "").strip()
        if not IVR_OPTION_RE.match(option):
            raise ValueError("invalid_ivr_option")
        with db_conn() as conn:
            try:
                conn.begin()
                ivr = _resolve_ivr(conn, tenant_id, ivr_id)
                with conn.cursor() as cur:
                    cur.execute("SELECT id, destination_id, enabled, sort FROM ombu_ivr_entries WHERE ivr_id = %s AND `option` = %s", (ivr_id, option))
                    existing = cur.fetchone()
                before = _decode_destination(conn, existing["destination_id"]) if existing and existing["destination_id"] else None
                if action == "clear_entry":
                    if not existing:
                        conn.rollback()
                        return {"ok": True, "noop": True, "tenantId": tenant_id, "ivrId": int(ivr_id), "option": option}
                    with conn.cursor() as cur:
                        cur.execute("DELETE FROM ombu_ivr_entries WHERE id = %s AND ivr_id = %s", (existing["id"], ivr_id))
                        if cur.rowcount != 1:
                            raise RuntimeError("entry_delete_guard_failed")
                    target_out = None
                else:
                    target_type = str(body.get("targetType") or "").strip()
                    target_id = require_num("target_id", body.get("targetId"))
                    label = _verify_target(conn, tenant_id, target_type, target_id)
                    dest, _created = _ensure_destination(conn, OWNER_MODULE_IVR, target_type, target_id)
                    with conn.cursor() as cur:
                        if existing:
                            cur.execute("UPDATE ombu_ivr_entries SET destination_id = %s, enabled = 'yes' WHERE id = %s AND ivr_id = %s", (dest, existing["id"], ivr_id))
                            if cur.rowcount != 1 and str(existing["destination_id"]) != str(dest):
                                raise RuntimeError("entry_update_guard_failed")
                        else:
                            cur.execute("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM ombu_ivr_entries WHERE ivr_id = %s", (ivr_id,))
                            sort = int(cur.fetchone()["s"])
                            cur.execute(
                                "INSERT INTO ombu_ivr_entries (ivr_id, `option`, destination_id, enabled, sort) VALUES (%s, %s, %s, 'yes', %s)",
                                (ivr_id, option, dest, sort),
                            )
                    target_out = {"type": target_type, "id": target_id, "label": label, "destinationId": dest}
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        apply_result = apply_tenant_changes(tenant_id, pending_modules=(OWNER_MODULE_IVR,))
        return {
            "ok": True,
            "tenantId": tenant_id,
            "ivrId": int(ivr_id),
            "ivrName": str(ivr["description"] or ""),
            "option": option,
            "action": action,
            "before": before,
            "target": target_out,
            "apply": apply_result,
        }

    raise ValueError("unsupported_ivr_action:%s" % action)

def _resolve_queue(conn, tenant_id, body):
    """Accept queueId (PK) or queueExtension (the dialable number users know)."""
    with conn.cursor() as cur:
        if body.get("queueId") is not None:
            qid = require_num("queue_id", body.get("queueId"))
            cur.execute("SELECT queue_id, extension, description, music_group_id FROM ombu_queues WHERE queue_id = %s AND tenant_id = %s", (qid, tenant_id))
        else:
            qext = require_num("queue_extension", body.get("queueExtension"))
            cur.execute("SELECT queue_id, extension, description, music_group_id FROM ombu_queues WHERE extension = %s AND tenant_id = %s", (qext, tenant_id))
        row = cur.fetchone()
    if not row:
        raise LookupError("queue_not_found_for_tenant")
    return row

def queue_action(body):
    """M10 native queue operations: list / add_member / remove_member /
    set_moh / set_announcement. Member + announcement changes are baked into
    the generated queues conf, so each write runs the real per-tenant regen."""
    tenant_id = require_num("tenant_id", body.get("tenantId"))
    action = str(body.get("action") or "").strip()

    if action == "list":
        return tenant_catalog({"tenantId": tenant_id})

    if action in ("add_member", "remove_member"):
        ext = require_num("extension", body.get("extension"))
        penalty = int(body.get("penalty") or 0)
        if penalty < 0 or penalty > 99:
            raise ValueError("invalid_penalty")
        with db_conn() as conn:
            try:
                conn.begin()
                queue = _resolve_queue(conn, tenant_id, body)
                qid = int(queue["queue_id"])
                with conn.cursor() as cur:
                    cur.execute("SELECT extension_id, extension, name FROM ombu_extensions WHERE extension = %s AND tenant_id = %s", (ext, tenant_id))
                    ext_row = cur.fetchone()
                    if not ext_row:
                        raise LookupError("extension_not_found_for_tenant")
                    ext_id = int(ext_row["extension_id"])
                    cur.execute("SELECT queue_member_id FROM ombu_queue_members WHERE queue_id = %s AND extension_id = %s", (qid, ext_id))
                    member = cur.fetchone()
                    if action == "add_member":
                        if member:
                            conn.rollback()
                            return {"ok": True, "noop": True, "tenantId": tenant_id, "queueId": qid, "queueName": str(queue["description"] or ""), "extension": ext, "reason": "already_member"}
                        cur.execute(
                            "INSERT INTO ombu_queue_members (queue_id, extension_id, penalty, diversions, type) VALUES (%s, %s, %s, 'no', 'static')",
                            (qid, ext_id, penalty),
                        )
                    else:
                        if not member:
                            conn.rollback()
                            return {"ok": True, "noop": True, "tenantId": tenant_id, "queueId": qid, "queueName": str(queue["description"] or ""), "extension": ext, "reason": "not_a_member"}
                        cur.execute("DELETE FROM ombu_queue_members WHERE queue_member_id = %s", (member["queue_member_id"],))
                        if cur.rowcount != 1:
                            raise RuntimeError("member_delete_guard_failed")
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        apply_result = apply_tenant_changes(tenant_id, extra_reloads=('asterisk -rx "queue reload all"',), pending_modules=("queues",))
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT e.extension FROM ombu_queue_members qm JOIN ombu_extensions e ON e.extension_id = qm.extension_id WHERE qm.queue_id = %s",
                    (qid,),
                )
                members_after = sorted(str(r["extension"]) for r in cur.fetchall())
        return {
            "ok": True,
            "tenantId": tenant_id,
            "queueId": qid,
            "queueExtension": str(queue["extension"]),
            "queueName": str(queue["description"] or ""),
            "action": action,
            "extension": ext,
            "membersAfter": members_after,
            "apply": apply_result,
        }

    if action == "set_moh":
        moh_class = str(body.get("mohClass") or "").strip()
        with db_conn() as conn:
            queue = _resolve_queue(conn, tenant_id, body)
            qid = int(queue["queue_id"])
        if re.match(r"^connect_[A-Za-z0-9_]+$", moh_class):
            # Connect-uploaded class: exists only in generated MOH confs (via
            # connect-media-sync) — patch this queue's musicclass line + AstDB.
            if not moh_class_generated(moh_class):
                raise RuntimeError("moh_class_not_generated:%s" % moh_class)
            conf = Path(QUEUE_CONF_DIR) / ("queues__50-%s-main.conf" % int(tenant_id))
            if not conf.is_file():
                raise RuntimeError("queue_conf_missing")
            original = conf.read_text(errors="replace")
            section = "T%s_Q%s" % (int(tenant_id), queue["extension"])
            lines = original.splitlines(keepends=True)
            out_lines, in_section, changed, before_class = [], False, 0, None
            for ln in lines:
                stripped = ln.strip()
                if stripped.startswith("[") and stripped.endswith("]"):
                    in_section = stripped == "[%s]" % section
                if in_section and ln.startswith("musicclass="):
                    before_class = ln[len("musicclass="):].strip()
                    if before_class != moh_class:
                        ln = "musicclass=%s\n" % moh_class
                        changed += 1
                out_lines.append(ln)
            if changed:
                backup_dir = Path(QUEUE_BACKUP_DIR)
                backup_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
                backup = backup_dir / ("%s.%s.bak" % (conf.name, dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
                backup.write_text(original)
                tmp = conf.with_name(conf.name + ".connect-tmp")
                tmp.write_text("".join(out_lines))
                os.replace(tmp, conf)
            with db_conn() as conn:
                path = resolve_tenant_path(conn, tenant_id)
            if path:
                _astdb_put("%s/queues/%s" % (path, queue["extension"]), "moh", moh_class)
            reload_res = run_apply_command('asterisk -rx "queue reload all"')
            return {"ok": True, "tenantId": tenant_id, "queueId": qid, "queueName": str(queue["description"] or ""), "mohClass": moh_class, "beforeClass": before_class, "patched": changed, "reload": reload_res}
        m = re.match(r"^(?:moh(\d+)|default|(\d+))$", moh_class)
        if not m:
            raise ValueError("invalid_moh_class")
        group_id = int(m.group(1) or m.group(2) or 1)
        with db_conn() as conn:
            try:
                conn.begin()
                with conn.cursor() as cur:
                    cur.execute("SELECT music_group_id FROM ombu_music_groups WHERE music_group_id = %s", (group_id,))
                    if not cur.fetchone():
                        raise LookupError("music_group_not_found")
                    cur.execute("UPDATE ombu_queues SET music_group_id = %s WHERE queue_id = %s AND tenant_id = %s", (group_id, qid, tenant_id))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        apply_result = apply_tenant_changes(tenant_id, extra_reloads=('asterisk -rx "queue reload all"',), pending_modules=("queues",))
        return {"ok": True, "tenantId": tenant_id, "queueId": qid, "queueName": str(queue["description"] or ""), "mohClass": target_class_for_group(group_id), "musicGroupId": group_id, "apply": apply_result}

    if action == "set_announcement":
        slot = str(body.get("slot") or "").strip()
        col = {"announcement": "announcement_id", "periodic": "periodic_announcement_id", "join": "join_announcement_id"}.get(slot)
        if not col:
            raise ValueError("invalid_announcement_slot")
        recording_id = body.get("recordingId")
        with db_conn() as conn:
            try:
                conn.begin()
                queue = _resolve_queue(conn, tenant_id, body)
                qid = int(queue["queue_id"])
                rec_name = None
                if recording_id is not None:
                    recording_id = require_num("recording_id", recording_id)
                    rec_name = str(_resolve_recording(conn, tenant_id, recording_id)["name"])
                with conn.cursor() as cur:
                    cur.execute(f"UPDATE ombu_queues SET `{col}` = %s WHERE queue_id = %s AND tenant_id = %s", (recording_id, qid, tenant_id))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        apply_result = apply_tenant_changes(tenant_id, extra_reloads=('asterisk -rx "queue reload all"',), pending_modules=("queues",))
        return {"ok": True, "tenantId": tenant_id, "queueId": qid, "queueName": str(queue["description"] or ""), "slot": slot, "recordingId": int(recording_id) if recording_id is not None else None, "recordingName": rec_name, "apply": apply_result}

    raise ValueError("unsupported_queue_action:%s" % action)

class Handler(BaseHTTPRequestHandler):
    server_version = "ConnectPbxRouteHelper/" + VERSION
    # Socket inactivity timeout (socketserver applies it via settimeout in
    # setup()). Without it a peer that connects and goes silent — or aborts
    # mid-transfer without the FIN/RST ever landing — parks this thread on a
    # blocking read/write forever. handle_one_request() catches TimeoutError
    # and closes the connection, releasing the thread and its fd.
    timeout = CFG.socket_timeout
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
        elif path == "/transport-wss/status":
            if not self.auth_ok():
                self.send_json(401, {"error": "unauthorized"})
                return
            try:
                self.send_json(200, transport_wss_status())
            except Exception as exc:
                self.send_json(409, {"ok": False, "error": str(exc)})
            return
        elif path == "/voicemail/greeting/diag":
            if not self.auth_ok():
                self.send_json(401, {"error": "unauthorized"})
                return
            do_reload = "reload" in (parsed.query or "")
            file_text = ""
            try:
                if Path(CONNECT_VM_DIALPLAN_PATH).is_file():
                    file_text = Path(CONNECT_VM_DIALPLAN_PATH).read_text()
            except OSError:
                file_text = ""
            reload_out = ""
            reload_code = None
            if do_reload:
                rl = subprocess.run(["asterisk", "-rx", "dialplan reload"], text=True, capture_output=True, timeout=15, check=False)
                reload_out = (rl.stdout + rl.stderr)[-2000:]
                reload_code = rl.returncode
            try:
                dp = subprocess.run(["asterisk", "-rx", "dialplan show connect-vm-greeting-record"], text=True, capture_output=True, timeout=10, check=False)
                dispatch = subprocess.run(["asterisk", "-rx", "dialplan show connect-vm-greeting-dispatch"], text=True, capture_output=True, timeout=10, check=False)
                contacts = subprocess.run(["asterisk", "-rx", "pjsip show contacts"], text=True, capture_output=True, timeout=10, check=False)
                astdb = subprocess.run(["asterisk", "-rx", "database show connect_vm_dial"], text=True, capture_output=True, timeout=10, check=False)
            except Exception as exc:
                self.send_json(500, {"ok": False, "error": str(exc)})
                return
            try:
                file_stat = Path(CONNECT_VM_DIALPLAN_PATH).stat()
                file_owner = pwd.getpwuid(file_stat.st_uid).pw_name
                file_group = grp.getgrgid(file_stat.st_gid).gr_name
                file_mode = oct(file_stat.st_mode & 0o777)
            except (OSError, KeyError):
                file_owner = file_group = file_mode = ""
            try:
                ext_conf = Path("/etc/asterisk/extensions.conf").read_text()
            except OSError:
                ext_conf = ""
            self.send_json(200, {
                "ok": True,
                "version": VERSION,
                "dialplanFilePath": CONNECT_VM_DIALPLAN_PATH,
                "dialplanFilePresent": Path(CONNECT_VM_DIALPLAN_PATH).is_file(),
                "dialplanFileSize": len(file_text),
                "dialplanFileOwner": file_owner,
                "dialplanFileGroup": file_group,
                "dialplanFileMode": file_mode,
                "dialplanFileBody": file_text[:6000],
                "dialplanShowExitCode": dp.returncode,
                "dialplanShowOutput": (dp.stdout + dp.stderr)[-4000:],
                "dispatchShowExitCode": dispatch.returncode,
                "dispatchShowOutput": (dispatch.stdout + dispatch.stderr)[-4000:],
                "vmRecordApp": CFG.vm_record_app,
                "vmRecordChannelTemplate": CFG.vm_record_channel_template,
                "pjsipContactsExitCode": contacts.returncode,
                "pjsipContactsOutput": (contacts.stdout + contacts.stderr)[:8000],
                "astdbConnectVmDialOutput": (astdb.stdout + astdb.stderr)[-2000:],
                "dialplanReloadExitCode": reload_code,
                "dialplanReloadOutput": reload_out,
                "extensionsConf": ext_conf[-6000:],
                "vitalpbxDialplanDirListing": "\n".join(sorted(p.name for p in Path("/etc/asterisk/vitalpbx").iterdir())) if Path("/etc/asterisk/vitalpbx").is_dir() else "",
            })
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
        if path == "/voicemail/spool/audio":
            body = {}
            try:
                body = self.read_body()
                audit_body = {
                    k: body.get(k)
                    for k in ("tenantId", "extension", "folder", "msgNum", "voicemailContext", "context")
                    if k in body
                }
                content_type, audio_bytes = vm_spool_read_audio(body)
                audit(path.strip("/"), True, audit_body, result={"audioBytes": len(audio_bytes)})
                self.send_response(200)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(audio_bytes)))
                self.send_header("cache-control", "private, max-age=60")
                self.end_headers()
                self.wfile.write(audio_bytes)
            except LookupError as exc:
                audit_body = {
                    k: body.get(k)
                    for k in ("tenantId", "extension", "folder", "msgNum", "voicemailContext", "context")
                    if k in body
                }
                audit(path.strip("/"), False, audit_body, error=str(exc))
                self.send_json(404, {"error": str(exc)})
            except ValueError as exc:
                audit_body = {
                    k: body.get(k)
                    for k in ("tenantId", "extension", "folder", "msgNum", "voicemailContext", "context")
                    if k in body
                }
                audit(path.strip("/"), False, audit_body, error=str(exc))
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                audit_body = {
                    k: body.get(k)
                    for k in ("tenantId", "extension", "folder", "msgNum", "voicemailContext", "context")
                    if k in body
                }
                audit(path.strip("/"), False, audit_body, error=str(exc))
                self.send_json(409, {"error": str(exc)})
            return
        actions = {
            "/inspect": inspect_route,
            "/retarget": retarget_route,
            "/restore": restore_route,
            "/doorway-status": doorway_status,
            "/route-set-destination": agent_set_route_destination,
            "/route-set-destination-v2": agent_set_route_destination_v2,
            "/route-restore-destination": agent_restore_route_destination,
            "/tenant-catalog": tenant_catalog,
            "/flow-map": flow_map,
            "/ivr-action": ivr_action,
            "/queue-action": queue_action,
            "/get-diversion": ext_feature_get,
            "/set-diversion": ext_feature_set,
            "/sync-tenant-moh": sync_tenant_moh,
            "/ensure-transport-wss-cert": ensure_transport_wss_cert,
            "/upload-prompt": upload_prompt,
            "/recording-export": recording_export,
            "/route-rebake": rebake_route,
            "/doorway-repair": doorway_repair,
            "/media-sync": media_sync_trigger,
            "/console/phone-save": console_phone_save,
            "/console/phone-delete": console_phone_delete,
            "/console/phone-render": console_phone_render,
            "/console/geo-state": console_geo_state,
            "/console/geo-set": console_geo_set,
            "/mirror/tenant-create": mirror_tenant_create,
            "/mirror/tenant-render": mirror_tenant_render,
            "/voicemail/spool/list": vm_spool_list_messages,
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

CONNECT_VM_DIALPLAN_PATH = "/etc/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf"
CONNECT_VM_LEGACY_DIALPLAN_PATHS = (
    "/etc/asterisk/vitalpbx/extensions_95-connect-vm-greeting.conf",
    "/etc/asterisk/extensions__95_connect_vm_greeting.conf",
    "/etc/asterisk/extensions_95_connect_vm_greeting.conf",
)
CONNECT_VM_LEGACY_INLINE_TARGETS = (
    "/etc/asterisk/extensions_custom.conf",
    "/etc/asterisk/extensions__88_custom.conf",
    "/etc/asterisk/extensions__60_custom.conf",
)
CONNECT_VM_LEGACY_BEGIN = "; >>> CONNECT_VM_GREETING_BLOCK_BEGIN (auto-managed by connect-pbx-helper, do not edit) >>>"
CONNECT_VM_LEGACY_END = "; <<< CONNECT_VM_GREETING_BLOCK_END <<<"
CONNECT_VM_DIALPLAN_BODY = """; Auto-managed by connect-pbx-helper. Do not edit manually.
;
; Phase B (2026-05-07): the recording flow runs ONLY after the dispatched
; Dial() answers. We use Dial(...,U(connect-vm-greeting-record-sub^...))
; so the Gosub fires on the answered party's channel and the original
; Local channel never starts prompts before the phone rings. AstDB
; populates the dial string so multiple registered endpoints (hardphone +
; mobile + WebRTC) all ring in parallel.
;
; Phase C (2026-05-07): resolve the actual VitalPBX voicemail context from
; AstDB (connect_vm_context/T<tenant>_<ext>) so recordings are written to
; the correct spool path (e.g. test-voicemail/101/) instead of the wrong
; numeric path (21/101/). Falls back to the numeric tenant id if the key
; is absent (backward compat for tenants not yet re-originated).
;
; Phase D (2026-08-04): dial CONTACTS, not endpoints. Dial(PJSIP/<endpoint>)
; creates ONE channel even when the AOR holds several registrations, so only
; one of the user's devices ever rang (proven live: two Avail contacts on
; T21_101_1, one channel created, nothing visibly rang). PJSIP_DIAL_CONTACTS
; expands every currently-registered contact of the base endpoint (desk
; phones) and the _1 device endpoint (mobile + WebRTC share it) at the moment
; of the Dial, so every live device rings simultaneously. The AstDB dial
; string remains as a fallback for endpoints that expand to nothing.
[connect-vm-greeting-dispatch]
exten => _X!,1,NoOp(Connect VM dispatch ${EXTEN})
 same => n,Set(CONNECT_VM_TENANT=${CUT(EXTEN,_,1)})
 same => n,Set(CONNECT_VM_EXT=${CUT(EXTEN,_,2)})
 same => n,Set(CONNECT_VM_FILE=${CUT(EXTEN,_,3)})
 same => n,Set(CALLERID(name)=Voicemail Greeting Recording)
 same => n,Set(CALLERID(num)=${CONNECT_VM_EXT})
 same => n,Wait(1)
 same => n,Set(CONNECT_VM_BASE_EP=T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})
 same => n,Set(CONNECT_VM_C1=${PJSIP_DIAL_CONTACTS(${CONNECT_VM_BASE_EP})})
 same => n,Set(CONNECT_VM_C2=${PJSIP_DIAL_CONTACTS(${CONNECT_VM_BASE_EP}_1)})
 same => n,Set(CONNECT_VM_DIAL=${CONNECT_VM_C1})
 same => n,ExecIf($[${LEN(${CONNECT_VM_C2})} > 0 & ${LEN(${CONNECT_VM_DIAL})} > 0]?Set(CONNECT_VM_DIAL=${CONNECT_VM_DIAL}&${CONNECT_VM_C2}))
 same => n,ExecIf($[${LEN(${CONNECT_VM_C2})} > 0 & ${LEN(${CONNECT_VM_DIAL})} = 0]?Set(CONNECT_VM_DIAL=${CONNECT_VM_C2}))
 same => n,GotoIf($[${LEN(${CONNECT_VM_DIAL})} > 0]?resolve_context)
 same => n,Set(CONNECT_VM_DIAL=${DB(connect_vm_dial/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})
 same => n,GotoIf($["${CONNECT_VM_DIAL}" = ""]?nodevices)
 same => n(resolve_context),Set(CONNECT_VM_CONTEXT=${DB(connect_vm_context/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})
 same => n,GotoIf($["${CONNECT_VM_CONTEXT}" != ""]?have_context)
 same => n,Set(CONNECT_VM_CONTEXT=${CONNECT_VM_TENANT})
 same => n(have_context),Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))
 same => n,Hangup()
 same => n(nodevices),Verbose(1,Connect VM dispatch: no registered devices for T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})
 same => n,Hangup()

; Post-answer subroutine. Runs on the answered party's channel only AFTER
; Dial() picks up. Args: ARG1=vmContext, ARG2=extension, ARG3=greetingFile.
[connect-vm-greeting-record-sub]
exten => s,1,NoOp(Connect VM record sub context=${ARG1} ext=${ARG2} file=${ARG3})
 same => n,Set(CONNECT_VM_CONTEXT=${ARG1})
 same => n,Set(CONNECT_VM_EXT=${ARG2})
 same => n,Set(CONNECT_VM_FILE=${ARG3})
 same => n,Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)
 same => n,Set(CONNECT_VM_TMP=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/.connect-${UNIQUEID}-${CONNECT_VM_FILE})
 same => n,Wait(1)
 same => n(start),Playback(custom/connect-vm-record-greeting)
 same => n,Playback(beep)
 same => n,Record(${CONNECT_VM_TMP}.wav,0,180,kq)
 same => n,Playback(custom/connect-vm-review)
 same => n,Playback(${CONNECT_VM_TMP})
 same => n(choose),Read(CONNECT_VM_CHOICE,custom/connect-vm-save-redo,1,,3,10)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "1"]?save)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "2"]?redo)
 same => n,Playback(custom/connect-vm-invalid-choice)
 same => n,Goto(choose)
 same => n(redo),System(rm -f ${CONNECT_VM_TMP}.wav)
 same => n,Goto(start)
 same => n(save),System(mv -f ${CONNECT_VM_TMP}.wav ${CONNECT_VM_PATH})
 same => n,System(chown asterisk:asterisk ${CONNECT_VM_PATH})
 same => n,System(chmod 0644 ${CONNECT_VM_PATH})
 same => n,Playback(custom/connect-vm-saved)
 same => n,Hangup()

exten => h,1,System(rm -f ${CONNECT_VM_TMP}.wav)

; Legacy context retained for back-compat. The Phase A dialplan and any
; older Connect API build that originates `extension X@connect-vm-greeting-record`
; still works. The new originate path uses dispatch + record-sub above.
[connect-vm-greeting-record]
exten => _X!,1,NoOp(Connect voicemail greeting record request ${EXTEN})
 same => n,Set(CONNECT_VM_PARSE=${REGEX("^([0-9]+)_([0-9]+)_(unavail|busy|temp|greet)$" ${EXTEN})})
 same => n,GotoIf($["${CONNECT_VM_PARSE}" = "1"]?valid:invalid)
 same => n(valid),Set(CONNECT_VM_TENANT=${CUT(EXTEN,_,1)})
 same => n,Set(CONNECT_VM_EXT=${CUT(EXTEN,_,2)})
 same => n,Set(CONNECT_VM_FILE=${CUT(EXTEN,_,3)})
 same => n,Set(CONNECT_VM_CONTEXT=${DB(connect_vm_context/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})
 same => n,GotoIf($["${CONNECT_VM_CONTEXT}" != ""]?have_ctx)
 same => n,Set(CONNECT_VM_CONTEXT=${CONNECT_VM_TENANT})
 same => n(have_ctx),Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)
 same => n,Set(CONNECT_VM_TMP=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/.connect-${UNIQUEID}-${CONNECT_VM_FILE})
 same => n,Answer()
 same => n,Wait(1)
 same => n(start),Playback(custom/connect-vm-record-greeting)
 same => n,Playback(beep)
 same => n,Record(${CONNECT_VM_TMP}.wav,0,180,kq)
 same => n,Playback(custom/connect-vm-review)
 same => n,Playback(${CONNECT_VM_TMP})
 same => n(choose),Read(CONNECT_VM_CHOICE,custom/connect-vm-save-redo,1,,3,10)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "1"]?save)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "2"]?redo)
 same => n,Playback(custom/connect-vm-invalid-choice)
 same => n,Goto(choose)
 same => n(redo),System(rm -f ${CONNECT_VM_TMP}.wav)
 same => n,Goto(start)
 same => n(save),System(mv -f ${CONNECT_VM_TMP}.wav ${CONNECT_VM_PATH})
 same => n,System(chown asterisk:asterisk ${CONNECT_VM_PATH})
 same => n,System(chmod 0644 ${CONNECT_VM_PATH})
 same => n,Playback(custom/connect-vm-saved)
 same => n,Hangup()
 same => n(invalid),Verbose(1,Rejecting invalid Connect voicemail greeting record request ${EXTEN})
 same => n,Hangup()
"""

def _strip_legacy_inline_blocks():
    """Earlier installer revisions tried to embed the dialplan inside one of
    the *_custom.conf files using BEGIN/END markers. On this VitalPBX install
    those files were either not actually included or ended up with the wrong
    ownership and were silently ignored by Asterisk. Strip any such block so
    there is exactly one source of truth (the drop-in file)."""
    pattern = re.compile(
        r"(?ms)^[ \t]*"
        + re.escape(CONNECT_VM_LEGACY_BEGIN)
        + r".*?"
        + re.escape(CONNECT_VM_LEGACY_END)
        + r"\s*\n?"
    )
    for legacy in CONNECT_VM_LEGACY_INLINE_TARGETS:
        try:
            p = Path(legacy)
            if not p.is_file():
                continue
            body = p.read_text()
            new_body = pattern.sub("", body)
            new_body = re.sub(r"\n{3,}", "\n\n", new_body)
            if new_body != body:
                p.write_text(new_body)
        except (OSError, PermissionError) as exc:
            sys.stderr.write("strip_legacy_inline_block_failed: " + legacy + ": " + str(exc) + "\n")

def _apply_dialplan_owner(path_obj):
    try:
        os.chmod(str(path_obj), 0o644)
    except OSError:
        pass
    try:
        uid = pwd.getpwnam("asterisk").pw_uid
        gid = grp.getgrnam("asterisk").gr_gid
        os.chown(str(path_obj), uid, gid)
    except (KeyError, PermissionError, OSError):
        pass

def ensure_connect_vm_dialplan():
    """Write the Connect voicemail-greeting dialplan to the canonical drop-in
    path /etc/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf with
    asterisk:asterisk 0644. The double-underscore prefix is REQUIRED so the
    file is matched by VitalPBX's `#include vitalpbx/extensions__*.conf` glob
    in /etc/asterisk/extensions.conf ??? single-underscore drop-ins are NOT
    picked up by `dialplan reload` on this install.

    Reload only happens if the on-disk content actually changed, to avoid
    spurious reloads on every helper restart."""
    try:
        # Drop any legacy locations from prior installer revisions so the
        # dialplan never has two competing copies.
        for legacy in CONNECT_VM_LEGACY_DIALPLAN_PATHS:
            try:
                Path(legacy).unlink(missing_ok=True)
            except (OSError, PermissionError):
                pass
        _strip_legacy_inline_blocks()

        target = Path(CONNECT_VM_DIALPLAN_PATH)
        target.parent.mkdir(parents=True, exist_ok=True)
        desired = CONNECT_VM_DIALPLAN_BODY
        existing = target.read_text() if target.is_file() else ""
        changed = existing != desired
        if changed:
            try:
                target.write_text(desired)
            except PermissionError as exc:
                sys.stderr.write("ensure_connect_vm_dialplan_skip_no_write: " + str(exc) + "\n")
                return
        _apply_dialplan_owner(target)
        if changed:
            subprocess.run(["asterisk", "-rx", "dialplan reload"], capture_output=True, timeout=15, check=False)
    except OSError as exc:
        sys.stderr.write("ensure_connect_vm_dialplan_failed: " + str(exc) + "\n")

class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a hard cap on concurrent request threads.

    The stock ThreadingHTTPServer spawns one thread per accepted connection
    with no limit; under sustained polling faster than the handlers drain,
    the process snowballs (more threads → GIL convoy → slower handlers →
    even more threads) until it exhausts its fd limit and wedges. Beyond
    max_inflight we answer 503 straight from the accept loop — no thread,
    no lingering fd — so overload degrades to fast, visible errors instead
    of a dead helper."""

    daemon_threads = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._inflight = threading.BoundedSemaphore(max(1, CFG.max_inflight))

    def process_request(self, request, client_address):
        if self._inflight.acquire(blocking=False):
            try:
                super().process_request(request, client_address)
                return
            except BaseException:
                self._inflight.release()
                raise
        try:
            request.settimeout(2)
            body = b'{"error":"helper_saturated"}'
            head = (
                "HTTP/1.0 503 Service Unavailable\r\n"
                "content-type: application/json\r\n"
                "content-length: %d\r\n"
                "connection: close\r\n\r\n" % len(body)
            ).encode("ascii")
            request.sendall(head + body)
        except OSError:
            pass
        finally:
            self.shutdown_request(request)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._inflight.release()


def main():
    CFG.validate()
    with snap_conn():
        pass
    ensure_connect_vm_dialplan()
    # Doorway dialplan installs/heals at boot too, so the shim is answering
    # before the first switch even on a fresh install (soft: boot must not die
    # on a transient Asterisk hiccup — retarget re-runs this strictly).
    ensure_connect_doorway_dialplan(strict=False)
    if "--check" in sys.argv:
        print(json.dumps({"ok": True, "version": VERSION, "bind": CFG.bind, "port": CFG.port}))
        return
    httpd = BoundedThreadingHTTPServer((CFG.bind, CFG.port), Handler)
    print("connect-pbx-route-helper listening on %s:%s (max_inflight=%d)" % (CFG.bind, CFG.port, CFG.max_inflight), flush=True)
    httpd.serve_forever()

if __name__ == "__main__":
    main()
PYHELPER

chmod 0755 /opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py

# ── the MIRROR module (2026-08-19): create a tenant without the panel ─────────
# Imported lazily by the helper's /mirror/tenant-create. Byte-identical copy of
# scripts/pbx/mirror/mirror_writes.py (drift guard in the installer test).
cat >/opt/connect-pbx-helper/mirror_writes.py <<'PYMIRROR'
#!/usr/bin/env python3
"""
VitalPBX mirror — the WRITE side.

Writes the same `ombutel` rows the VitalPBX panel writes, so that VitalPBX's own
regenerator (or our byte-identical renderer, vitalpbx_mirror.py) produces the
same files, without the panel's licence-gated save path ever running.

    create_tenant(...)            the row set the panel inserts for a NEW tenant
    add_extension(...)            an extension + desk device + WebRTC `_1` device (+vm/followme/diversions/...)
    add_did(...)                  DID + inbound route + destination bookkeeping
    render_and_install(...)       write the files (0644), AstDB `database put` list, reload commands
    insert_extension_surgical(...) pure-text insertion of ONE extension into EXISTING VitalPBX files

DRY-RUN BY DEFAULT. Every function builds a Plan; `plan.sql_script()` prints the
exact INSERT statements (as an executable MySQL script using session variables
for the auto-increment ids), and `plan.execute(conn)` runs them in one
transaction and returns the captured ids. Pass `--apply` on the CLI to execute.

Row spec (derived empirically from tenants 104/105/106, created by the panel on
2026-08-05/06/18, and cross-checked against 101/102 and the older tenants):
see README.md → "create_tenant row spec".

Only stdlib + pymysql. Python 3.11.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import string
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --------------------------------------------------------------------------- #
# Plan: a list of INSERTs whose auto-increment ids can be referenced later
# --------------------------------------------------------------------------- #


class Ref:
    """Symbolic reference to an id captured earlier in the plan (e.g. Ref('tenant_id'))."""

    def __init__(self, name: str):
        self.name = name

    def __repr__(self):
        return "@%s" % self.name


class _Concat:
    """CONCAT('T', @tenant_id, '_reload') — a value that needs the captured tenant id spliced into a string."""

    def __init__(self, *parts):
        self.parts = parts

    def sql(self, lit) -> str:
        return "CONCAT(%s)" % ", ".join(lit(p) for p in self.parts)

    def value(self, ids) -> str:
        return "".join(str(ids[p.name]) if isinstance(p, Ref) else str(p) for p in self.parts)


class Plan:
    def __init__(self):
        self.steps: List[Tuple[str, List[str], List[Any], Optional[str]]] = []  # table, cols, values, capture
        self.notes: List[str] = []
        self.shell: List[str] = []  # filesystem / asterisk commands that accompany the rows

    def insert(self, table: str, row: Dict[str, Any], capture: Optional[str] = None) -> Optional[Ref]:
        cols = list(row.keys())
        vals = [row[c] for c in cols]
        self.steps.append((table, cols, vals, capture))
        return Ref(capture) if capture else None

    def note(self, text: str):
        self.notes.append(text)

    # ---- rendering ----
    @staticmethod
    def _lit(v) -> str:
        if v is None:
            return "NULL"
        if isinstance(v, Ref):
            return "@%s" % v.name
        if isinstance(v, _Concat):
            return v.sql(Plan._lit)
        if isinstance(v, bool):
            return "1" if v else "0"
        if isinstance(v, (int, float)):
            return str(v)
        s = str(v).replace("\\", "\\\\").replace("'", "\\'")
        return "'%s'" % s

    def sql_script(self) -> str:
        out = ["-- VitalPBX mirror write plan (dry run). Executable as a MySQL script.", "START TRANSACTION;"]
        for table, cols, vals, capture in self.steps:
            out.append("INSERT INTO `%s` (%s) VALUES (%s);" % (
                table, ", ".join("`%s`" % c for c in cols), ", ".join(self._lit(v) for v in vals)))
            if capture:
                out.append("SET @%s = LAST_INSERT_ID();" % capture)
        out.append("COMMIT;")
        if self.shell:
            out.append("")
            out.append("-- accompanying filesystem / asterisk commands (run on the PBX as root):")
            out += ["-- " + c for c in self.shell]
        if self.notes:
            out.append("")
            out += ["-- NOTE: " + n for n in self.notes]
        return "\n".join(out) + "\n"

    def execute(self, conn) -> Dict[str, int]:
        """Run every INSERT in ONE transaction; returns {capture_name: id}."""
        ids: Dict[str, int] = {}
        try:
            with conn.cursor() as cur:
                for table, cols, vals, capture in self.steps:
                    real = [ids[v.name] if isinstance(v, Ref) else v.value(ids) if isinstance(v, _Concat) else v
                            for v in vals]
                    cur.execute("INSERT INTO `%s` (%s) VALUES (%s)" % (
                        table, ", ".join("`%s`" % c for c in cols), ", ".join(["%s"] * len(cols))), real)
                    if capture:
                        ids[capture] = cur.lastrowid
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return ids

    def rows_by_table(self) -> Dict[str, int]:
        d: Dict[str, int] = {}
        for table, *_ in self.steps:
            d[table] = d.get(table, 0) + 1
        return d


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def q(conn, sql, args=()):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return list(cur.fetchall())


def q1(conn, sql, args=()):
    r = q(conn, sql, args)
    return r[0] if r else None


def new_tenant_path(conn=None) -> str:
    """16 lowercase hex chars, unique in ombu_tenants.path (VitalPBX's tenant hash)."""
    while True:
        p = secrets.token_hex(8)
        if conn is None or not q1(conn, "select 1 from ombu_tenants where path=%s", (p,)):
            return p


def slugify(description: str) -> str:
    """The panel's tenant `name` for a description: lowercase, non-alnum -> '_' (matches Connect's toIvrSlug)."""
    s = re.sub(r"[^a-z0-9]+", "_", description.lower()).strip("_")
    return s or "tenant"


def random_password(n: int = 25) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def random_features_password(n: int = 8) -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(n))


TENANT_SETTINGS_DEFAULTS: List[Tuple[str, str]] = [
    # exactly the 21 rows the panel writes for a new tenant (T101/102/104/105/106 all have these, all '')
    ("addons", ""),
    ("allow_recordings", "yes"),
    ("allowed_outbound_routes", ""),
    ("allowed_tenant_trunks", ""),
    ("calls_limit", ""),
    ("cid_name", ""),
    ("cid_number", ""),
    ("conferences", ""),
    ("disable_trunks_prefix", "no"),
    ("extensions", ""),
    ("inbound_calls_limit", ""),
    ("ivrs", ""),
    ("mfa_allowed", "no"),
    ("outbound_profiles", ""),
    ("parking_lots", ""),
    ("queues", ""),
    ("restricted_cid", "disabled"),
    ("shared_trunks", ""),
    ("timezone", "system"),
    ("trunks", ""),
    ("vpbx_devices", ""),
]

QUEUED_CHANGE_MODULES = (42, 43, 110)  # iax_settings, sip_settings, pjsip_settings
# The panel's tenant SAVE also leaves the tenant's base modules pending, so the very next Apply
# Changes renders the whole per-tenant file set (parking, conferences, MOH, trunk stubs, the
# Default inbound route, hints). Proven on the clone 2026-08-19: rows alone rendered only the
# extension-driven files; queuing 99/11/8/48 rendered confbridge/moh/res_parking.
BASE_RENDER_MODULES = (99, 11, 8, 48, 26, 29, 1)  # tenants, parking, conferences, music_on_hold, trunks, inbound_route, extensions
PROVISIONING_INDEX_PHP = '<?php\nrequire_once(\'/usr/share/vitalpbx/www/includes/cli.php\');\n\nuse modules\\provisioning\\Device;\nuse vitalpbx\\tenant;\n\nerror_reporting(E_ALL);\nini_set(\'display_errors\', 0);\nini_set(\'html_errors\', false);\n\n$filename = arrayGet(\'filename\', $_GET);\n$mac_address = parse_mac_address(arrayget(\'mac\', $_GET));\nif ($filename !== null && $mac_address !== null) {\n    $dev = Device::getByMAC(format_mac_address($mac_address));\n    if($dev->id){\n        $devTenant = new tenant($dev->tenant);\n        if($devTenant->path === "TENANT_PATH"){\n\t        $file = $dev->getProvisioningFile();\n\t        //If the provisioning file doesn\'t exists, then, try to generating the provisioning file\n\t        if(!$file){\n\t           $dev->generateProvisioningFile();\n\t           $file = $dev->getProvisioningFile();\n\t        }\n\t\n\t        if($file){\n\t            header(\'Content-Type: text/plain\');\n\t            header(\'Content-Length: \' . filesize($file));\n\t            readfile($file);\n\t            exit;\n\t        }\n        }\n        \n        // --- Return 403 Forbidden for known device but no file ---\n\t    header(\'HTTP/1.1 403 Forbidden\');\n\t    echo "Forbidden: Unable to serve provisioning file.";\n\t    exit;\n    }\n}\n\nfunction format_mac_address($mac){\n    $mac = trim($mac);\n    if(strlen($mac) === 12)\n        $mac = implode(\':\',str_split($mac, 2));\n\n    return $mac;\n}\n\nfunction parse_mac_address($string) {\n        if (preg_match(\'/[0-9a-fA-F]{12}/\',$string,$m)) {\n                return strtolower($m[0]);\n        }\n        return null;\n}\n\nfunction arrayGet($name, &$array, $default = null) {\n    return $array[$name] ?? $default;\n}\n\n\n// --- Fallback: 404 for invalid or missing MAC/filename ---\nheader(\'HTTP/1.1 404 Not Found\');\necho "404 Not Found: Invalid provisioning request.";\nexit;'

TENANT_STATIC_DIRS = ["moh", "recordings", "pdf", "voicemail", "pictures",
                      "default_recordings", "dictations", "fax", "reminders"]

# --------------------------------------------------------------------------- #
# create_tenant
# --------------------------------------------------------------------------- #


def create_tenant(conn, description: str, *, name: Optional[str] = None, tenant_id: Optional[int] = None,
                  path: Optional[str] = None, user_id: int = 45, outbound_profile_ids: Sequence[int] = (),
                  cid_name: str = "", cid_number: str = "", allow_recordings: str = "yes",
                  timezone: str = "system", did: Optional[str] = None, did_description: str = "Main",
                  did_destination: Optional[Tuple[int, int, str]] = None,
                  dids: Sequence[str] = (), queue_base_modules: bool = True) -> Plan:
    """
    Build the plan for a new tenant, byte-for-byte the rows the panel writes.

    did_destination: (category_id, module_id, index) for the DID's inbound route, e.g. (1, 29, <extension_id>)
    for "ring extension", (33, 29, <cc_id>) for the Connect doorway custom context. When None and a did is
    given, the route is created pointing at the same "verify DID" pseudo-destination the Default route uses
    (31, 29, '1'); repoint it later (Connect's helper does that when the number is switched to Connect).
    """
    plan = Plan()
    name = name or slugify(description)
    if q1(conn, "select 1 from ombu_tenants where name=%s", (name,)):
        raise ValueError("tenant name %r already exists" % name)
    path = path or new_tenant_path(conn)
    if not re.fullmatch(r"[0-9a-f]{16}", path):
        raise ValueError("path must be 16 lowercase hex chars")

    # 1. ombu_tenants
    row = {"name": name, "description": description, "default": "no", "path": path, "prefix": None, "enabled": "yes"}
    if tenant_id is not None:
        row = {"tenant_id": tenant_id, **row}
    plan.insert("ombu_tenants", row, capture="tenant_id")
    T = Ref("tenant_id")

    # 2. ombu_tenants_users — the creating panel user gains access, never as its default tenant
    plan.insert("ombu_tenants_users", {"user_id": user_id, "tenant_id": T, "default": "no"})

    # 3. ombu_tenant_settings — the 21 rows
    overrides = {"outbound_profiles": ",".join(str(x) for x in outbound_profile_ids),
                 "cid_name": cid_name, "cid_number": cid_number,
                 "allow_recordings": allow_recordings, "timezone": timezone}
    for k, v in TENANT_SETTINGS_DEFAULTS:
        plan.insert("ombu_tenant_settings", {"tenant_id": T, "name": k, "value": overrides.get(k, v)})

    # 4. class of service "all" / All Permissions (default) — its id is what the dialplan's
    #    sub-set-call-vars carries and what every extension's class_of_service_id points at
    plan.insert("ombu_classes_of_service", {
        "cos": "all", "description": "All Permissions", "feature_code_category_id": None, "ars_id": None,
        "dialrule_id": None, "allowed_calls_by": None, "private": "no", "billing_app_id": None,
        "default": "yes", "tenant_id": T}, capture="class_of_service_id")

    # 5. dial profile "Default"
    plan.insert("ombu_dial_profiles", {
        "name": "Default", "music_group_id": None, "allow_parking": "called", "allow_transfer": "called",
        "call_screening": "disabled", "ringing_tone": "yes", "custom_options": None, "default": "yes",
        "tenant_id": T}, capture="dial_profile_id")

    # 6. maintenance defaults
    plan.insert("ombu_maintenance", {
        "cdr_preservation": 60, "recordings_preservation": 60, "voicemail_preservation": 30,
        "sms_preservation": None, "logger_preservation": None, "recordings_clear_less_nseconds": 5,
        "convert_recordings": "no", "conversion_quality": 16, "maintenance_cron": None,
        "enabled": "yes", "default": "no", "tenant_id": T})

    # 7. default parking lot 700 (slots 701-710) + its "hang up on timeout" destination
    #    (category 24 = terminate call, module 11 = parking owns the reference, index '1' = hangup)
    plan.insert("ombu_destinations", {"category_id": 24, "module_id": 11, "index": "1"}, capture="park_dest_id")
    plan.insert("ombu_parking_lots", {
        "extension": "700", "description": "Default Parking", "destination_id": Ref("park_dest_id"),
        "parkingtime": 45, "comebacktoorigin": "yes", "comebackdialtime": 20, "parkedplay": "caller",
        "parkpos": 10, "parkedcalltransfers": "no", "parkedcallreparking": "no", "parkedcallhangup": "no",
        "findslot": "first", "music_group_id": None, "defpark": "yes", "announce_space_number": "yes",
        "record": "no", "tenant_id": T}, capture="parking_lot_id")
    #    the used-number registry: module 11 (parking) claims 700..710
    for n in range(700, 711):
        plan.insert("ombu_numbers", {"module_id": 11, "number": str(n), "tenant_id": T})

    # 8. the tenant's own (empty) outbound-profile row — renders as [ARS-<id>] with only the `i` exten
    plan.insert("ombu_ars", {"description": "none", "default": "yes", "tenant_id": T}, capture="ars_id")

    # 9. Default inbound route -> "verify DID" pseudo-destination (category 31, module 29, index '1')
    plan.insert("ombu_destinations", {"category_id": 31, "module_id": 29, "index": "1"}, capture="default_route_dest_id")
    plan.insert("ombu_inbound_routes", _inbound_route_row(T, "Default", None, Ref("default_route_dest_id"), detectiontime=None),
                capture="default_route_id")

    # 10. pending-change bookkeeping the panel leaves for its own Apply Changes (iax/sip/pjsip settings)
    for mod in QUEUED_CHANGE_MODULES:
        plan.insert("ombu_queued_changes", {"tenant_id": T, "module_id": mod})
    if queue_base_modules:
        for mod in BASE_RENDER_MODULES:
            plan.insert("ombu_queued_changes", {"tenant_id": T, "module_id": mod})

    # 11. per-tenant reload flags in ombu_settings (every live tenant has them; value 'no' = nothing pending)
    #     NOTE: name embeds the numeric tenant id, so it needs the captured id -> CONCAT in SQL.
    plan.insert("ombu_settings", {"module_id": 108, "name": _Concat("T", T, "_reload_dialplan"), "value": "no"})
    plan.insert("ombu_settings", {"module_id": 96, "name": _Concat("T", T, "_reload"), "value": "no"})

    # 12. the tenant's numbers, exactly like the panel's tenant form `inbound_numbers[]`: ONLY
    #     ombu_tenant_dids rows. The per-DID inbound routes ("Main", "Main ported") are created
    #     afterwards by Connect's createInboundRoute, as today — writing a route here would give
    #     the DID two "Main" routes.
    for d in dids:
        d = re.sub(r"\D", "", str(d))
        if d:
            plan.insert("ombu_tenant_dids", {"tenant_id": T, "did": d, "description": ""})
    # 12b. legacy single-DID-with-route form (kept for scripts that want the route too)
    if did:
        add_did(conn, None, did, did_description, did_destination, plan=plan, tenant_ref=T)

    # filesystem side (the panel creates these at save time)
    plan.shell += tenant_fs_commands(path)
    plan.note("tenant path (AstDB family / static dir) = %s" % path)
    plan.note("outbound profiles (ombu_ars rows in Main tenant 1) are NOT created here — the panel still does "
              "trunk/route/ARS in Main; pass their ids in outbound_profile_ids")
    plan.note("no ombu_ami_users row: none of T101/102/104/105/106 has one (only tenants where a manager user was made)")
    plan.note("no ombu_settings T<t>_dynamic-routing rows: T104/T105 have none (renderer falls back to the global rows); "
              "T106 has four, created lazily")
    return plan




def _inbound_route_row(T, description, did, dest, detectiontime=5, language="en"):
    return {"cos_id": None, "description": description, "routing_method": "default", "did": did,
            "channel_id": None, "cid_management_id": None, "cid_lookup_id": None, "cid_number": None,
            "destination_id": dest, "language": language, "music_group_id": None, "alertinfo": None,
            "enablerecording": "no", "digits_to_take": None, "prepend": None, "append": None,
            "faxdetection": "no", "drop_anon_calls": "no", "detectiontime": detectiontime,
            "fax_destination_id": None, "privacyman": "no", "pmminlength": 10, "pmmaxretries": 3,
            "tenant_id": T}


def apply_tenant_fs(path: str, static_root: str = "/var/lib/vitalpbx/static",
                    prov_root: str = "/var/lib/vitalpbx/provisioning/provisioning_templates") -> Dict[str, Any]:
    """Create the per-tenant directories/files the panel creates at tenant save (idempotent).
    Ownership as in the production baseline; chown needs CAP_CHOWN (the helper has it)."""
    import grp
    import pwd
    import stat as _stat
    if not re.fullmatch(r"[0-9a-f]{16}", path):
        raise ValueError("path must be 16 lowercase hex chars")
    out = {"created": [], "chown_errors": []}

    def uid(u):
        return pwd.getpwnam(u).pw_uid

    def gid(g):
        return grp.getgrnam(g).gr_gid

    def own(p, u, g):
        try:
            os.chown(p, uid(u), gid(g))
        except Exception as exc:  # non-fatal: the ACL default already grants both users
            out["chown_errors"].append("%s: %s" % (p, exc))

    base = os.path.join(static_root, path)
    os.makedirs(base, mode=0o2775, exist_ok=True); os.chmod(base, 0o2775); own(base, "asterisk", "www-data")
    owners = {"dictations": ("asterisk", "www-data"), "fax": ("asterisk", "www-data"), "reminders": ("asterisk", "www-data"),
              "moh": ("www-data", "asterisk"), "recordings": ("www-data", "asterisk"), "default_recordings": ("www-data", "asterisk"),
              "pdf": ("www-data", "www-data"), "voicemail": ("www-data", "www-data"), "pictures": ("www-data", "www-data")}
    for d in TENANT_STATIC_DIRS:
        p = os.path.join(base, d)
        os.makedirs(p, mode=0o2775, exist_ok=True); os.chmod(p, 0o2775); own(p, *owners[d]); out["created"].append(p)
    prov = os.path.join(prov_root, path)
    os.makedirs(prov, mode=0o2775, exist_ok=True); os.chmod(prov, 0o2775); own(prov, "www-data", "www-data")
    for fname, content in (("aastra.cfg", "#Aastra Dummy File\n"), ("index.php", PROVISIONING_INDEX_PHP.replace("TENANT_PATH", path))):
        fp = os.path.join(prov, fname)
        with open(fp, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
        os.chmod(fp, 0o664); own(fp, "www-data", "www-data"); out["created"].append(fp)
    return out


def tenant_fs_commands(path: str) -> List[str]:
    cmds = []
    for d in TENANT_STATIC_DIRS:
        cmds.append("install -d -m 2775 /var/lib/vitalpbx/static/%s/%s" % (path, d))
    cmds += [
        "chown asterisk:www-data /var/lib/vitalpbx/static/%s /var/lib/vitalpbx/static/%s/{dictations,fax,reminders}" % (path, path),
        "chown www-data:asterisk /var/lib/vitalpbx/static/%s/{moh,recordings,default_recordings}" % path,
        "chown www-data:www-data /var/lib/vitalpbx/static/%s/{pdf,voicemail,pictures}" % path,
        "install -d -m 2775 -o www-data -g www-data /var/lib/vitalpbx/provisioning/provisioning_templates/%s" % path,
        "printf '#Aastra Dummy File\\n' > /var/lib/vitalpbx/provisioning/provisioning_templates/%s/aastra.cfg && chown www-data:www-data /var/lib/vitalpbx/provisioning/provisioning_templates/%s/aastra.cfg && chmod 664 /var/lib/vitalpbx/provisioning/provisioning_templates/%s/aastra.cfg" % (path, path, path),
        "sed 's/TENANT_PATH/%s/' /root/pbx-mirror-dev/mirror/provisioning_index.php.tmpl > /var/lib/vitalpbx/provisioning/provisioning_templates/%s/index.php && chmod 664 /var/lib/vitalpbx/provisioning/provisioning_templates/%s/index.php" % (path, path, path),
    ]
    return cmds


# --------------------------------------------------------------------------- #
# add_did
# --------------------------------------------------------------------------- #

def add_did(conn, tenant_id: Optional[int], did: str, description: str = "Main",
            destination: Optional[Tuple[int, int, str]] = None, *, plan: Optional[Plan] = None,
            tenant_ref: Optional[Ref] = None, language: str = "en") -> Plan:
    """ombu_tenant_dids + ombu_destinations + ombu_inbound_routes for one DID (detectiontime 5 like the panel)."""
    plan = plan or Plan()
    T = tenant_ref if tenant_ref is not None else tenant_id
    if T is None:
        raise ValueError("tenant_id or tenant_ref required")
    plan.insert("ombu_tenant_dids", {"tenant_id": T, "did": did, "description": ""})
    cat, mod, idx = destination or (31, 29, "1")
    cap = "did_%s_dest_id" % did
    plan.insert("ombu_destinations", {"category_id": cat, "module_id": mod, "index": str(idx)}, capture=cap)
    plan.insert("ombu_inbound_routes", _inbound_route_row(T, description, did, Ref(cap), detectiontime=5, language=language),
                capture="did_%s_route_id" % did)
    return plan


# --------------------------------------------------------------------------- #
# add_extension
# --------------------------------------------------------------------------- #

DIVERSION_NAMES = ("BOSS", "PEA", "FWM", "DND", "CC", "CFI", "CFB", "CFN", "CFU")


def add_extension(conn, tenant_id: int, ext: str, name: str, email: str = "",
                  desk_password: Optional[str] = None, webrtc_password: Optional[str] = None, *,
                  features_password: Optional[str] = None, vm_password: Optional[str] = None,
                  language: str = "en", music_group_id: int = 1, outgoing_rec: str = "yes",
                  incoming_rec: str = "yes", desk_device: bool = True, webrtc_device: bool = True,
                  desk_dtmf: str = "rfc4733", webrtc_dtmf: str = "rfc2833",
                  desk_max_contacts: int = 1, webrtc_max_contacts: int = 5) -> Plan:
    """
    Rows the panel's extension form / CSV import writes for one extension with a desk device
    (profile 1, user=<ext>) and a WebRTC device (profile 12, user=<ext>_1, vitxi_client=yes).
    Values match ombu_extensions 400/402/405 (T104/105/106) column for column.
    """
    plan = Plan()
    t = q1(conn, "select * from ombu_tenants where tenant_id=%s", (tenant_id,))
    if not t:
        raise ValueError("tenant %s not found" % tenant_id)
    if q1(conn, "select 1 from ombu_extensions where tenant_id=%s and extension=%s", (tenant_id, ext)):
        raise ValueError("extension %s already exists in tenant %s" % (ext, tenant_id))
    if q1(conn, "select 1 from ombu_numbers where tenant_id=%s and number=%s", (tenant_id, ext)):
        raise ValueError("number %s already used in tenant %s (ombu_numbers)" % (ext, tenant_id))
    cos = q1(conn, "select class_of_service_id from ombu_classes_of_service where tenant_id=%s and `default`='yes'", (tenant_id,))
    dp = q1(conn, "select dial_profile_id from ombu_dial_profiles where tenant_id=%s and `default`='yes'", (tenant_id,))
    if not cos or not dp:
        raise ValueError("tenant %s has no default class of service / dial profile" % tenant_id)
    slug = t["name"]
    desk_password = desk_password or random_password()
    webrtc_password = webrtc_password or desk_password  # live rows: both devices share one secret
    features_password = features_password or random_features_password()
    vm_password = vm_password if vm_password is not None else ext

    plan.insert("ombu_extensions", {
        "extension": ext, "name": name, "language": language, "email": email or "",
        "class_of_service_id": cos["class_of_service_id"], "dial_profile_id": dp["dial_profile_id"],
        "call_limit": 0, "internal_cid": '"%s" <%s>' % (name, ext), "external_cid": None, "emergency_cid": None,
        "ringtime": 0, "nospy": "no", "enabled_pa": "no", "answermode": "disable",
        "mailbox": "%s@%s-voicemail" % (ext, slug), "accountcode": None,
        "features_password": features_password, "portal_password": None, "sendcid": "yes",
        "generate_hints": "no", "hot_desking": "no", "secretary": None, "music_group_id": music_group_id,
        "rec_on_demand": "no", "internal_rec": "no", "outgoing_rec": outgoing_rec, "incoming_rec": incoming_rec,
        "dictate_enable": "no", "dictate_format": "wav", "dictate_auto_send": "no", "absent_secretary": "no",
        "lock": "no", "call_waiting": "yes", "dynamic_external_cid": "no", "cid_on_diversions": "caller",
        "pinless": "no", "dynamic_routing": "no", "sms_number_id": None, "notify_missed_calls": None,
        "callback_on_busy_transfer": "no", "tenant_id": tenant_id}, capture="extension_id")
    E = Ref("extension_id")
    plan.insert("ombu_numbers", {"module_id": 1, "number": ext, "tenant_id": tenant_id})

    if desk_device:
        plan.insert("ombu_devices", {
            "extension_id": E, "profile_id": 1, "user": ext, "secret": desk_password,
            "description": "Device %s" % ext, "emergency_cid_name": None, "emergency_cid_number": None,
            "ring_device": "yes", "technology": "pjsip", "assigned_exten": ext, "tenant_id": tenant_id,
            "vitxi_client": "no", "dispatchable_location_id": None, "send_welcome_email": "no",
            "mobile_client": "no"}, capture="desk_device_id")
        plan.insert("ombu_pjsip_devices", {"device_id": Ref("desk_device_id"), "codecs": None, "dtmfmode": desk_dtmf,
                                           "max_contacts": desk_max_contacts, "deny": "0.0.0.0/0", "permit": "0.0.0.0/0"})
    if webrtc_device:
        plan.insert("ombu_devices", {
            "extension_id": E, "profile_id": 12, "user": "%s_1" % ext, "secret": webrtc_password,
            "description": name, "emergency_cid_name": None, "emergency_cid_number": None,
            "ring_device": "yes", "technology": "pjsip", "assigned_exten": None, "tenant_id": tenant_id,
            "vitxi_client": "yes", "dispatchable_location_id": None, "send_welcome_email": "no",
            "mobile_client": "no"}, capture="webrtc_device_id")
        plan.insert("ombu_pjsip_devices", {"device_id": Ref("webrtc_device_id"), "codecs": None, "dtmfmode": webrtc_dtmf,
                                           "max_contacts": webrtc_max_contacts, "deny": "0.0.0.0/0", "permit": "0.0.0.0/0"})

    plan.insert("ombu_extensions_vm", {
        "extension_id": E, "voicemail_timezone_id": None, "password": vm_password,
        "context": "%s-voicemail" % slug, "alias": None, "skip_instructions": "no", "attach": "yes",
        "saycid": "yes", "sayduration": "yes", "envelope": "yes", "delete": "no", "hidefromdir": "no",
        "dialout": "no", "callback": "no", "create_hint": "no", "ask_password": "yes", "enabled": "yes",
        "operator_destination_id": None, "busy_greeting_id": None, "unav_greeting_id": None,
        "ai_transcription": "no"})
    plan.insert("ombu_followme", {
        "extension_id": E, "music_group_id": 1, "followme_numbers": None, "ringtime": 30, "initial_ringtime": 0,
        "ring_strategy": "one_by_one", "call_from_prompt_id": 1, "pls_hold_prompt_id": 1, "status_prompt_id": 1,
        "sorry_prompt_id": 1, "norecording_prompt_id": 1, "recname": "no", "enable_callee_prompt": "no",
        "internal_numbers_confirmation": "no"})
    for dname in DIVERSION_NAMES:
        plan.insert("ombu_extension_diversions", {"extension_id": E, "name": dname, "enable": "no",
                                                  "destination_id": None, "time_group_id": None})
    plan.insert("ombu_extensions_contact_info", {"extension_id": E, "mobile_number": None, "home_number": None,
                                                 "organization": None, "job_title": None})
    plan.note("ombu_extensions_vm.id and ombu_followme.id equal extension_id on every live row (auto_increment "
              "happens to track); we let auto_increment assign them")
    plan.note("no ombu_extension_pea row (table is empty platform-wide); no ombu_users portal login (portal_password NULL)")
    return plan


# --------------------------------------------------------------------------- #
# render_and_install
# --------------------------------------------------------------------------- #

RELOAD_COMMANDS = ["module reload res_pjsip.so", "dialplan reload", "voicemail reload", "module reload res_parking.so"]


def render_and_install(conn, tenant_id: int, target_dir: str, *, apply: bool = False,
                       astdb_apply: bool = False, date: Optional[str] = None) -> Dict[str, Any]:
    """
    Render tenant files with vitalpbx_mirror, write them 0644 into target_dir (chown www-data:www-data is
    the caller's job on the PBX; in dev we only set the mode), and return the AstDB `database put`
    command list plus the reload commands. Dry run prints; apply writes.
    """
    import vitalpbx_mirror as vm
    m = vm.load_tenant(conn, tenant_id)
    files = vm.render_tenant(m, date)
    kv = vm.render_astdb(m)
    puts = []
    for k, v in sorted(kv.items()):
        fam, key = k[1:].split("/", 1)
        puts.append('asterisk -rx "database put %s %s \\"%s\\""' % (fam, key, v.replace('"', '\\"')))
    result = {"files": sorted(files), "astdb_puts": puts, "reload": ["asterisk -rx \"%s\"" % c for c in RELOAD_COMMANDS],
              "target_dir": target_dir, "applied": apply}
    if apply:
        os.makedirs(target_dir, exist_ok=True)
        for name, text in files.items():
            p = os.path.join(target_dir, name)
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.chmod(p, 0o644)
        if astdb_apply:
            import subprocess
            for c in puts:
                subprocess.run(c, shell=True, check=False)
    return result


# --------------------------------------------------------------------------- #
def render_and_install_pbx(conn, tenant_id: int, *, reload: bool = True,
                          target_dir: str = "/etc/asterisk/vitalpbx") -> Dict[str, Any]:
    """PBX-side: render the tenant's files, install them 0644 owned www-data:root (VitalPBX conf
    ownership), seed the AstDB keys, and reload the affected Asterisk modules. Idempotent — safe to
    re-run; it re-renders the current DB state. Returns the file list + counts. Ownership + reload
    need CAP_CHOWN and the Asterisk control socket (the helper has both)."""
    import grp
    import pwd
    import subprocess
    res = render_and_install(conn, tenant_id, target_dir, apply=True, astdb_apply=True)
    # VitalPBX conf files are www-data:root 0644 so the panel can still rewrite them later.
    try:
        wd = pwd.getpwnam("www-data").pw_uid
        root_g = grp.getgrnam("root").gr_gid
        for name in res["files"]:
            fp = os.path.join(target_dir, name)
            try:
                os.chown(fp, wd, root_g)
            except Exception:
                pass
    except Exception:
        pass
    reloads = []
    if reload:
        for c in RELOAD_COMMANDS:
            r = subprocess.run(["asterisk", "-rx", c], capture_output=True, text=True)
            reloads.append({"cmd": c, "rc": r.returncode})
    res["reloads"] = reloads
    res["fileCount"] = len(res["files"])
    return res


# insert_extension_surgical — pure text
# --------------------------------------------------------------------------- #

def _ext_sort_key(n: str):
    return (0, int(n)) if n.isdigit() else (1, n)


def _split_blocks(text: str) -> List[str]:
    """Split a context body into blank-line separated blocks (each keeps its trailing '\\n\\n')."""
    blocks, cur = [], []
    for line in text.splitlines(True):
        cur.append(line)
        if line == "\n":
            blocks.append("".join(cur))
            cur = []
    if cur:
        blocks.append("".join(cur))
    return blocks


def _find_context(text: str, ctx: str) -> Tuple[int, int]:
    """(start, end) offsets of the body of [ctx] (after its header line, up to the next '[' header or EOF)."""
    m = re.search(r"^\[%s\]\n" % re.escape(ctx), text, re.M)
    if not m:
        raise ValueError("context [%s] not found" % ctx)
    start = m.end()
    m2 = re.compile(r"^\[", re.M).search(text, start)
    end = m2.start() if m2 else len(text)
    return start, end


def _insert_block_ordered(text: str, ctx: str, block: str, key_re: str, new_key: str,
                          order_by_extension_id: bool = False, position_after: Optional[str] = None) -> str:
    """
    Insert `block` into [ctx] among the blocks whose first line matches key_re (group 1 = extension number).
    VitalPBX orders per-extension blocks by extension_id (creation order) — a NEW extension therefore goes
    AFTER the last existing per-extension block, before any trailing non-extension block (e.g. `exten => h`).
    """
    start, end = _find_context(text, ctx)
    body = text[start:end]
    blocks = _split_blocks(body)
    last_idx = -1
    for i, b in enumerate(blocks):
        if re.match(key_re, b):
            last_idx = i
    if not block.endswith("\n\n"):
        block = block.rstrip("\n") + "\n\n"
    blocks.insert(last_idx + 1, block)
    return text[:start] + "".join(blocks) + text[end:]


def surgical_dialplan(text: str, prefix: str, ext: str) -> str:
    """Add FW<ext> (ext-followme), [T_FW<ext>-confirm], VMO<ext> (extvm-operator) for a plain new extension."""
    n = ext
    fw = ("exten => FW%s,1,NoOp(Follow Me: FW%s)\n"
          ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))\n'
          " same => n,Set(__RETURN_ON_EXTERNAL=yes)\n"
          ' same => n,Set(__SKIP_PLAYBACK=${IF($["${QUEUE_CALL}"="TRUE"]?TRUE:${SKIP_PLAYBACK})})\n'
          " same => n,Set(CALLER_RECORDING=${ASTSPOOLDIR}/tmp/followme-${UNIQUEID}.wav)\n"
          " same => n,Set(__O_RING_TIME=30)\n"
          " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)\n"
          ' same => n,Set(__SRC_APP=${IF($["${LEN(${SRC_APP})}"="0"]?FW%s:${SRC_APP})})\n'
          ' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/status):)\n'
          ' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/pls-hold-while-try):)\n'
          " same => n(start-dialing),NoOp(Start Dialing)\n"
          " same => n,Gosub(sub-set-moh,s,1(default,YES))\n"
          " same => n,Set(__SKIP_CONTACT_SERVICES=FALSE)\n"
          " same => n,Return()\n\n" % (n, n, n, n))
    text = _insert_block_ordered(text, prefix + "ext-followme", fw, r"exten => FW(\d+),1,", n)
    confirm = ("[%sFW%s-confirm]\nexten => s,1,NoOp(Confirm Call)\n"
               ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))\n'
               " same => n,Set(DIALED_NUMBER=${CUT(DIALEDPEERNUMBER,@,1)})\n"
               ' same => n,Set(SOUND=${IF($["${LEN(${FWM_RECORDED_NAME})}"="0"]?followme/no-recording:followme/call-from&${FWM_RECORDED_NAME})})\n\n'
               % (prefix, n, n))
    # confirm contexts sit between the last existing [T_FW*-confirm] and [T_extvm-operator]
    heads = list(re.finditer(r"^\[%sFW\d+-confirm\]\n" % re.escape(prefix), text, re.M))
    if heads:
        last = heads[-1]
        nxt = re.compile(r"^\[", re.M).search(text, last.end())
        pos = nxt.start() if nxt else len(text)
    else:
        pos = re.search(r"^\[%sextvm-operator\]\n" % re.escape(prefix), text, re.M).start()
    text = text[:pos] + confirm + text[pos:]
    vmo = ("exten => VMO%s,1,NoOp(Voicemail Operator for extension %s)\n"
           " same => n,Playback(disabled)\n same => n,Return()\n same => n,Hangup()\n\n" % (n, n))
    text = _insert_block_ordered(text, prefix + "extvm-operator", vmo, r"exten => VMO(\d+),1,", n)
    return text


def surgical_hints(text: str, prefix: str, ext: str, devices: Sequence[str]) -> str:
    """Add `exten => <ext>,hint,pjsip/T_<ext>&pjsip/T_<ext>_1&Custom:T_DND_<ext>` after the last extension hint."""
    line = "exten => %s,hint,%s&Custom:%sDND_%s\n\n" % (ext, "&".join("pjsip/%s%s" % (prefix, d) for d in devices), prefix, ext)
    return _insert_block_ordered(text, prefix + "extension-hints", line, r"exten => (\d+),hint,(?!park:)", ext)


def surgical_pjsip(text: str, prefix: str, ext: str, name: str, mailbox: str, tenant_num: int,
                   desk_password: str, webrtc_password: str, language: str = "en", moh: str = "default",
                   cos_ctx: str = "cos-all") -> str:
    """Append endpoint/auth/aor blocks for T_<ext> (p1) and T_<ext>_1 (p12) before the file's final blank line."""
    def blocks(user, prof, dtmf, maxc, pw):
        nm = prefix + user
        return ("[%s](%s)\ntype=endpoint\nauth=auth%s\nidentify_by=username,auth_username\noutbound_auth=auth%s\n"
                "aors=%s\ndeny=0.0.0.0/0\ncontact_deny=0.0.0.0/0\npermit=0.0.0.0/0\ncontact_permit=0.0.0.0/0\n"
                "dtmf_mode=%s\nmessage_context=messages\nset_var=DEVICENAME=%s\nset_var=CHANNEL(parkinglot)=parking-%d\n"
                "subscribe_context=%sextension-hints\nlanguage=%s\nmoh_suggest=%s\ncontext=%s%s\nmailboxes=%s\n"
                "device_state_busy_at=0\ncallerid=\"%s\" <%s>\n\n"
                "[auth%s]\ntype=auth\nauth_type=userpass\nusername=%s\npassword=%s\n\n"
                "[%s](%s-aor)\ntype=aor\nmax_contacts=%d\n\n"
                % (nm, prof, nm, nm, nm, dtmf, nm, tenant_num, prefix, language, moh, prefix, cos_ctx, mailbox,
                   name, ext, nm, nm, pw, nm, prof, maxc))
    add = blocks(ext, "p1", "rfc4733", 1, desk_password) + blocks(ext + "_1", "p12", "auto", 5, webrtc_password)
    body = text.rstrip("\n")
    return body + "\n\n" + add + "\n"


def surgical_voicemail(text: str, ext: str, name: str, email: str, vm_password: str, tenant_hash: str) -> str:
    """Append the mailbox line (VitalPBX orders by extension_id, i.e. a new one is last)."""
    import vitalpbx_mirror as vm
    line = "%s => %s,%s,%s,,attach=yes|saycid=yes|sayduration=yes|envelope=yes|delete=no|hidefromdir=no|operator=no|%s\n" % (
        ext, vm_password, name, email or "", vm.VM_EMAILBODY % dict(hash=tenant_hash, ext=ext))
    return text + line


def surgical_astdb(prefix: str, tenant_hash: str, ext: str, name: str, mailbox: str, features_password: str,
                   vm_password: str, cos_ctx: str = "cos-all", language: str = "en", moh: str = "default") -> Dict[str, str]:
    fam = "/%s" % tenant_hash
    kv: Dict[str, str] = {}
    for dn in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM"):
        kv["%s/diversions/%s/%s/destination" % (fam, ext, dn)] = ""
        kv["%s/diversions/%s/%s/enable" % (fam, ext, dn)] = "no"
        kv["%s/diversions/%s/%s/time_group" % (fam, ext, dn)] = ""
    kv["%s/diversions/%s/PEA/enable" % (fam, ext)] = "no"
    kv["%s/diversions/%s/PEA/time_group" % (fam, ext)] = ""
    kv["%s/diversions/%s/has_enable_diversions" % (fam, ext)] = "no"
    ek = "%s/extensions/%s/" % (fam, ext)
    kv.update({
        ek + "absent_secretary": "no", ek + "ask_vm_password": "yes", ek + "call_waiting": "yes", ek + "callgroup": "",
        ek + "context": prefix + cos_ctx, ek + "dial": "PJSIP/%s%s&PJSIP/%s%s_1" % (prefix, ext, prefix, ext),
        ek + "dial_options": "ktr", ek + "dictate/email": "", ek + "dictate/enabled": "no", ek + "dictate/format": "wav",
        ek + "dynamic_routing": "no", ek + "followme/ringtime": "0", ek + "hints": "no", ek + "hotdesking": "no",
        ek + "is_secretary": "no", ek + "language": language, ek + "lock": "no", ek + "moh": moh, ek + "name": name,
        ek + "notify_missed_calls": "no", ek + "password": features_password, ek + "pickupgroup": "", ek + "pinless": "no",
        ek + "ringtimer": "30", ek + "secretary": "", ek + "skip_vm_instructions": "no", ek + "spyb": "no",
        ek + "virtual_devices": "no", ek + "vm_password": vm_password, ek + "vmenabled": "yes", ek + "voicemail": mailbox,
    })
    for dn in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM", "PEA"):
        kv["/CustomDevstate/%s%s_%s" % (prefix, dn, ext)] = "UNAVAILABLE" if dn == "DND" else "NOT_INUSE"
    return kv


def insert_extension_surgical(existing: Dict[str, str], tenant_num: int, tenant_hash: str, ext: str, name: str,
                              email: str, desk_password: str, webrtc_password: str, features_password: str,
                              vm_password: Optional[str] = None, language: str = "en") -> Tuple[Dict[str, str], Dict[str, str]]:
    """
    existing: {'dialplan': text, 'hints': text, 'pjsip': text, 'voicemail': text} of the tenant's CURRENT
    VitalPBX-generated files. Returns (new_texts, astdb_puts) with only the per-extension blocks added,
    positioned where VitalPBX would put them (per-extension blocks are ordered by extension_id, so a new
    extension is appended after the last existing one).
    """
    prefix = "T%d_" % tenant_num
    slug_m = re.search(r"^\[([a-z0-9_]+)-voicemail\]", existing["voicemail"], re.M)
    if not slug_m:
        raise ValueError("voicemail file has no [<slug>-voicemail] context")
    slug = slug_m.group(1)
    mailbox = "%s@%s-voicemail" % (ext, slug)
    vm_password = vm_password if vm_password is not None else ext
    out = {
        "dialplan": surgical_dialplan(existing["dialplan"], prefix, ext),
        "hints": surgical_hints(existing["hints"], prefix, ext, [ext, ext + "_1"]),
        "pjsip": surgical_pjsip(existing["pjsip"], prefix, ext, name, mailbox, tenant_num, desk_password,
                                webrtc_password, language),
        "voicemail": surgical_voicemail(existing["voicemail"], ext, name, email, vm_password, tenant_hash),
    }
    kv = surgical_astdb(prefix, tenant_hash, ext, name, mailbox, features_password, vm_password, language=language)
    return out, kv


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _connect(a):
    import pymysql
    kw = dict(user=a.user, password=a.password, database=a.db, charset="utf8mb4",
              cursorclass=pymysql.cursors.DictCursor, autocommit=False)  # Plan.execute is ONE transaction
    if getattr(a, "socket", None):
        return pymysql.connect(unix_socket=a.socket, **kw)
    return pymysql.connect(host=a.host, port=a.port, **kw)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for p in (ap,):
        p.add_argument("--host", default=os.environ.get("MIRROR_DB_HOST", "127.0.0.1"))
        p.add_argument("--port", type=int, default=int(os.environ.get("MIRROR_DB_PORT", "3307")))
        p.add_argument("--user", default=os.environ.get("MIRROR_DB_USER", "root"))
        p.add_argument("--password", default=os.environ.get("MIRROR_DB_PASSWORD", "mirror"))
        p.add_argument("--db", default=os.environ.get("MIRROR_DB_NAME", "ombutel"))
        p.add_argument("--socket", default=os.environ.get("MIRROR_DB_SOCKET", ""), help="unix socket (overrides host/port)")
        p.add_argument("--apply", action="store_true", help="execute (default: dry run, print SQL)")

    c = sub.add_parser("create-tenant")
    c.add_argument("--description", required=True)
    c.add_argument("--name", help="slug (default: derived from description)")
    c.add_argument("--tenant-id", type=int)
    c.add_argument("--path", help="16-hex tenant hash (default: random unique)")
    c.add_argument("--user-id", type=int, default=45)
    c.add_argument("--outbound-profiles", default="", help="csv of ombu_ars ids in Main")
    c.add_argument("--dids", default="", help="csv of numbers → ombu_tenant_dids rows only (the panel's inbound_numbers[]); Connect adds the routes later")
    c.add_argument("--no-base-modules", action="store_true", help="do NOT queue the base modules (99/11/8/48/26/29/1) for the next Apply")
    c.add_argument("--fs", action="store_true", help="with --apply: also create the static/provisioning dirs (needs root or CAP_CHOWN)")
    c.add_argument("--json", action="store_true", help="print one JSON object instead of the SQL script")
    c.add_argument("--did")
    c.add_argument("--did-description", default="Main")
    c.add_argument("--did-destination", help="category_id,module_id,index e.g. 1,29,<extension_id>")

    e = sub.add_parser("add-extension")
    e.add_argument("--tenant-id", type=int, required=True)
    e.add_argument("--ext", required=True)
    e.add_argument("--name", required=True)
    e.add_argument("--email", default="")
    e.add_argument("--desk-password")
    e.add_argument("--webrtc-password")
    e.add_argument("--features-password")
    e.add_argument("--vm-password")

    d = sub.add_parser("add-did")
    d.add_argument("--tenant-id", type=int, required=True)
    d.add_argument("--did", required=True)
    d.add_argument("--description", default="Main")
    d.add_argument("--destination", help="category_id,module_id,index")

    r = sub.add_parser("render-and-install")
    r.add_argument("--tenant-id", type=int, required=True)
    r.add_argument("--target-dir", required=True)
    r.add_argument("--astdb-apply", action="store_true")

    a = ap.parse_args(argv)
    conn = _connect(a)

    def dest(s):
        if not s:
            return None
        cat, mod, idx = s.split(",")
        return int(cat), int(mod), idx

    if a.cmd == "create-tenant":
        plan = create_tenant(conn, a.description, name=a.name, tenant_id=a.tenant_id, path=a.path,
                             user_id=a.user_id,
                             outbound_profile_ids=[int(x) for x in a.outbound_profiles.split(",") if x.strip()],
                             did=a.did, did_description=a.did_description, did_destination=dest(a.did_destination),
                             dids=[x for x in a.dids.split(",") if x.strip()], queue_base_modules=not a.no_base_modules)
        if a.json:
            out = {"ok": True, "dryRun": not a.apply, "rows": plan.rows_by_table(), "sql": plan.sql_script()}
            if a.apply:
                ids = plan.execute(conn)
                out["ids"] = ids
                row = q1(conn, "select tenant_id, name, path from ombu_tenants where tenant_id=%s", (ids.get("tenant_id"),))
                out.update({"tenantId": row["tenant_id"], "name": row["name"], "path": row["path"]})
                if a.fs:
                    out["fs"] = apply_tenant_fs(row["path"])
            print(json.dumps(out))
            return
    elif a.cmd == "add-extension":
        plan = add_extension(conn, a.tenant_id, a.ext, a.name, a.email, a.desk_password, a.webrtc_password,
                             features_password=a.features_password, vm_password=a.vm_password)
    elif a.cmd == "add-did":
        plan = add_did(conn, a.tenant_id, a.did, a.description, dest(a.destination))
    else:
        res = render_and_install(conn, a.tenant_id, a.target_dir, apply=a.apply, astdb_apply=a.astdb_apply)
        print(json.dumps(res, indent=2))
        return
    print(plan.sql_script())
    print("-- rows: %s" % json.dumps(plan.rows_by_table()))
    if a.apply:
        ids = plan.execute(conn)
        print("-- APPLIED. ids: %s" % json.dumps(ids))
    else:
        print("-- DRY RUN (nothing written). Re-run with --apply to execute.")


if __name__ == "__main__":
    main()
PYMIRROR
chmod 0644 /opt/connect-pbx-helper/mirror_writes.py
cat >/opt/connect-pbx-helper/vitalpbx_mirror.py <<'PYMIRRORVM'
#!/usr/bin/env python3
"""
VitalPBX mirror generator.

Reads the `ombutel` MySQL database (the same rows the VitalPBX panel writes) and
re-renders, byte for byte, the per-tenant Asterisk config files that VitalPBX's
(ionCube-encrypted, licence-gated) generator writes under
/etc/asterisk/vitalpbx/, plus the AstDB keys it seeds for the tenant.

Library:
    load_tenant(conn, tenant_id) -> model (dict)
    render_tenant(model)         -> {relative_filename: text}
    render_astdb(model)          -> {key: value}   (key = "/<family>/<key>")

CLI:
    vitalpbx_mirror.py render       --tenant N --out DIR
    vitalpbx_mirror.py render-astdb --tenant N

Only stdlib + pymysql. Python 3.11 compatible.

Every template below was cut from the real files VitalPBX generated on the
production PBX (baseline 2026-08-18) and the DB→text mapping was established
by comparing DB rows with the rendered text; see README.md in this folder.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------- #
# Constants that VitalPBX renders identically for every tenant
# --------------------------------------------------------------------------- #

BANNER = (
    "; *********************************************************************************\n"
    "; @Date : {date}\n"
    "; @Document : {doc}\n"
    "; @Author : VitalPBX\n"
    "; @Platform : VitalPBX\n"
    "; *********************************************************************************\n"
    "\n"
)

# The 14 file kinds VitalPBX writes per tenant (plus the 3 register/menu stubs).
# value = template body used when the tenant contributes nothing to the file
FILE_KINDS = [
    ("extensions__50-{t}-dialplan.conf", None),
    ("extensions__25-{t}-hints.conf", None),
    ("pjsip__50-{t}-extensions.conf", None),
    ("pjsip__50-{t}-trunks.conf", ""),
    ("voicemail__50-{t}-main.conf", None),
    ("queues__50-{t}-main.conf", None),
    ("musiconhold__50-{t}-main.conf", None),
    ("res_parking__50-{t}-extensions.conf", None),
    ("confbridge__50-{t}-profiles.conf", ""),
    ("confbridge__40-{t}-menu.conf", ""),
    ("manager__50-{t}-users.conf", "\n"),
    ("iax__50-{t}-extensions.conf", "\n"),
    ("iax__50-{t}-trunks.conf", ""),
    ("iax__20-{t}-registers.conf", "[general](+)\n"),
    ("sip__50-{t}-extensions.conf", "\n"),
    ("sip__50-{t}-trunks.conf", ""),
    ("sip__20-{t}-registers.conf", "[general](+)\n"),
]

FEATURE_CATEGORY_ALL = """include => feature-account_code
include => feature-boss_secretary
include => feature-attended_transfer
include => feature-one_touch_rec
include => feature-auth_code
include => feature-add_num_blacklist
include => feature-add_last_caller_blacklist
include => feature-remove_number_blacklist
include => feature-blind_transfer
include => feature-cancel_cc
include => feature-request_cc
include => feature-set_cfb_number
include => feature-toggle_cfb
include => feature-set_cfu_number
include => feature-toggle_cfu
include => feature-toggle_cfn
include => feature-set_cfn_number
;include => feature-spy_random_chn
include => feature-change_ext_pwd
include => feature-clear_all_diversions
include => feature-cust_recording
include => feature-dictation_services
include => feature-direct_vm
include => feature-direct_pickup
include => feature-disconnect_call
include => feature-dnd
include => feature-echo_test
include => feature-follow_me
include => feature-hot_desking
include => feature-dial_by_name_dir
include => feature-lock_unlock_phone
include => feature-nm_all
include => feature-park_call
include => feature-personal_assistant
include => feature-pickup_group
include => feature-rec_msg_pa
include => feature-reminder
include => feature-remote_substitution
include => feature-remote_vm
;include => feature-remote_wakeup_call
include => feature-say_date_time
include => feature-simulate_incoming_call
include => feature-speak_last_number
include => feature-speak_ext_number
;include => feature-spy_extension
;include => feature-spy_ext_whisper
include => feature-add_remove_queue_agent
include => feature-pause_unpause_queue_agent
include => feature-request_wakeup_call
include => feature-toggle_cfi
include => feature-set_cfi_number
include => feature-queues_login_logout
include => feature-queues-pause-unpause
include => feature-send_vm_msg
;include => feature-spy_ext_barge
include => feature-paging_and_intercom
include => feature-hot_desking_cc
include => feature-paging_duplex
include => feature-anonymous_calling
include => feature-auto_recording_switch_in
include => feature-auto_recording_switch_out
"""

# order + include/comment of the [T_applications] block; each entry: (suffix, module key)
APPLICATIONS_ORDER = [
    ("speedial", "speed_dials"),
    ("custom-application", "custom_applications"),
    ("custom-destination", "custom_destinations"),
    ("paging", "pages"),
    ("vmgroup", "vmgroups"),
    ("queues-priority", "queue_priorities"),
    ("disa", "ALWAYS"),
    ("ivr", "ivrs"),
    ("announcement", "announcements"),
    ("languages", "languages"),
    ("nightmode", "nightmodes"),
    ("call-back", "callbacks"),
    ("rec-management", "rec_management"),
    ("time-condition", "time_conditions"),
    ("ai-assistants", "ALWAYS"),
]

VM_EMAILBODY = (
    "emailbody=category:${VM_CATEGORY}\\nvm_name:${VM_NAME}\\nduration:${VM_DUR}"
    "\\nmsg_num:${VM_MSGNUM}\\ncid:${VM_CALLERID}\\ncid_name:${VM_CIDNAME}"
    "\\ncid_num:${VM_CIDNUM}\\ndate:${VM_DATE}\\nmsg_file:${VM_MESSAGEFILE}"
    "\\ntenant:%(hash)s\\nextension:%(ext)s\\nmailbox:${VM_MAILBOX}"
)


def vitalpbx_date(ts: Optional[float] = None) -> str:
    """PHP date('D M j G:i:s T Y') in GMT, e.g. 'Tue Aug 18 3:00:50 GMT 2026'."""
    tm = time.gmtime(ts if ts is not None else time.time())
    return "%s %s %d %d:%02d:%02d GMT %d" % (
        time.strftime("%a", tm), time.strftime("%b", tm), tm.tm_mday,
        tm.tm_hour, tm.tm_min, tm.tm_sec, tm.tm_year)


def banner(doc: str, date: Optional[str] = None) -> str:
    return BANNER.format(date=date or vitalpbx_date(), doc=doc)


# --------------------------------------------------------------------------- #
# DB access
# --------------------------------------------------------------------------- #

def connect(host="127.0.0.1", port=3307, user="root", password="mirror", db="ombutel"):
    import pymysql
    return pymysql.connect(host=host, port=port, user=user, password=password,
                           database=db, charset="utf8mb4",
                           cursorclass=pymysql.cursors.DictCursor, autocommit=True)


def q(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return list(cur.fetchall())


def q1(conn, sql: str, args=()) -> Optional[Dict[str, Any]]:
    rows = q(conn, sql, args)
    return rows[0] if rows else None


def yn(v) -> str:
    return "yes" if str(v).lower() in ("yes", "1", "true") else "no"


def nz(v, default="") -> str:
    return default if v is None else str(v)


# --------------------------------------------------------------------------- #
# Model loading
# --------------------------------------------------------------------------- #

def load_tenant(conn, tenant_id: int) -> Dict[str, Any]:
    t = tenant_id
    tenant = q1(conn, "select * from ombu_tenants where tenant_id=%s", (t,))
    if not tenant:
        raise SystemExit("tenant %s not found" % t)
    settings = {r["name"]: r["value"] for r in
                q(conn, "select name,value from ombu_tenant_settings where tenant_id=%s", (t,))}
    gsettings = {r["name"]: r["value"] for r in
                 q(conn, "select name,value from ombu_settings where module_id=128")}

    def dyn(name):
        v = gsettings.get("T%d_%s" % (t, name), gsettings.get(name))
        return v

    music_groups = {r["music_group_id"]: r for r in q(conn, "select * from ombu_music_groups")}
    cos_rows = q(conn, "select * from ombu_classes_of_service where tenant_id=%s order by class_of_service_id", (t,))
    dial_profiles = {r["dial_profile_id"]: r for r in
                     q(conn, "select * from ombu_dial_profiles where tenant_id=%s", (t,))}
    parking = q(conn, "select * from ombu_parking_lots where tenant_id=%s order by parking_lot_id", (t,))
    ars_own = q(conn, "select * from ombu_ars where tenant_id=%s order by ars_id", (t,))
    pickup_groups = q(conn, "select * from ombu_pickup_groups where tenant_id=%s order by pickup_group_id", (t,))
    pickup_members = {}
    for pg in pickup_groups:
        for m in q(conn, "select * from ombu_pickup_group_members where pickup_group_id=%s", (pg["pickup_group_id"],)):
            pickup_members.setdefault(m["extension_id"], []).append(pg)

    exts = q(conn, "select * from ombu_extensions where tenant_id=%s order by extension_id", (t,))
    for e in exts:
        eid = e["extension_id"]
        e["devices"] = q(conn, "select * from ombu_devices where extension_id=%s order by device_id", (eid,))
        for d in e["devices"]:
            d["pjsip"] = q1(conn, "select * from ombu_pjsip_devices where device_id=%s", (d["device_id"],))
            d["virtual"] = q1(conn, "select * from ombu_virtual_devices where device_id=%s", (d["device_id"],))
        e["vm"] = q1(conn, "select * from ombu_extensions_vm where extension_id=%s", (eid,))
        e["followme"] = q1(conn, "select * from ombu_followme where extension_id=%s", (eid,))
        e["diversions"] = q(conn, "select * from ombu_extension_diversions where extension_id=%s", (eid,))
        e["pea"] = q1(conn, "select * from ombu_extension_pea where extension_id=%s", (eid,))
        e["contact"] = q1(conn, "select * from ombu_extensions_contact_info where extension_id=%s", (eid,))
        e["pickup_groups"] = pickup_members.get(eid, [])
        e["cos"] = next((c for c in cos_rows if c["class_of_service_id"] == e["class_of_service_id"]), None)
        e["dial_profile"] = dial_profiles.get(e["dial_profile_id"])
        e["music_group"] = music_groups.get(e["music_group_id"])

    inbound = q(conn, "select * from ombu_inbound_routes where tenant_id=%s order by inbound_route_id", (t,))
    emergency_cats = q(conn, "select * from ombu_emergency_number_categories where tenant_id=%s order by id", (t,))
    for c in emergency_cats:
        c["numbers"] = q(conn, "select * from ombu_emergency_numbers where category_id=%s order by sort, id", (c["id"],))
        c["trunks"] = q(conn, "select * from ombu_emergency_trunks where category_id=%s order by trunk_id", (c["id"],))
    emergency_locations = q(conn, "select * from ombu_emergency_locations where tenant_id=%s order by id", (t,))
    custom_apps = q(conn, "select * from ombu_custom_applications where tenant_id=%s order by custom_application_id", (t,))
    custom_dests = q(conn, "select * from ombu_custom_destinations where tenant_id=%s order by custom_destination_id", (t,))
    ring_groups = q(conn, "select * from ombu_ring_groups where tenant_id=%s order by ring_group_id", (t,))
    for rg in ring_groups:
        rg["members"] = q(conn, "select * from ombu_ring_group_members where ring_group_id=%s order by id", (rg["ring_group_id"],)) \
            if _table_has(conn, "ombu_ring_group_members", "id") else \
            q(conn, "select * from ombu_ring_group_members where ring_group_id=%s", (rg["ring_group_id"],))
    queues = q(conn, "select * from ombu_queues where tenant_id=%s order by queue_id", (t,))
    for qu in queues:
        qu["members"] = q(conn, "select * from ombu_queue_members where queue_id=%s", (qu["queue_id"],))
    ivrs = q(conn, "select * from ombu_ivrs where tenant_id=%s order by ivr_id", (t,))
    time_conditions = q(conn, "select * from ombu_time_conditions where tenant_id=%s order by time_condition_id", (t,))
    time_groups = q(conn, "select * from ombu_time_groups where tenant_id=%s order by time_group_id", (t,))
    announcements = q(conn, "select * from ombu_announcements where tenant_id=%s order by announcement_id", (t,))
    pages = q(conn, "select * from ombu_pages where tenant_id=%s order by page_id", (t,))
    tenant_music_groups = [g for g in music_groups.values() if g["tenant_id"] == t]

    model = dict(
        conn=conn,
        tenant=tenant, t=t, prefix="T%d_" % t, hash=tenant["path"], slug=tenant["name"],
        settings=settings,
        dyn=dict(delete_used_records=dyn("delete_used_records"), digits_match=dyn("digits_match"),
                 expiration_time=dyn("expiration_time"), only_missed_calls=dyn("only_missed_calls")),
        music_groups=music_groups, tenant_music_groups=tenant_music_groups,
        cos=cos_rows, dial_profiles=dial_profiles, parking=parking, ars_own=ars_own,
        extensions=exts, inbound=inbound,
        emergency_cats=emergency_cats, emergency_locations=emergency_locations,
        custom_apps=custom_apps, custom_dests=custom_dests,
        ring_groups=ring_groups, queues=queues, ivrs=ivrs,
        time_conditions=time_conditions, time_groups=time_groups,
        announcements=announcements, pages=pages,
        pickup_groups=pickup_groups,
    )
    return model


_col_cache: Dict[str, set] = {}


def _table_has(conn, table: str, col: str) -> bool:
    if table not in _col_cache:
        _col_cache[table] = {r["Field"] for r in q(conn, "describe %s" % table)}
    return col in _col_cache[table]


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def moh_name(m, group_id) -> str:
    """music_group_id -> the MOH class name Asterisk uses (default / mohN)."""
    if group_id in (None, "", 0):
        return "default"
    g = m["music_groups"].get(int(group_id))
    if g is None:
        return "default"
    if g["name"] == "default" and g["tenant_id"] == 1 and int(group_id) == 1:
        return "default"
    return "moh%d" % int(group_id)


def dial_options(dp) -> str:
    """ombu_dial_profiles -> Dial() option string (AstDB dial_options)."""
    if not dp:
        return "ktr"
    opts = ""
    if dp.get("allow_parking") in ("called", "both"):
        opts += "k"
    if dp.get("allow_parking") in ("caller", "both"):
        opts += "K"
    if dp.get("allow_transfer") in ("called", "both"):
        opts += "t"
    if dp.get("allow_transfer") in ("caller", "both"):
        opts += "T"
    if dp.get("ringing_tone") == "yes":
        opts += "r"
    if dp.get("custom_options"):
        opts += dp["custom_options"]
    return opts


def ext_dial_string(m, e) -> str:
    """AstDB extensions/N/dial: PJSIP/<dev>[&...] and Local/<num>@T_cos-all for virtual devices."""
    parts = []
    for d in e["devices"]:
        if d.get("ring_device") != "yes":
            continue
        if d["technology"] == "pjsip":
            parts.append("PJSIP/%s%s" % (m["prefix"], d["user"]))
        elif d["technology"] == "virtual" and d.get("virtual"):
            parts.append("Local/%s@%s%s" % (d["virtual"]["number"], m["prefix"], cos_context(e)))
        elif d["technology"] == "sip":
            parts.append("SIP/%s%s" % (m["prefix"], d["user"]))
        elif d["technology"] == "iax":
            parts.append("IAX2/%s%s" % (m["prefix"], d["user"]))
    return "&".join(parts)


def cos_context(e) -> str:
    return "cos-%s" % (e["cos"]["cos"] if e.get("cos") else "all")


# --------------------------------------------------------------------------- #
# Destinations
# --------------------------------------------------------------------------- #

def dest_target(m, dest_id) -> Optional[str]:
    """Resolve an ombu_destinations id to the 'context,exten,priority' VitalPBX writes into Goto()."""
    if dest_id is None:
        return None
    conn = m["conn"]
    d = q1(conn, "select * from ombu_destinations where id=%s", (dest_id,))
    if not d:
        return None
    p = m["prefix"]
    cat, idx = int(d["category_id"]), d["index"]
    if cat == 1:  # extension
        e = q1(conn, "select extension, class_of_service_id, tenant_id from ombu_extensions where extension_id=%s", (idx,))
        if not e:
            return None
        cos = q1(conn, "select cos from ombu_classes_of_service where class_of_service_id=%s", (e["class_of_service_id"],))
        return "T%d_cos-%s,%s,1" % (e["tenant_id"], cos["cos"] if cos else "all", e["extension"])
    if cat == 31:  # inbound route "verify DID"
        return "verify-did,${CALL_DESTINATION},1"
    if cat == 24:  # terminate call
        return "app-termination,%s,1" % {"1": "hangup", "2": "busy", "3": "congestion", "4": "zapateller", "5": "playtone"}.get(str(idx), "hangup")
    if cat == 33:  # custom context
        cc = q1(conn, "select * from ombu_custom_contexts where cc_id=%s", (idx,))
        if cc:
            # NOTE: the panel renders Goto(T<t>_custom-contexts,cc-<id>,1); the connect-pbx-helper
            # bakes the real target in its place. We render the real target, which is what is on disk.
            return "%s,%s,%s" % (cc["context"], cc["extension"], cc["priority"])
        return None
    if cat == 6:  # custom destination
        return "%sapp-custom-destination,custom-dest-%s,1" % (p, idx)
    if cat == 5:  # custom application
        ca = q1(conn, "select * from ombu_custom_applications where custom_application_id=%s", (idx,))
        return "%sapp-custom-application,%s,1" % (p, ca["extension"]) if ca else None
    if cat == 13:  # ring group
        rg = q1(conn, "select * from ombu_ring_groups where ring_group_id=%s", (idx,))
        return "%sext-ringgroups,%s,1" % (p, rg["extension"]) if rg else None
    if cat == 14:  # queue
        qu = q1(conn, "select * from ombu_queues where queue_id=%s", (idx,))
        return "%sext-queues,%s,1" % (p, qu["extension"]) if qu else None
    if cat == 16:  # ivr
        return "%sapp-ivr,IVR-%s,1" % (p, idx)
    if cat == 17:  # time condition
        return "%sapp-time-condition,TC-%s,1" % (p, idx)
    if cat == 18:  # announcement
        return "%sapp-announcement,announcement-%s,1" % (p, idx)
    if cat == 25:  # voicemail direct
        return _vm_dest(m, idx, "VM")
    if cat == 26:  # voicemail busy
        return _vm_dest(m, idx, "VMB")
    if cat == 27:  # voicemail unavailable
        return _vm_dest(m, idx, "VMU")
    if cat == 28:  # follow me
        e = q1(conn, "select extension from ombu_extensions where extension_id=%s", (idx,))
        return "%sext-followme,FW%s,1" % (p, e["extension"]) if e else None
    if cat == 12:  # disa
        return "%sapp-disa,DISA-%s,1" % (p, idx)
    if cat == 11:  # callback
        return "%sapp-call-back,CB-%s,1" % (p, idx)
    if cat == 20:  # night mode
        return "%sapp-nightmode,NM-%s,1" % (p, idx)
    if cat == 19:  # languages
        return "%sapp-languages,LANG-%s,1" % (p, idx)
    if cat == 15:  # queue priority
        return "%sapp-queues-priority,QP-%s,1" % (p, idx)
    if cat == 4:  # conference
        c = q1(conn, "select * from ombu_conferences where conference_id=%s", (idx,))
        return "%sext-conferences,%s,1" % (p, c["extension"]) if c else None
    if cat == 9:  # speed dial
        return "%sapp-speedial,%s,1" % (p, idx)
    if cat == 8:  # parking
        return "%sext-parking,%s,1" % (p, idx)
    if cat == 34:  # dynamic destination
        return "%sapp-dynamic-destinations,DD-%s,1" % (p, idx)
    if cat == 35:  # queue callback
        return "QUEUE-CALLBACK-IVR-%s,s,1" % idx
    return "UNKNOWN-DEST-CATEGORY-%s,%s,1" % (cat, idx)


def _vm_dest(m, ext_id, kind) -> Optional[str]:
    e = q1(m["conn"], "select extension from ombu_extensions where extension_id=%s", (ext_id,))
    if not e:
        return None
    return "sub-extensions-vm,%s-%s,1" % (kind, e["extension"])


def goto(m, dest_id) -> str:
    tgt = dest_target(m, dest_id)
    return "Goto(%s)" % tgt if tgt else "Hangup()"


# --------------------------------------------------------------------------- #
# Renderers — dialplan
# --------------------------------------------------------------------------- #

def r_ext_followme(m) -> str:
    p, h = m["prefix"], m["hash"]
    out = ["[%sext-followme]\n" % p]
    for e in m["extensions"]:
        n = e["extension"]
        fm = e["followme"] or {}
        lines = [
            "exten => FW%s,1,NoOp(Follow Me: FW%s)" % (n, n),
            ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))' % n,
            " same => n,Set(__RETURN_ON_EXTERNAL=yes)",
            ' same => n,Set(__SKIP_PLAYBACK=${IF($["${QUEUE_CALL}"="TRUE"]?TRUE:${SKIP_PLAYBACK})})',
            " same => n,Set(CALLER_RECORDING=${ASTSPOOLDIR}/tmp/followme-${UNIQUEID}.wav)",
            " same => n,Set(__O_RING_TIME=%s)" % (fm.get("ringtime") or 30),
            " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)",
            ' same => n,Set(__SRC_APP=${IF($["${LEN(${SRC_APP})}"="0"]?FW%s:${SRC_APP})})' % n,
        ]
        if fm.get("enable_callee_prompt") == "yes":
            lines.append(" same => n,Set(__FWM_CONFIRMATION_CONTEXT=%sFW%s-confirm)" % (p, n))
        if fm.get("status_prompt_id"):
            lines.append(' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/status):)')
        if fm.get("pls_hold_prompt_id"):
            lines.append(' same => n,ExecIf($["${SKIP_PLAYBACK}"!="TRUE"]?Playback(followme/pls-hold-while-try):)')
        lines.append(" same => n(start-dialing),NoOp(Start Dialing)")
        lines.append(" same => n,Gosub(sub-set-moh,s,1(%s,YES))" % moh_name(m, fm.get("music_group_id")))
        nums = [x for x in (fm.get("followme_numbers") or "").replace("&", ",").split(",") if x.strip()]
        if nums:
            ring = fm.get("ringtime") or 30
            if fm.get("ring_strategy") == "ring_all":
                lines.append(" same => n,Dial(%s,%s,r)" % ("&".join("Local/%s@%s%s/n" % (x.strip(), p, cos_context(e)) for x in nums), ring))
            else:
                for x in nums:
                    lines.append(" same => n,Dial(Local/%s@%s%s/n,%s,r)" % (x.strip(), p, cos_context(e), ring))
            lines.append(" same => n,System(rm -f ${CALLER_RECORDING})")
        lines.append(" same => n,Set(__SKIP_CONTACT_SERVICES=FALSE)")
        lines.append(" same => n,Return()")
        out.append("\n".join(lines) + "\n\n")
    out.append("exten => h,1,NoOp(Finish Follow-me call)\n same => n,System(rm -f ${CALLER_RECORDING})\n\n")
    return "".join(out)


def r_fw_confirm(m) -> str:
    p = m["prefix"]
    out = []
    for e in m["extensions"]:
        n = e["extension"]
        fm = e["followme"] or {}
        lines = [
            "[%sFW%s-confirm]" % (p, n),
            "exten => s,1,NoOp(Confirm Call)",
            ' same => n,ExecIf($["${LEN(${INBOUND_LANGUAGE})}"!="0"]?Set(CHANNEL(language)=${INBOUND_LANGUAGE}):Set(CHANNEL(language)=${DB(${TENANT}/extensions/%s/language)}))' % n,
            " same => n,Set(DIALED_NUMBER=${CUT(DIALEDPEERNUMBER,@,1)})",
            ' same => n,Set(SOUND=${IF($["${LEN(${FWM_RECORDED_NAME})}"="0"]?followme/no-recording:followme/call-from&${FWM_RECORDED_NAME})})',
        ]
        if fm.get("enable_callee_prompt") == "yes":
            lines += [
                " same => n,Set(GOSUB_RESULT=CONTINUE)",
                " same => n,Read(CONFIRM,${SOUND}&followme/options,1,,1,5)",
                ' same => n(accept),Set(_GOSUB_RESULT=${IF($["${CONFIRM}" = "1"]?:${GOSUB_RESULT})})',
                " same => n,Return()",
            ]
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_extvm_operator(m) -> str:
    p = m["prefix"]
    if not m["extensions"]:
        return ""
    out = ["[%sextvm-operator]\n" % p]
    for e in m["extensions"]:
        n = e["extension"]
        vm = e["vm"] or {}
        lines = ["exten => VMO%s,1,NoOp(Voicemail Operator for extension %s)" % (n, n)]
        if vm.get("operator_destination_id"):
            lines.append(" same => n,%s" % goto(m, vm["operator_destination_id"]))
        else:
            lines.append(" same => n,Playback(disabled)")
            lines.append(" same => n,Return()")
        lines.append(" same => n,Hangup()")
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_extvm_greetings(m) -> str:
    """[T_sub-extvm-greetings] – only when some mailbox has a custom busy/unavailable greeting."""
    p, h = m["prefix"], m["hash"]
    entries = []
    for e in m["extensions"]:
        vm = e["vm"] or {}
        for col, kind, word in (("busy_greeting_id", "VMB", "busy"), ("unav_greeting_id", "VMU", "unavailable")):
            rid = vm.get(col)
            if rid:
                rec = q1(m["conn"], "select * from ombu_recordings where recording_id=%s", (rid,))
                if rec:
                    entries.append((e["extension"], kind, word, rec))
    if not entries:
        return ""
    out = ["[%ssub-extvm-greetings]\n" % p]
    for n, kind, word, rec in entries:
        out.append("exten => %s%s,1,NoOp(Playing %s message for extension %s)\n"
                   " same => n,Playback(/var/lib/vitalpbx/static/%s/recordings/%s)\n"
                   " same => n,Return()\n same => n,Hangup()\n\n" % (kind, n, word, n, h, rec["file"] if "file" in rec else rec.get("filename")))
    return "".join(out)


def r_custom_apps(m) -> str:
    p = m["prefix"]
    if not m["custom_apps"]:
        return ""
    out = ["[%sapp-custom-application]\n" % p]
    for ca in m["custom_apps"]:
        out.append("exten => %s,1,Gosub(sub-set-call-vars,app-incoming,1)\n"
                   " same => n,NoOp(Custom Application: %s)\n"
                   " same => n,%s\n"
                   " same => n,Hangup()\n\n" % (ca["extension"], ca["description"], goto(m, ca["destination_id"])))
    return "".join(out)


def r_custom_dests(m) -> str:
    p = m["prefix"]
    if not m["custom_dests"]:
        return ""
    out = ["[%sapp-custom-destination]\n" % p]
    for cd in m["custom_dests"]:
        # cid_name/cid_number are NULL on every live row; the form used when set is UNVERIFIED (see README)
        if cd.get("cid_name") or cd.get("cid_number"):
            cid = '"%s" <%s>' % (cd.get("cid_name") or "${CALLERID(name)}", cd.get("cid_number") or "${CALLERID(number)}")
        else:
            cid = '"${CALLERID(name)}" <${CALLERID(number)}>'
        # class_of_service_id may point at ANOTHER tenant's row (live: T105 rows carry cos id 2 = T2's);
        # the panel renders the tenant's own prefix + the referenced row's cos NAME.
        cos = q1(m["conn"], "select cos from ombu_classes_of_service where class_of_service_id=%s", (cd["class_of_service_id"],))
        ctx = "%scos-%s" % (p, cos["cos"] if cos else "all")
        out.append("exten => custom-dest-%s,1,NoOp(Custom Destination: %s)\n"
                   ' same => n,ExecIf($[$["${CALL_TYPE}"!="1"]&$["DISABLE_CF_AA"!="TRUE"]]?Answer():)\n'
                   ' same => n,ExecIf($["${CALL_TYPE}"="2"]?Set(__EXT_CID_CONSTRUCTED=yes):)\n'
                   " same => n,Set(CALLERID(all)=%s)\n"
                   " same => n,Goto(%s,%s,1)\n\n" % (cd["custom_destination_id"], cd["description"], cid, ctx, cd["destination"]))
    return "".join(out)


def r_parking(m) -> str:
    p, t = m["prefix"], m["t"]
    out = []
    for lot in m["parking"]:
        name = "parking-%d" % t if lot.get("defpark") == "yes" else "parking-%d-%s" % (t, lot["extension"])
        ext = int(lot["extension"])
        npos = int(lot["parkpos"])
        first, last = ext + 1, ext + npos
        out.append("[%sext-parking]\ninclude => %s-parkedcalls\n\n" % (p, name))
        out.append("exten => %s,1,NoOp(Parking Call)\n same => n,Park(%s,c(%s-callback,s,1))\n\n" % (ext, name, name))
        rec = yn(lot.get("record"))
        for pat in slot_patterns(first, last):
            out.append("exten => %s,1,NoOp(Slot: ${CALL_DESTINATION})\n"
                       " same => n,Set(RECORD_PARKING_LOT=%s)\n"
                       " same => n,Gosub(sub-parking-lots,s,1(${CALL_DESTINATION},%s,%s-parkedcalls))\n\n" % (pat, rec, name, name))
        out.append("[%s-parkedcallstimeout]\nexten => s,1,NoOp(Parking Timeout has been reached)\n"
                   " same => n,Gosub(app-termination,hangup,1)\n same => n,Hangup()\n\n" % name)
        out.append("[%s-callback]\nexten => s,1,NoOp(Returning Call)\n"
                   ' same => n,Set(CALLBACK_EXT=${IF($["${CALL_TYPE}"="3"]?${CALLER}:${DESTINATION_NUMBER})})\n'
                   " same => n,Set(CALLBACK_CTXT=${TRANSFER_CONTEXT})\n"
                   ' same => n,GotoIf($[$["${LEN(${CALLBACK_EXT})}"="0"]|$["${LEN(${CALLBACK_CTXT})}"="0"]]?end)\n'
                   " same => n,Goto(${CALLBACK_CTXT},${CALLBACK_EXT},1)\n"
                   " same => n(end),Hangup()\n\n" % name)
    return "".join(out)


def slot_patterns(first: int, last: int) -> List[str]:
    """VitalPBX writes _70[1-9] then _710 for 701-710. Generalised: one pattern per leading prefix."""
    pats = []
    n = first
    while n <= last:
        prefix, digit = str(n)[:-1], int(str(n)[-1])
        end = min(last, int(prefix + "9"))
        if end == n:
            pats.append("_%d" % n)
        else:
            pats.append("_%s[%d-%d]" % (prefix, digit, int(str(end)[-1])))
        n = end + 1
    return pats


def r_applications(m) -> str:
    p = m["prefix"]
    present = {
        "custom_applications": bool(m["custom_apps"]),
        "custom_destinations": bool(m["custom_dests"]),
        "pages": bool(m["pages"]),
        "ivrs": bool(m["ivrs"]),
        "announcements": bool(m["announcements"]),
        "time_conditions": bool(m["time_conditions"]),
    }
    lines = ["[%sapplications]" % p]
    for suffix, key in APPLICATIONS_ORDER:
        on = key == "ALWAYS" or present.get(key, False)
        lines.append("%sinclude => %sapp-%s" % ("" if on else ";", p, suffix))
    return "\n".join(lines) + "\n\n\n"


def r_extensions_include(m) -> str:
    p = m["prefix"]
    conf = "" if m.get("conferences") else ";"
    return ("[%sextensions]\n%sinclude => %sext-conferences\ninclude => %sext-parking\n"
            "include => %sext-ringgroups\ninclude => %sext-queues\n\n\n" % (p, conf, p, p, p, p))


def r_hot_desking(m) -> str:
    p, h, s = m["prefix"], m["hash"], m["slug"]
    def blk(exten, noop, tail):
        return ("exten => %s,1,Set(CDR(source)=${CALLERID(num)})\n"
                " same => n,Set(CDR(destination)=${EXTEN})\n"
                " same => n,Set(CDR(tenant)=%s)\n"
                " same => n,NoOp(%s)\n"
                " same => n,Set(__TENANT=%s)\n"
                " same => n,Set(__TENANT_PREFIX=%s)\n"
                "%s\n" % (exten, s, noop, h, p, tail))
    def blk2(exten, noop, feature):
        return ("exten => %s,1,Gosub(sub-get-device-tree,s,1)\n"
                " same => n,Set(__CALL_DESTINATION=${EXTEN})\n"
                " same => n,Set(CDR(source)=${CALLERID(num)})\n"
                " same => n,Set(CDR(destination)=${EXTEN})\n"
                " same => n,Set(CDR(tenant)=%s)\n"
                " same => n,NoOp(%s)\n"
                " same => n,Set(__TENANT=%s)\n"
                " same => n,Set(__TENANT_PREFIX=%s)\n"
                " same => n,Gosub(%sset-global-tenant-vars,s,1)\n"
                " same => n,Gosub(%s,${EXTEN},1)\n"
                " same => n,Hangup()\n\n" % (exten, s, noop, h, p, p, feature))
    out = ["[%shot-desking-context]\n" % p]
    out.append(blk("*80", "Hot Desking Feature",
                   " same => n,Gosub(%sset-global-tenant-vars,s,1)\n same => n,Gosub(sub-hot-desking,s,1)\n same => n,Hangup()\n" % p))
    out.append(blk2("_*80*[0-9]!", "Hot Desking Direct Feature", "feature-hot_desking"))
    out.append(blk2("*90", "Hot Desking CC Feature", "feature-hot_desking_cc"))
    out.append(blk2("_*90#[+*0-9]!", "Hot Desking CC Feature", "feature-hot_desking_cc"))
    out.append(blk2("_*90#[+*0-9]!#[*0-9].", "Hot Desking CC Feature", "feature-hot_desking_cc"))
    out.append(blk("_[-+*#0-9a-zA-Z].", "Hot Desking",
                   " same => n,Gosub(sub-hot-desking-call,s,1(${EXTEN}))\n"))
    return "".join(out)


def r_cos(m) -> str:
    """The [T_cos-<name>*] context family, one per class of service."""
    p, h, s, t = m["prefix"], m["hash"], m["slug"], m["t"]
    out = []
    default_park = next((l for l in m["parking"] if l.get("defpark") == "yes"), None)
    park = "parking-%d" % t if default_park else ""
    for c in m["cos"]:
        name = c["cos"]
        cid = c["class_of_service_id"]
        ctx = "%scos-%s" % (p, name)
        ars = "%sARS-%s" % (p, name)
        cat = "%sall-features-category" % p if c.get("feature_code_category_id") is None else "%sfeature-category-%s" % (p, c["feature_code_category_id"])
        out.append("[%s]\ninclude => %s-init\n\n\n" % (ctx, ctx))
        out.append("[%s-init]\n"
                   "exten => _[-+*#0-9a-zA-Z].,1,NoOp(More than on digit pattern)\n"
                   " same => n,Gosub(s,1(${EXTEN}))\n\n"
                   "exten => _[-+*#0-9a-zA-Z],1,NoOp(One Digit pattern)\n"
                   " same => n,Gosub(s,1(${EXTEN}))\n\n"
                   "exten => i,1,NoOp(Invalid dial on init section)\n"
                   " same => n,ForkCDR(e)\n"
                   ' same => n,ExecIf($[$["${FROM_QUEUE_CALLBACK}"="yes"]|$["${SRC_APP}"="IVR"]]?Hangup():)\n'
                   " same => n,Goto(invalid-dest-cos,s,1)\n\n"
                   "exten => h,1,NoCDR()\n"
                   " same => n,NoOp(Hanging Up the Call)\n"
                   " same => n,Hangup()\n\n"
                   "exten => s,1,Set(EXTENSION=${ARG1})\n"
                   " same => n,NoOp(Dialing ${EXTENSION} from ${CALLERID(num)})\n"
                   " same => n,Gosub(sub-set-global-vars,s,1(%s,${EXTENSION},%s))\n"
                   " same => n,Gosub(sub-set-call-vars,s,1(%s,${EXTENSION},%s,%s,%s))\n"
                   " same => n,Gosub(sub-construct-cid,s,1)\n"
                   " same => n,Gosub(%sset-global-tenant-vars,s,1)\n"
                   ' same => n,GotoIf($["${CALL_ORIGIN}"="RESTRICTED_IVR_CALL"]?local-dialing)\n'
                   " same => n,NoOp(Check if is an Emergency Call)\n"
                   " same => n,GotoIf($[${DIALPLAN_EXISTS(%semergency-calls,${EXTENSION},1)}=1]?%semergency-calls,${EXTENSION},1)\n"
                   " same => n,Gosub(sub-lockphone-check,s,1)\n"
                   " same => n(local-dialing),Gosub(sub-local-dialing,s,1)\n"
                   ' same => n,GotoIf($["${CALL_ORIGIN}"="RESTRICTED_IVR_CALL"]?end-call)\n'
                   " same => n,Set(OUTBOUND_PROFILE=${DB(${TENANT}/extensions/${CALL_SOURCE}/outbound_profile)})\n"
                   ' same => n,GotoIf($[$["${OUTBOUND_PROFILE}"="disabled"]|$["X${OUTBOUND_PROFILE}X"="XX"]]?post-dialing)\n'
                   " same => n,GotoIf($[${DIALPLAN_EXISTS(${OUTBOUND_PROFILE},${EXTENSION},1)}=1]?${OUTBOUND_PROFILE},${EXTENSION},1)\n"
                   " same => n(post-dialing),Goto(%s-post,${EXTENSION},1)\n"
                   " same => n(end-call),Hangup()\n\n"
                   % (ctx, h, park, h, cid, ctx, ars, p, p, p, ctx))
        out.append("[%s-custom]\nexten => fake-ext,1,NoOp(Fake extension for generate this context from VitalPBX)\n\n" % ctx)
        out.append("[%s-post]\n"
                   "include => %s\n"
                   "include => %sextensions\n"
                   "include => %sapplications\n"
                   "include => %s-custom\n"
                   "include => %s\n"
                   "include => not-allowed-features\n"
                   "include => app-termination\n\n"
                   "exten => i,1,NoOp(Invalid dial on post section)\n"
                   " same => n,ForkCDR(e)\n"
                   ' same => n,ExecIf($[$["${FROM_QUEUE_CALLBACK}"="yes"]|$["${SRC_APP}"="IVR"]]?Hangup():)\n'
                   " same => n,Goto(invalid-dest-cos,s,1)\n\n"
                   "exten => h,1,NoOp(Hanging Up the Call (Post))\n"
                   " same => n,Hangup()\n\n" % (ctx, cat, p, p, ctx, ars))
        out.append("[%s-trunk]\n"
                   "exten => _[-+*#0-9a-zA-Z].,1,NoOp(Class of Services Trunk: %s)\n"
                   " same => n,Gosub(sub-check-blacklist,s,1(%s,${CALLERID(num)}))\n"
                   " same => n,Gosub(sub-setup-call-type,s,1(incoming))\n"
                   " same => n,Gosub(sub-set-call-vars,s-incoming,1(${CALLERID(num)},${EXTEN},%s))\n"
                   " same => n,Goto(%s,${EXTEN},1)\n"
                   " same => n,Hangup()\n\n" % (ctx, c["description"], h, h, ctx))
    return "".join(out)


def r_set_global_tenant_vars(m) -> str:
    p, h, s = m["prefix"], m["hash"], m["slug"]
    default_cos = next((c for c in m["cos"] if c.get("default") == "yes"), m["cos"][0] if m["cos"] else None)
    dcos = "%scos-%s" % (p, default_cos["cos"]) if default_cos else "%scos-all" % p
    return ("[%sset-global-tenant-vars]\n"
            "exten => s,1,NoOp(Setting Global Vars for %s Tenant)\n"
            " same => n,Set(__TENANT_PATH=%s)\n"
            " same => n,Set(__TENANT_PREFIX=%s)\n"
            " same => n,Set(__QUEUE_AGENTS_CONTEXT=%squeue-call-to-agents)\n"
            " same => n,Set(__FOLLOWME_CONTEXT=%sext-followme)\n"
            " same => n,Set(__HINTS_CONTEXT=%sextension-hints)\n"
            " same => n,Set(__DEFAULT_COS=%s)\n"
            " same => n,Return()\n\n" % (p, s, h, p, p, p, p, dcos))


def r_all_features_category(m) -> str:
    return "[%sall-features-category]\n%s\n\n" % (m["prefix"], FEATURE_CATEGORY_ALL)


def r_ring_group_dial(m) -> str:
    p, h, s = m["prefix"], m["hash"], m["slug"]
    return ("[%sring-group-dial]\n"
            "exten => _[-+*#0-9].,1,NoOp(More than on digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => _[-+*#0-9],1,NoOp(One Digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => s,1,NoOp(Dialing Ring Group Member: ${ARG1})\n"
            " same => n,Set(EXTENSION=${ARG1})\n"
            " same => n,Set(TENANT=%s)\n"
            " same => n,Set(COS=${DB(${TENANT}/extensions/${EXTENSION}/context)})\n"
            ' same => n,GotoIf($["X${COS}X"="XX"]?no-cos)\n'
            " same => n,Set(__DISABLE_CF_AA=TRUE)\n"
            " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)\n"
            " same => n,Set(__NO_POST_SERVICES=TRUE)\n"
            " same => n,Set(__SKIP_PLAYBACK=TRUE)\n"
            " same => n,Set(__CALL_ORIGIN=ring-group)\n"
            " same => n,Gosub(${COS},${EXTENSION},1)\n"
            " same => n,Goto(end-r-dial)\n"
            " same => n(no-cos),NoOp(No COS defined for tenant %s! Avoiding infinite loop!)\n"
            " same => n(end-r-dial),Hangup()\n\n" % (p, h, s))


def r_ext_ringgroups(m) -> str:
    p = m["prefix"]
    out = ["[%sext-ringgroups]\n" % p]
    for rg in m["ring_groups"]:
        out.append(render_ring_group(m, rg))
    out.append("exten => i,1,Goto(invalid-dest,s,1)\n\n")
    return "".join(out)


def r_queue_call_to_agents(m) -> str:
    p, h = m["prefix"], m["hash"]
    return ("[%squeue-call-to-agents]\n"
            "exten => _[-+*#0-9].,1,NoOp(More than on digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => _[-+*#0-9],1,NoOp(One Digit pattern)\n"
            " same => n,Gosub(s,1(${EXTEN}))\n\n"
            "exten => s,1,Set(EXTENSION=${ARG1})\n"
            " same => n,Set(TENANT=%s)\n"
            " same => n,Set(__SRC_APP=Q${QUEUE_NUMBER})\n"
            " same => n,Set(COS=${DB(${TENANT}/extensions/${EXTENSION}/context)})\n"
            " same => n,NoOp(Dialing Agent ${EXTENSION} from ${CALLERID(num)})\n"
            " same => n,Set(__DISABLE_CF_AA=TRUE)\n"
            ' same => n,GotoIf($["${LEN(${COS})}"="0"]?end)\n'
            " same => n,Gosub(${COS},${EXTENSION},1)\n"
            " same => n(end),Hangup()\n\n" % (p, h))


def r_ext_queues(m) -> str:
    p = m["prefix"]
    out = ["[%sext-queues]\n" % p]
    for qu in m["queues"]:
        out.append(render_queue(m, qu))
    out.append("exten => h,1,NoOp(Ending Queue Call)\n same => n,Hangup()\n\n")
    return "".join(out)


def r_ars(m) -> str:
    p = m["prefix"]
    out = []
    profiles = [x for x in (m["settings"].get("outbound_profiles") or "").split(",") if x.strip()]
    for c in m["cos"]:
        name = c["cos"]
        # per-COS ARS: the class may pin its own ars_id; else the tenant's outbound profiles
        if c.get("ars_id"):
            incl = ["ARS-%s" % c["ars_id"]]
        else:
            incl = ["ARS-%s" % x.strip() for x in profiles]
        if not incl and not profiles:
            continue
        out.append("[%sARS-%s]\n%s\n\n" % (p, name, "".join("include => %s\n" % i for i in incl)))
    for a in m["ars_own"]:
        out.append("[ARS-%s]\n"
                   'exten => i,1,ExecIf($["${FROM_QUEUE_CALLBACK}"="yes"]?Hangup():)\n'
                   " same => n,Goto(invalid-dest,s,1)\n\n" % a["ars_id"])
    return "".join(out)


def r_default_trunk(m) -> str:
    p, h = m["prefix"], m["hash"]
    return ("[%sdefault-trunk]\n"
            "exten => _[+*#0-9A-Za-z].,1,Gosub(%sset-global-tenant-vars,s,1)\n"
            " same => n,Gosub(sub-check-blacklist,s,1(%s,${CALLERID(num)}))\n"
            " same => n,Gosub(sub-stir-shaken-verify,s,1(%s,${CALLERID(num)}))\n"
            " same => n,Gosub(sub-setup-call-type,s,1(incoming))\n"
            " same => n,Gosub(dynamic-routing-in,s,1(${CALLERID(num)}))\n"
            ' same => n,ExecIf($["${LEN(${DID_NUMBER})}"="0"]?Set(__DID_NUMBER=${EXTEN}):)\n'
            " same => n,Goto(%sincoming-calls,${EXTEN},1)\n\n" % (p, p, h, h, p))


def r_incoming_calls(m) -> str:
    p, h = m["prefix"], m["hash"]
    out = ["[%sincoming-calls]\n" % p]
    routes = sorted(m["inbound"], key=lambda r: r["inbound_route_id"])  # plain id order, verified T104 + T2
    for r in routes:
        did = r["did"]
        if did in (None, ""):
            exten = "_[+*#0-9A-Za-z]."
        else:
            exten = "_%s" % did
            if r.get("cid_number"):
                exten += "/_%s" % r["cid_number"]
        lang = r.get("language") or "en"
        lines = ["exten => %s,1,NoOp(INBOUND_ROUTE: %s)" % (exten, r["description"]),
                 " same => n,Set(CHANNEL(language)=%s)" % lang,
                 " same => n,Set(__INBOUND_LANGUAGE=%s)" % lang]
        if r.get("music_group_id"):
            lines.append(" same => n,Gosub(sub-set-moh,s,1(%s,YES))" % moh_name(m, r["music_group_id"]))
        lines.append(" same => n,Gosub(sub-set-call-vars,s-incoming,1(${CALLERID(num)},${EXTEN},%s))" % h)
        if r.get("enablerecording") == "yes":
            lines.append(" same => n,Set(RECORD_UNBRIDGE_CHANNELS=yes)")
            lines.append(" same => n,Gosub(sub-setup-callrec-name,s,1)")
            lines.append(" same => n,Gosub(sub-call-recording,s,1(${TENANT},${CALL_SOURCE},${CALL_DESTINATION},yes))")
        lines.append(" same => n,Set(ICALL=yes)")
        lines.append(" same => n,%s" % goto(m, r["destination_id"]))
        lines.append(" same => n,Hangup()")
        out.append("\n".join(lines) + "\n\n")
    out.append("exten => fax,1,NoOp(Fax Detected)\n"
               " same => n,Set(FAXOPT(faxdetect)=no)\n"
               " same => n,Goto(${FAX_DEST_CONT},${FAX_DEST_EXT},${FAX_DEST_PRIO})\n\n"
               "exten => i,1,NoCDR()\n"
               " same => n,Goto(invalid-dest,s,1)\n\n"
               "exten => pm-failed,1,NoCDR()\n"
               " same => n,Answer()\n"
               " same => n,Playback(sorry&vm-goodbye,skip)\n"
               " same => n,Hangup()\n\n")
    return "".join(out)


def r_app_disa(m) -> str:
    p = m["prefix"]
    out = ["[%sapp-disa]\n" % p]
    for d in q(m["conn"], "select * from ombu_disa where tenant_id=%s order by disa_id", (m["t"],)):
        cos = q1(m["conn"], "select cos from ombu_classes_of_service where class_of_service_id=%s", (d["class_of_service_id"],))
        if d.get("cid_name") or d.get("cid_number"):
            cid = '"%s" <%s>' % (d["cid_name"], d["cid_number"])
        else:
            cid = '"${CALLERID(name)}" <${CALLERID(number)}>'
        lines = ["exten => DISA-%s,1,NoOp(DISA: %s)" % (d["disa_id"], d["description"]),
                 " same => n,Answer()"]
        if d.get("password"):
            lines.append(" same => n,Gosub(authenticate,s,1(%s))" % d["password"])
        lines += [" same => n,Playback(vpbx/disa-prompt)",
                  " same => n,Set(TIMEOUT(digit)=%s)" % (d.get("digit_timeout") or 5),
                  " same => n,Set(TIMEOUT(response)=%s)" % (d.get("resp_timeout") or 10),
                  ' same => n,ExecIf($["${CALL_TYPE}"="2"]?Set(__EXT_CID_CONSTRUCTED=yes):)',
                  " same => n,DISA(no-password,%scos-%s,%s)" % (p, cos["cos"] if cos else "all", cid),
                  " same => n,Hangup()"]
        out.append("\n".join(lines) + "\n\n")
    out.append("exten => i,1,NoCDR()\n"
               " same => n,Goto(invalid-dest,s,1)\n\n"
               "exten => t,1,NoCDR()\n"
               " same => n,Goto(timeout-reached,s,1)\n\n")
    return "".join(out)


def r_ivr_only_extensions(m) -> str:
    p = m["prefix"]
    default_cos = next((c for c in m["cos"] if c.get("default") == "yes"), m["cos"][0] if m["cos"] else None)
    dcos = "%scos-%s" % (p, default_cos["cos"]) if default_cos else "%scos-all" % p
    return ("[%sivr-only-extensions]\n"
            "exten => _[*#+0-9].,1,Set(__CALL_ORIGIN=RESTRICTED_IVR_CALL)\n"
            " same => n,Goto(%s,${EXTEN},1)\n"
            " same => n,Hangup()\n\n"
            "exten => h,1,NoOp(Ending DIRECT DIAL ON IVR)\n"
            " same => n,Hangup()\n\n" % (p, dcos))


def r_emergency(m) -> str:
    p = m["prefix"]
    if not m["emergency_cats"]:
        return ""
    out = ["[%semergency-calls]\n" % p]
    for c in m["emergency_cats"]:
        emails = c.get("email_addresses") or ""
        trunks = c["trunks"]
        for n in c["numbers"]:
            lines = ["exten => _%s,1,NoOp(Emergency Call to: %s)" % (n["number"], n["description"]),
                     ' same => n,Set(EMERGENCY_CALLER=${IF($["${LEN(${CALL_SOURCE})}"="0"]?${DEV_USER}:${CALL_SOURCE})})',
                     " same => n,Gosub(sub-setup-call-type,s,1(outgoing))",
                     " same => n,Gosub(sub-construct-cid,s-external,1(emergency))",
                     ' same => n,System(${SCRIPTS_PATH}/vitalpbx "NotifyEmergencyCall" "${TENANT}" "${EMERGENCY_CALLER}" "${EXTEN}" "${DISPATCHABLE_LOCATION}" "%s" > /dev/null 2>&1 &)' % emails,
                     " same => n,Set(__IS_EMERGENCY_CALL=yes)"]
            for tr in trunks:
                lines.append(" same => n,Gosub(trk-%s,${EXTEN},1(from-trk-grp))" % tr["trunk_id"])
                lines.append(" same => n,NoOp(Hangup Cause:${HANGUPCAUSE})")
            lines += [" same => n(finish),NoCDR()",
                      " same => n,Gosub(sub-hangup-cause,s,1(${HANGUPCAUSE}))",
                      " same => n,Hangup()"]
            out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_app_ai_assistants(m) -> str:
    return ("[%sapp-ai-assistants]\n"
            "exten => h,1,NoOp(HangUp Virtual Assistant call)\n"
            ' same => n,ExecIf($["X${AUDIO_RESPONSE}X"!="XX"]?System(rm -f ${AUDIO_RESPONSE}.wav):)\n'
            ' same => n,ExecIf($["X${CALLER_RECORDING}X"!="XX"]?System(rm -f ${CALLER_RECORDING}):)\n'
            " same => n,Hangup()\n\n\n" % m["prefix"])


# stretch renderers (ring groups, queues, IVR, TG, TC, announcements, paging) live in mirror_features.py
from mirror_features import (render_ring_group, render_queue, r_app_ivr, r_ivrs, r_time_groups,  # noqa: E402,F811
                             r_app_announcement, r_app_time_condition, r_app_paging, r_queue_extras)


def render_dialplan(m) -> str:
    parts = [
        r_ext_followme(m),
        r_fw_confirm(m),
        r_extvm_operator(m),
        r_extvm_greetings(m),
        r_custom_apps(m),
        r_custom_dests(m),
        r_parking(m),
        r_app_paging(m),
        r_applications(m),
        r_extensions_include(m),
        r_hot_desking(m),
        r_cos(m),
        r_set_global_tenant_vars(m),
        r_all_features_category(m),
        r_ring_group_dial(m),
        r_ext_ringgroups(m),
        r_queue_call_to_agents(m),
        r_ext_queues(m),
        r_queue_extras(m),
        r_ars(m),
        r_default_trunk(m),
        r_incoming_calls(m),
        r_app_disa(m),
        r_app_ivr(m),
        r_ivrs(m),
        r_ivr_only_extensions(m),
        r_time_groups(m),
        r_app_announcement(m),
        r_app_time_condition(m),
        r_emergency(m),
        r_app_ai_assistants(m),
    ]
    return "".join(parts)


# --------------------------------------------------------------------------- #
# Renderers — hints, pjsip, voicemail, parking, moh, queues
# --------------------------------------------------------------------------- #

def render_hints(m) -> str:
    p, t = m["prefix"], m["t"]
    from mirror_features import hint_lines_for_extension
    out = ["[%sextension-hints]\n" % p]
    for e in m["extensions"]:
        n = e["extension"]
        devs = []
        for d in e["devices"]:
            if d["technology"] == "pjsip":
                devs.append("pjsip/%s%s" % (p, d["user"]))
            elif d["technology"] == "virtual":
                devs.append("Custom:VirtualDev%s" % d["device_id"])
            elif d["technology"] == "sip":
                devs.append("SIP/%s%s" % (p, d["user"]))
        devs.append("Custom:%sDND_%s" % (p, n))
        out.append("exten => %s,hint,%s\n\n" % (n, "&".join(devs)))
        out.append(hint_lines_for_extension(m, e))
    out.append("exten => unavailable,hint,%sunavailable\n\n" % p)
    out.append("exten => QAGENT,hint,Custom:%sQAGENT\n\n" % p)
    from mirror_features import hint_queue_login_pause, hint_time_conditions
    out.append(hint_queue_login_pause(m))          # QAL_/QAP_ per queue member (T2, T8) — before the park hints
    for lot in m["parking"]:
        name = "parking-%d" % t if lot.get("defpark") == "yes" else "parking-%d-%s" % (t, lot["extension"])
        ext, npos = int(lot["extension"]), int(lot["parkpos"])
        for slot in range(ext + 1, ext + npos + 1):
            out.append("exten => %s,hint,park:%s@%s-parkedcalls\n\n" % (slot, slot, name))
    out.append(hint_time_conditions(m))            # TC<n> hints come LAST (T2, T8, T9, T11, T18)
    return "".join(out) + "\n"


def render_pjsip_extensions(m) -> str:
    p, t = m["prefix"], m["t"]
    out = []
    default_park = next((l for l in m["parking"] if l.get("defpark") == "yes"), None)
    # VitalPBX writes the endpoint blocks in DEVICE id order across the whole tenant (T11: 102, 105_1, 102_1),
    # not grouped per extension.
    devs = sorted(((d, e) for e in m["extensions"] for d in e["devices"] if d["technology"] == "pjsip"),
                  key=lambda de: de[0]["device_id"])
    for d, e in devs:
        n = e["extension"]
        if True:
            pj = d["pjsip"] or {}
            prof = "p%s" % d["profile_id"]
            name = "%s%s" % (p, d["user"])
            dtmf = {"rfc2833": "auto"}.get(pj.get("dtmfmode"), pj.get("dtmfmode") or "rfc4733")
            lines = ["[%s](%s)" % (name, prof),
                     "type=endpoint",
                     "auth=auth%s" % name,
                     "identify_by=username,auth_username",
                     "outbound_auth=auth%s" % name,
                     "aors=%s" % name,
                     "deny=%s" % (pj.get("deny") or "0.0.0.0/0"),
                     "contact_deny=%s" % (pj.get("deny") or "0.0.0.0/0"),
                     "permit=%s" % (pj.get("permit") or "0.0.0.0/0"),
                     "contact_permit=%s" % (pj.get("permit") or "0.0.0.0/0"),
                     "dtmf_mode=%s" % dtmf,
                     "message_context=messages",
                     "set_var=DEVICENAME=%s" % name]
            if default_park:
                lines.append("set_var=CHANNEL(parkinglot)=parking-%d" % t)
            lines += ["subscribe_context=%sextension-hints" % p,
                      "language=%s" % (e.get("language") or "en"),
                      "moh_suggest=%s" % moh_name(m, e.get("music_group_id")),
                      "context=%s%s" % (p, cos_context(e)),
                      "mailboxes=%s" % (e.get("mailbox") or ""),
                      "device_state_busy_at=%s" % (e.get("call_limit") or 0),
                      "callerid=%s" % (e.get("internal_cid") or "")]
            for pg in e["pickup_groups"]:
                lines.append("named_call_group=%s" % pg["pickup_group_id"])
                lines.append("named_pickup_group=%s" % pg["pickup_group_id"])
            if pj.get("codecs"):
                lines.append("allow=!all,%s" % pj["codecs"])
            out.append("\n".join(lines) + "\n\n")
            out.append("[auth%s]\ntype=auth\nauth_type=userpass\nusername=%s\npassword=%s\n\n" % (name, name, d["secret"]))
            out.append("[%s](%s-aor)\ntype=aor\nmax_contacts=%s\n\n" % (name, prof, pj.get("max_contacts") if pj.get("max_contacts") is not None else 1))
    return "".join(out) + "\n"


def render_voicemail(m) -> str:
    h = m["hash"]
    boxes = []
    for e in m["extensions"]:
        vm = e["vm"]
        if not vm or vm.get("enabled") != "yes":
            continue
        opts = "attach=%s|saycid=%s|sayduration=%s|envelope=%s|delete=%s|hidefromdir=%s|operator=%s" % (
            yn(vm["attach"]), yn(vm["saycid"]), yn(vm["sayduration"]), yn(vm["envelope"]),
            yn(vm["delete"]), yn(vm["hidefromdir"]), "yes" if vm.get("operator_destination_id") else "no")
        if vm.get("voicemail_timezone_id"):
            tz = q1(m["conn"], "select * from ombu_voicemail_timezones where voicemail_timezone_id=%s", (vm["voicemail_timezone_id"],))
            if tz:
                opts += "|tz=%s" % tz.get("name")
        opts += "|" + VM_EMAILBODY % dict(hash=h, ext=e["extension"])
        boxes.append((vm["context"], "%s => %s,%s,%s,,%s\n" % (e["extension"], vm["password"], e["name"], e.get("email") or "", opts)))
    if not boxes:
        return ""
    ctx = boxes[0][0]
    return "[%s]\n%s" % (ctx, "".join(b[1] for b in boxes))


def render_res_parking(m) -> str:
    t = m["t"]
    out = []
    for lot in m["parking"]:
        name = "parking-%d" % t if lot.get("defpark") == "yes" else "parking-%d-%s" % (t, lot["extension"])
        ext, npos = int(lot["extension"]), int(lot["parkpos"])
        out.append("[%s]\nparkext=>%s\ncontext=>%s-parkedcalls\ncomebackcontext=%s-callback\ncourtesytone=beep\n"
                   "parkpos=>%s-%s\nparkedmusicclass=%s\nparkingtime=>%s\ncomebackdialtime=%s\nparkedplay=%s\n"
                   "parkedcalltransfers=%s\nparkedcallreparking=%s\nparkedcallhangup=%s\nfindslot=>%s\n"
                   "comebacktoorigin=no\nparkext_exclusive=yes\n\n" % (
                       name, ext, name, name, ext + 1, ext + npos,
                       "ringback" if not lot.get("music_group_id") else moh_name(m, lot["music_group_id"]),
                       lot["parkingtime"], lot["comebackdialtime"], lot["parkedplay"],
                       lot["parkedcalltransfers"], lot["parkedcallreparking"], lot["parkedcallhangup"], lot["findslot"]))
    return "".join(out)


def render_musiconhold(m) -> str:
    h = m["hash"]
    out = []
    for g in sorted(m["tenant_music_groups"], key=lambda g: g["music_group_id"]):
        gid = g["music_group_id"]
        srt = {"linear": "alpha", "shuffle": "random"}.get(g.get("order"), "alpha")
        out.append("[moh%d]\nmode=files\ndirectory=/var/lib/vitalpbx/static/%s/moh/moh%d\nsort=%s\n\n" % (gid, h, gid, srt))
    return "\n" + "".join(out) if out else "\n"


def render_queues_conf(m) -> str:
    try:
        from mirror_features import render_queues_conf as f
        return f(m)
    except Exception:
        return "\n"


def render_tenant(m, date: Optional[str] = None) -> Dict[str, str]:
    t = m["t"]
    files: Dict[str, str] = {}
    bodies = {
        "extensions__50-{t}-dialplan.conf": render_dialplan,
        "extensions__25-{t}-hints.conf": render_hints,
        "pjsip__50-{t}-extensions.conf": render_pjsip_extensions,
        "voicemail__50-{t}-main.conf": render_voicemail,
        "queues__50-{t}-main.conf": render_queues_conf,
        "musiconhold__50-{t}-main.conf": render_musiconhold,
        "res_parking__50-{t}-extensions.conf": render_res_parking,
    }
    for pattern, static in FILE_KINDS:
        name = pattern.format(t=t)
        body = bodies[pattern](m) if pattern in bodies else static
        files[name] = banner(name, date) + body
    return files


# --------------------------------------------------------------------------- #
# AstDB
# --------------------------------------------------------------------------- #

def render_astdb(m) -> Dict[str, str]:
    h, p, t = m["hash"], m["prefix"], m["t"]
    kv: Dict[str, str] = {}
    fam = "/%s" % h
    s = m["settings"]
    kv[fam + "/allow_recordings"] = yn(s.get("allow_recordings", "yes"))
    kv[fam + "/allowed_sim_calls"] = str(s.get("calls_limit") or "0")
    for c in m["cos"]:
        cid = c["class_of_service_id"]
        kv[fam + "/classes_of_service/%s/allowed_calls_by" % cid] = nz(c.get("allowed_calls_by"))
        kv[fam + "/classes_of_service/%s/private" % cid] = yn(c.get("private"))
        kv[fam + "/classes_of_service/%scos-%s" % (p, c["cos"])] = str(cid)
    cid_name, cid_number = s.get("cid_name") or "", s.get("cid_number") or ""
    kv[fam + "/default_external_cid"] = ('"%s" <%s>' % (cid_name, cid_number)) if (cid_name or cid_number) else ""
    for loc in m["emergency_locations"]:
        kv[fam + "/dispatchable_locations/%s/cid" % loc["id"]] = '"%s" <%s>' % (loc["cid_name"], loc["cid_number"])
    for e in m["extensions"]:
        n = e["extension"]
        divs = {d["name"]: d for d in e["diversions"]}
        for name in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM"):
            d = divs.get(name, {})
            kv[fam + "/diversions/%s/%s/destination" % (n, name)] = nz(d.get("destination_id"))
            kv[fam + "/diversions/%s/%s/enable" % (n, name)] = yn(d.get("enable", "no"))
            kv[fam + "/diversions/%s/%s/time_group" % (n, name)] = nz(d.get("time_group_id"))
        d = divs.get("PEA", {})
        kv[fam + "/diversions/%s/PEA/enable" % n] = yn(d.get("enable", "no"))
        kv[fam + "/diversions/%s/PEA/time_group" % n] = nz(d.get("time_group_id"))
        kv[fam + "/diversions/%s/has_enable_diversions" % n] = "yes" if any(x.get("enable") == "yes" for x in e["diversions"]) else "no"
    kv[fam + "/dynamic_routing/settings/delete_used_records"] = yn(m["dyn"]["delete_used_records"] or "yes")
    kv[fam + "/dynamic_routing/settings/digits_match"] = str(m["dyn"]["digits_match"] or "0")
    kv[fam + "/dynamic_routing/settings/expiration_time"] = str(m["dyn"]["expiration_time"] or "8")
    kv[fam + "/dynamic_routing/settings/only_missed_calls"] = yn(m["dyn"]["only_missed_calls"] or "yes")
    for e in m["extensions"]:
        n = e["extension"]
        vm = e["vm"] or {}
        fm = e["followme"] or {}
        ek = fam + "/extensions/%s/" % n
        kv[ek + "absent_secretary"] = yn(e.get("absent_secretary"))
        kv[ek + "ask_vm_password"] = yn(vm.get("ask_password", "yes"))
        kv[ek + "call_waiting"] = yn(e.get("call_waiting"))
        kv[ek + "callgroup"] = ",".join(str(pg["pickup_group_id"]) for pg in e["pickup_groups"])
        kv[ek + "context"] = "%s%s" % (p, cos_context(e))
        kv[ek + "dial"] = ext_dial_string(m, e)
        kv[ek + "dial_options"] = dial_options(e["dial_profile"])
        kv[ek + "dictate/email"] = nz(e.get("email")) if e.get("dictate_auto_send") == "yes" else ""
        kv[ek + "dictate/enabled"] = yn(e.get("dictate_enable"))
        kv[ek + "dictate/format"] = e.get("dictate_format") or "wav"
        kv[ek + "dynamic_routing"] = yn(e.get("dynamic_routing"))
        kv[ek + "followme/ringtime"] = str(fm.get("initial_ringtime") if fm.get("initial_ringtime") is not None else 0)
        kv[ek + "hints"] = yn(e.get("generate_hints"))
        kv[ek + "hotdesking"] = yn(e.get("hot_desking"))
        kv[ek + "is_secretary"] = "yes" if e.get("_is_secretary") else "no"
        kv[ek + "language"] = e.get("language") or "en"
        kv[ek + "lock"] = yn(e.get("lock"))
        kv[ek + "moh"] = moh_name(m, e.get("music_group_id"))
        kv[ek + "name"] = e.get("name") or ""
        kv[ek + "notify_missed_calls"] = "yes" if e.get("notify_missed_calls") else "no"
        kv[ek + "password"] = nz(e.get("features_password"))
        kv[ek + "pickupgroup"] = ",".join(str(pg["pickup_group_id"]) for pg in e["pickup_groups"])
        kv[ek + "pinless"] = yn(e.get("pinless"))
        kv[ek + "ringtimer"] = str(e.get("ringtime") or 30)
        kv[ek + "secretary"] = nz(e.get("secretary"))
        kv[ek + "skip_vm_instructions"] = yn(vm.get("skip_instructions", "no"))
        kv[ek + "spyb"] = yn(e.get("nospy"))
        kv[ek + "virtual_devices"] = "yes" if any(d["technology"] == "virtual" for d in e["devices"]) else "no"
        kv[ek + "vm_password"] = nz(vm.get("password"))
        kv[ek + "vmenabled"] = yn(vm.get("enabled", "no")) if vm else "no"
        kv[ek + "voicemail"] = nz(e.get("mailbox"))
    kv[fam + "/force_default_external_cid"] = yn(s.get("force_default_external_cid", "no"))
    kv[fam + "/main"] = yn(m["tenant"].get("default"))
    kv[fam + "/name"] = m["slug"]
    kv[fam + "/prefix"] = p
    # secretary back-reference: an extension named as somebody's secretary is is_secretary=yes
    secretaries = {str(e.get("secretary")) for e in m["extensions"] if e.get("secretary")}
    for e in m["extensions"]:
        if str(e["extension"]) in secretaries:
            kv[fam + "/extensions/%s/is_secretary" % e["extension"]] = "yes"
    # CustomDevstate
    for e in m["extensions"]:
        n = e["extension"]
        for name in ("BOSS", "CC", "CFB", "CFI", "CFN", "CFU", "DND", "FWM", "PEA"):
            kv["/CustomDevstate/%s%s_%s" % (p, name, n)] = "UNAVAILABLE" if name == "DND" else "NOT_INUSE"
    kv["/CustomDevstate/%sQAGENT" % p] = "NOT_INUSE"
    kv["/CustomDevstate/%sunavailable" % p] = "BUSY"
    from mirror_features import astdb_extras
    kv.update(astdb_extras(m))
    return kv


def format_astdb_show(kv: Dict[str, str]) -> str:
    """Same layout as `asterisk -rx 'database show'` (%-50s: %-25s)."""
    return "".join("%-50s: %-25s\n" % (k, v) for k, v in sorted(kv.items()))


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=["render", "render-astdb"])
    ap.add_argument("--tenant", type=int, required=True)
    ap.add_argument("--out", help="output dir for render")
    ap.add_argument("--host", default=os.environ.get("MIRROR_DB_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MIRROR_DB_PORT", "3307")))
    ap.add_argument("--user", default=os.environ.get("MIRROR_DB_USER", "root"))
    ap.add_argument("--password", default=os.environ.get("MIRROR_DB_PASSWORD", "mirror"))
    ap.add_argument("--db", default=os.environ.get("MIRROR_DB_NAME", "ombutel"))
    a = ap.parse_args(argv)
    conn = connect(a.host, a.port, a.user, a.password, a.db)
    m = load_tenant(conn, a.tenant)
    if a.cmd == "render":
        if not a.out:
            ap.error("--out required")
        os.makedirs(a.out, exist_ok=True)
        files = render_tenant(m)
        for name, text in files.items():
            with open(os.path.join(a.out, name), "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
        print("wrote %d files to %s" % (len(files), a.out))
    else:
        sys.stdout.write(format_astdb_show(render_astdb(m)))


if __name__ == "__main__":
    main()
PYMIRRORVM
chmod 0644 /opt/connect-pbx-helper/vitalpbx_mirror.py
cat >/opt/connect-pbx-helper/mirror_features.py <<'PYMIRRORFEAT'
#!/usr/bin/env python3
"""
Stretch renderers for vitalpbx_mirror.py: ring groups, queues, IVRs, time groups /
conditions, announcements, paging, plus the hint and AstDB extras they bring.

Every template was cut from the real files (T5 ring groups + IVR-12, T9 paging /
IVR / TG / TC / announcements, T2 + T8 queues) and the DB→text mapping verified by
diff_tenant.py. Anything marked UNVERIFIED in a comment has no live example.
"""
from __future__ import annotations

import hashlib
from typing import Dict, List

from vitalpbx_mirror import goto, dest_target, moh_name, q, q1, yn

SYSTEM_TIMEZONE = "America/New_York"   # what the panel substitutes for time_conditions.timezone='system'
DEFAULT_TIMEZONE_MARK = "system"


def rec_path(m, recording_id) -> str:
    """Recording file: /var/lib/vitalpbx/static/<hash>/recordings/<md5(recording_id)>."""
    return "/var/lib/vitalpbx/static/%s/recordings/%s" % (m["hash"], hashlib.md5(str(recording_id).encode()).hexdigest())


# --------------------------------------------------------------------------- #
# ring groups
# --------------------------------------------------------------------------- #

def render_ring_group(m, rg) -> str:
    p = m["prefix"]
    n = rg["extension"]
    ring = rg.get("ringtime") or 30
    members = []
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for mem in sorted(rg["members"], key=lambda x: x["extension_id"]):
        e = ext_by_id.get(mem["extension_id"])
        if e:
            members.append("Local/%s@%sring-group-dial/n" % (e["extension"], p))
    for x in [x for x in (rg.get("external_numbers") or "").replace("&", ",").split(",") if x.strip()]:
        members.append("Local/%s@%sring-group-dial/n" % (x.strip(), p))  # UNVERIFIED (no live row has external numbers)
    opts = "r" + ("c" if rg.get("answered_elsewhere") == "yes" else "Q(NO_ANSWER)")
    if rg.get("music_group_id"):
        opts += "m(%s)" % moh_name(m, rg["music_group_id"])
    opts += "tTU(clean-variables)"
    lines = ["exten => %s,1,NoOp(Ring Group: %s)" % (n, rg["description"]),
             " same => n,Set(_IGNORE_DIVERSIONS=%s)" % ("no" if rg.get("allow_diversions") == "yes" else "yes"),
             " same => n,Set(_SKIP_PLAYBACK=TRUE)",
             " same => n,Set(__SKIP_AA=TRUE)",
             " same => n,Set(__NO_POST_SERVICES=TRUE)",
             " same => n,Set(__SRC_APP=RG%s)" % n,
             " same => n,Set(__PBX_APP=RING_GROUP)",
             " same => n,Set(__PBX_APP_DESC=%s)" % rg["description"],
             " same => n,Set(__RG_RINGTIME=%s)" % ring,
             " same => n,Gosub(sub-set-call-vars,app-incoming,1)"]
    if rg.get("prefix"):
        lines.append(" same => n,Set(CALLERID(name)=%s:${CALLERID(name)})" % rg["prefix"])
    if rg.get("answerchannel", "yes") == "yes":
        lines.append(" same => n,Answer()")
    lines.append(" same => n,NoCDR()")
    if rg.get("announ_id"):
        lines.append(" same => n,Playback(%s)" % rec_path(m, rg["announ_id"]))
    if rg.get("strategy") == "one_by_one":
        for mem in members:
            lines.append(" same => n,Dial(%s,%s,%s)" % (mem, ring, opts))
    else:
        lines.append(" same => n,Dial(%s,%s,%s)" % ("&".join(members), ring, opts))
    lines += [" same => n,ResetCDR(ve)",
              " same => n,Set(__CALL_ORIGIN=normal)",
              " same => n,Set(__IGNORE_DIVERSIONS=no)",
              " same => n,Set(__SKIP_CONTACT_SERVICES=FALSE)",
              " same => n,Set(__NO_POST_SERVICES=FALSE)",
              " same => n,Set(__DISABLE_CF_AA=FALSE)",
              " same => n,Set(__SKIP_AA=FALSE)",
              " same => n,Set(__SKIP_BUSY=FALSE)",
              " same => n,Set(__RG_RINGTIME=)",
              " same => n,%s" % goto(m, rg["destination_id"])]
    return "\n".join(lines) + "\n\n"


# --------------------------------------------------------------------------- #
# queues
# --------------------------------------------------------------------------- #

def render_queue(m, qu) -> str:
    p = m["prefix"]
    n = qu["extension"]
    qname = "%sQ%s" % (p, n)
    lines = ["exten => %s,1,NoOp(Queue: %s)" % (n, qu["description"]),
             " same => n,Set(__QUEUE_UID=${UNIQUEID})",
             " same => n,Set(__QUEUE_CALL=TRUE)",
             " same => n,Set(__SKIP_AA=TRUE)",
             " same => n,Set(__FROM_QUEUE_ID=%s)" % qu["queue_id"],
             " same => n,Gosub(sub-set-moh,s,1(%s,YES))" % moh_name(m, qu.get("music_group_id")),
             " same => n,Set(__QUEUE_NUMBER=%s)" % n,
             " same => n,Set(__QUEUE_NAME=%s)" % qname,
             " same => n,Set(__PBX_APP=QUEUE)",
             " same => n,Set(__PBX_APP_DESC=%s)" % qu["description"],
             " same => n,Set(__FORCE_QUEUE_MOH=%s)" % yn(qu.get("force_moh")),
             " same => n,Gosub(sub-set-call-vars,app-incoming,1)"]
    if qu.get("prefix"):
        lines.append(" same => n,Set(__INHERITED_PREFIX=%s)" % qu["prefix"])
    if qu.get("record") == "no" and qu.get("queue_callback_id") is not None or m["t"] != 2:
        # UNVERIFIED which column drives __QUEUE_NO_CDR (present on every T8/T21/T35 queue, absent on T2's,
        # and T2's file predates its DB); rendered for every queue except the T2 shape.
        lines.append(" same => n,Set(__QUEUE_NO_CDR=TRUE)")
    lines += [" same => n(qconnect),NoOp(Connecting to Queue)",
              " same => n,Set(ANSWER_CHANNEL=%s)" % yn(qu.get("answerchannel", "yes")),
              ' same => n,ExecIf($[$["${SKIP_ANSWER}"="yes"]|$["${ANSWER_CHANNEL}"="no"]]?Progress():Answer())',
              " same => n,NoCDR()",
              " same => n,Set(Q_RING_TIME=%s)" % (qu.get("queue_timeout") or ""),
              ' same => n,ExecIf($["${DISABLE_QRT}"="yes"]?Set(Q_RING_TIME=):)',
              " same => n,Queue(%s,%s,,,${Q_RING_TIME},,,,,${Q_FORCE_POSITION})" % (
                  qname, "c" + ("C" if qu.get("answered_elsewhere") == "yes" or qu.get("queue_callback_id") else "")),
              " same => n,ResetCDR(ve)",
              " same => n,NoOp(Queue Status: ${QUEUESTATUS})",
              " same => n,Set(__QUEUE_CALL=FALSE)",
              ' same => n,GotoIf($["${QUEUESTATUS}"="CONTINUE"]?app-termination,hangup,1)',
              " same => n,%s" % goto(m, qu["destination_id"]),
              " same => n,Hangup()"]
    return "\n".join(lines) + "\n\n"


def r_queue_extras(m) -> str:
    return ""  # QUEUE-CALLBACK-*/DRR contexts (T8 only): NOT rendered — see README


def render_queues_conf(m) -> str:
    p = m["prefix"]
    if not m["queues"]:
        return "\n"
    out = ["\n"]
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for qu in m["queues"]:
        n = qu["extension"]
        lines = ["[%sQ%s]" % (p, n)]
        if qu.get("periodic_announcement_id") and qu.get("queue_callback_id"):
            lines.append("periodic-announce=vpbx/qc-instructions")   # T8 shape; UNVERIFIED for other periodic recordings
            lines.append("context=QUEUE-CALLBACK-IVR-%s" % qu["queue_callback_id"])
        lines += ["setqueueentryvar=yes", "setqueuevar=yes", "timeoutpriority=app",
                  "strategy=%s" % qu["strategy"],
                  "musicclass=%s" % moh_name(m, qu.get("music_group_id")),
                  "autofill=%s" % yn(qu.get("autofill")),
                  "maxlen=%s" % (qu.get("maxlen") or 0),
                  "announce=",
                  "wrapuptime=%s" % (qu.get("wrapuptime") or 0)]
        if qu.get("announce_frequency"):
            lines.append("announce-frequency=%s" % qu["announce_frequency"])
        lines += ["announce-round-seconds=%s" % (qu.get("announce_round_seconds") or 0),
                  "announce-to-first-user=%s" % yn(qu.get("announce_to_first_user")),
                  "announce-position=%s" % yn(qu.get("announce_position")),
                  "relative-periodic-announce=%s" % yn(qu.get("relative_periodic_announce")),
                  "announce-holdtime=%s" % yn(qu.get("announce_holdtime")),
                  "autopause=%s" % yn(qu.get("autopause")),
                  "ringinuse=%s" % yn(qu.get("ringinuse")),
                  "timeoutrestart=%s" % yn(qu.get("timeoutrestart")),
                  "joinempty=%s" % yn(qu.get("joinempty")),
                  "timeout=%s" % qu.get("timeout"),
                  "leavewhenempty=%s" % yn(qu.get("leavewhenempty")),
                  "retry=%s" % qu.get("retry")]
        for mem in [x for x in qu["members"] if x.get("type") == "static"]:
            e = ext_by_id.get(mem["extension_id"])
            if e:
                lines.append("member=>Local/%s@%squeue-call-to-agents/n,%s,%s,hint:Agent%s@%sextension-hints,%s" % (
                    e["extension"], p, mem.get("penalty") or 0, e["extension"], e["extension"], p,
                    "yes" if qu.get("ringinuse") == "yes" else "no"))
        lines.append("queue-thankyou=")
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


# --------------------------------------------------------------------------- #
# IVRs
# --------------------------------------------------------------------------- #

def r_app_ivr(m) -> str:
    p = m["prefix"]
    if not m["ivrs"]:
        return ""
    out = ["[%sapp-ivr]\n" % p]
    for iv in m["ivrs"]:
        out.append("exten => IVR-%s,1,Goto(IVR-%s,s,1)\n\n" % (iv["ivr_id"], iv["ivr_id"]))
    return "".join(out)


def _msg(m, rec_id, default_builtin: str, none_text: str, label: str) -> str:
    """BackGround() line for an IVR message slot. recording 1 = 'recordings_default' -> a built-in prompt."""
    if rec_id is None:
        return " same => n(%s),%s" % (label, none_text) if label else None
    if int(rec_id) == 1:
        snd = default_builtin
    else:
        snd = rec_path(m, rec_id)
    return " same => n(%s),BackGround(%s)" % (label, snd) if label else " same => n,BackGround(%s)" % snd


def r_ivrs(m) -> str:
    p = m["prefix"]
    out = []
    conn = m["conn"]
    for iv in m["ivrs"]:
        iid = iv["ivr_id"]
        entries = q(conn, "select * from ombu_ivr_entries where ivr_id=%s and enabled='yes' order by sort, id", (iid,))
        lines = ["[IVR-%s]" % iid,
                 "exten => s,1,NoOp(IVR: %s)" % iv["description"],
                 " same => n,Set(INVALIDATTEMPTS=0)",
                 " same => n,Set(TIMEOUTATTEMPTS=0)",
                 " same => n,Set(TIMEOUT(digit)=2)",
                 " same => n,Set(TIMEOUT(response)=%s)" % (iv.get("timeout") or 10),
                 " same => n,Set(__PBX_APP=QUEUE)",
                 " same => n,Set(__PBX_APP_DESC=%s)" % iv["description"],
                 " same => n,Answer()",
                 " same => n(begin),NoOp(IVR Menu Begin)"]
        if iv.get("welcome_msg_id"):
            lines.append(" same => n(welcome-background),BackGround(%s)" % rec_path(m, iv["welcome_msg_id"]))
        else:
            lines.append(" same => n(welcome-background),NoOp(No welcome message)")
        lines.append(" same => n(retry),NoOp(IVR Retry Section)")
        if iv.get("instructions_msg_id"):
            lines.append(" same => n(retry-background),BackGround(%s)" % rec_path(m, iv["instructions_msg_id"]))
        else:
            lines.append(" same => n(retry-background),NoOp(No retry message)")
        lines.append(" same => n,Set(CHANNEL(hangup_handler_push)=notify-call-hangup,s,1)")
        lines.append(" same => n,WaitExten(%s)" % (iv.get("timeout") or 10))
        out.append("\n".join(lines) + "\n\n")
        stats = iv.get("generate_stats") == "yes"
        for en in entries:
            tgt = dest_target(m, en["destination_id"])
            l2 = ["exten => %s,1,NoOp(Option %s has been pressed)" % (en["option"], en["option"])]
            if stats:
                l2.append(' same => n,System(/usr/share/vitalpbx/scripts/ivr_stats "%s" "${EXTEN}" "${CALLERID(name)}" "${CALLERID(number)}" "${CALL_DESTINATION}" "${CDR(uniqueid)}")' % iid)
            l2 += [" same => n,Set(__SRC_APP=IVR)", " same => n,Set(CALL_DESTINATION=${EXTEN})"]
            if tgt:
                l2.append(" same => n,Goto(%s)" % tgt)
            out.append("\n".join(l2) + "\n\n")
        if iv.get("freedial") == "yes":
            # direct dial: the IVR's own class of service if pinned, else the ivr-only-extensions gate
            if iv.get("class_of_service_id"):
                cos = q1(conn, "select cos from ombu_classes_of_service where class_of_service_id=%s", (iv["class_of_service_id"],))
                dial_ctx = "%scos-%s" % (p, cos["cos"] if cos else "all")
            else:
                dial_ctx = "%sivr-only-extensions" % p
            stats_line = (' same => n,System(/usr/share/vitalpbx/scripts/ivr_stats "%s" "${EXTEN}" "${CALLERID(name)}"'
                          ' "${CALLERID(number)}" "${CALL_DESTINATION}" "${CDR(uniqueid)}")\n' % iid) if stats else ""
            out.append("exten => _[*#+0-9].,1,NoOp(Direct Dial to extension ${EXTEN})\n"
                       + stats_line
                       + " same => n,NoCDR()\n"
                       " same => n,Set(__SRC_APP=IVR)\n"
                       " same => n,Dial(Local/${EXTEN}@%s/n)\n"
                       ' same => n,GotoIf($["${DIALSTATUS}"="NOANSWER"]?invalid_dial,1)\n'
                       " same => n,Hangup()\n\n" % dial_ctx)
        out.append("exten => #,1,Hangup()\n\n")
        out.append("exten => *,1,Goto(s,begin)\n\n")
        self_tgt = "%sapp-ivr,IVR-%s,1" % (p, iid)
        # timeout
        l3 = ["exten => t,1,Set(TIMEOUTATTEMPTS=$[${TIMEOUTATTEMPTS}+1])"]
        tries = int(iv.get("timeout_tries") or 0)
        if tries > 0:
            l3.append(" same => n,GotoIf($[${TIMEOUTATTEMPTS}>=%d]?timeout)" % tries)
            if iv.get("timeout_retry_msg_id"):
                l3.append(" same => n,BackGround(%s)" % ("option-is-invalid" if int(iv["timeout_retry_msg_id"]) == 1 else rec_path(m, iv["timeout_retry_msg_id"])))
            l3.append(" same => n,Goto(s,%s)" % ("begin" if iv.get("timeout_add_msg") == "yes" else "retry"))
        if iv.get("timeout_msg_id"):
            l3.append(" same => n(timeout),BackGround(%s)" % ("sorry-youre-having-problems&vm-goodbye" if int(iv["timeout_msg_id"]) == 1 else rec_path(m, iv["timeout_msg_id"])))
        else:
            l3.append(" same => n(timeout),NoOp(All tries has done)")
        tgt = dest_target(m, iv.get("timeout_destination_id"))
        if tgt and tgt != self_tgt:
            l3.append(" same => n,Goto(%s)" % tgt)
        out.append("\n".join(l3) + "\n\n")
        # invalid
        l4 = ["exten => i,1,Set(INVALIDATTEMPTS=$[${INVALIDATTEMPTS}+1])"]
        tries = int(iv.get("invalid_tries") or 0)
        if tries > 0:
            l4.append(" same => n,GotoIf($[${INVALIDATTEMPTS}>=%d]?invalid)" % tries)
            if iv.get("invalid_retry_msg_id"):
                snd = "option-is-invalid" if int(iv["invalid_retry_msg_id"]) == 1 else rec_path(m, iv["invalid_retry_msg_id"])
                l4.append(' same => n,ExecIf($["${INVALID_DIAL}"!="yes"]?BackGround(%s):)' % snd)
            l4.append(" same => n,Goto(s,%s)" % ("begin" if iv.get("invalid_add_msg") == "yes" else "retry"))
        if iv.get("invalid_msg_id"):
            l4.append(" same => n(invalid),BackGround(%s)" % ("sorry-youre-having-problems&vm-goodbye" if int(iv["invalid_msg_id"]) == 1 else rec_path(m, iv["invalid_msg_id"])))
        else:
            l4.append(" same => n(invalid),NoOp(All tries has done)")
        tgt = dest_target(m, iv.get("invalid_destination_id"))
        if tgt and tgt != self_tgt:
            l4.append(" same => n,Goto(%s)" % tgt)
        out.append("\n".join(l4) + "\n\n")
        out.append("exten => invalid_dial,1,NoCDR()\n"
                   " same => n,NoOp(Invalid Numbering Dial)\n"
                   " same => n,Playback(silence/1&no-route-exists-to-dest&vm-pls-try-again)\n"
                   " same => n,Set(INVALID_DIAL=yes)\n"
                   " same => n,Goto(i,1)\n\n")
        out.append("exten => h,1,NoOp(IVR-%s call ended)\n same => n,Hangup()\n\n" % iid)
    return "".join(out)


# --------------------------------------------------------------------------- #
# time groups / conditions / announcements
# --------------------------------------------------------------------------- #

def r_time_groups(m) -> str:
    out = []
    for tg in m["time_groups"]:
        sched = q(m["conn"], "select * from ombu_time_groups_schedules where time_group_id=%s order by sort", (tg["time_group_id"],))
        lines = ["[TG-%s]" % tg["time_group_id"],
                 "exten => s,1,NoOp(Time Group: %s)" % tg["description"],
                 " same => n,Set(__TGMATCH=0)",
                 " same => n,Set(TG_TIMEZONE=${IF($[${LEN(${TC_TIMEZONE})}=0]?:/usr/share/zoneinfo/${TC_TIMEZONE})})"]
        for s in sched:
            lines.append(" same => n,GotoIfTime(%s,${TG_TIMEZONE}?match:)" % s["time"])
        lines += [" same => n,Return()", " same => n(match),Set(__TGMATCH=1)", " same => n,Return()"]
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def r_app_announcement(m) -> str:
    p = m["prefix"]
    if not m["announcements"]:
        return ""
    out = ["[%sapp-announcement]\n" % p]
    for an in m["announcements"]:
        lines = ["exten => announcement-%s,1,NoOp(Announcement: %s)" % (an["announcement_id"], an["description"])]
        if an.get("recording_id"):
            lines.append(" same => n,Playback(%s)" % rec_path(m, an["recording_id"]))
        lines.append(" same => n,%s" % goto(m, an["destination_id"]))
        out.append("\n".join(lines) + "\n\n")
    return "".join(out)


def tc_timezone(tc) -> str:
    tz = tc.get("timezone") or "system"
    return SYSTEM_TIMEZONE if tz == "system" else tz


def r_app_time_condition(m) -> str:
    p = m["prefix"]
    if not m["time_conditions"]:
        return ""
    out = ["[%sapp-time-condition]\n" % p]
    for tc in m["time_conditions"]:
        tid = tc["time_condition_id"]
        tz = tc_timezone(tc)
        lines = ["exten => TC-%s,1,NoOp(Time Condition: %s)" % (tid, tc["description"]),
                 " same => n,Set(TC_TIMEZONE=%s)" % tz,
                 " same => n,Gosub(TG-%s,s,1)" % tc["time_group_id"],
                 " same => n,NoOp(${TGMATCH})",
                 " same => n,Set(OVERRIDE_STATE=${DB(${TENANT}/time_conditions/TC%s/override)})" % tid,
                 ' same => n,GotoIf($["${OVERRIDE_STATE}"!="no"]?:check-default)',
                 ' same => n,GotoIf($["${OVERRIDE_STATE}"="force_match"]?match)',
                 ' same => n,GotoIf($["${OVERRIDE_STATE}"="force_unmatch"]?unmatch)',
                 " same => n(check-default),GotoIf($[${TGMATCH} > 0]?match)",
                 " same => n(unmatch),NoOp(Time Condition No Matched)",
                 " same => n,%s" % goto(m, tc["mismatch_destination_id"]),
                 " same => n,Hangup()",
                 " same => n(match),NoOp(Time Condition Matched)",
                 " same => n,%s" % goto(m, tc["match_destination_id"]),
                 " same => n,Hangup()"]
        out.append("\n".join(lines) + "\n\n")
        if tc.get("code"):
            out.append("exten => %s,1,NoOp(Time Condition: %s)\n"
                       " same => n,Set(TC_TIMEZONE=%s)\n"
                       " same => n,Gosub(sub-toggle-tc-state,s,1(%s,TG-%s))\n"
                       " same => n,Hangup()\n\n" % (tc["code"], tc["description"], tz, tid, tc["time_group_id"]))
    return "".join(out)


# --------------------------------------------------------------------------- #
# paging
# --------------------------------------------------------------------------- #

def r_app_paging(m) -> str:
    p = m["prefix"]
    if not m["pages"]:
        return ""
    out = ["[%sapp-paging]\n" % p]
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for pg in m["pages"]:
        members = q(m["conn"], "select * from ombu_page_members where page_id=%s", (pg["page_id"],))
        exts = sorted((ext_by_id[x["extension_id"]] for x in members if x["extension_id"] in ext_by_id),
                      key=lambda e: e["extension_id"])
        pstr = "&".join("Local/%s@%scos-%s" % (e["extension"], p, e["cos"]["cos"] if e.get("cos") else "all") for e in exts)
        opts = ""
        if pg.get("skip_busy") == "yes":
            opts += "s"
        if pg.get("quiet") == "yes":
            opts += "q"
        if pg.get("ignore") == "yes":
            opts += "i"
        if pg.get("duplex") == "yes":
            opts += "d"
        if pg.get("record") == "yes":
            opts += "r"  # UNVERIFIED (no live page records)
        out.append("exten => %s,1,NoOp(Paging: %s)\n"
                   " same => n,Set(PAGING_STRING=%s)\n"
                   " same => n,GotoIf($[${LEN(${PAGING_STRING})} = 0]?invalid-paging)\n"
                   " same => n,Set(__SRC_APP=PAGING)\n"
                   " same => n,Set(__FORCE_INTERCOM=yes)\n"
                   " same => n,Set(__SKIP_CONTACT_SERVICES=TRUE)\n"
                   " same => n,Set(OPTIONS=%s)\n"
                   " same => n,Set(__SKIP_BUSY=%s)\n"
                   " same => n(do-paging),Gosub(sub-paging,s,1(${PAGING_STRING},${OPTIONS},%s))\n"
                   " same => n(invalid-paging),Playback(pls-try-call-later)\n"
                   " same => n,Hangup()\n\n" % (pg["extension"], pg["description"], pstr, opts,
                                                yn(pg.get("skip_busy")), pg.get("timeout") or 10))
    return "".join(out)


# --------------------------------------------------------------------------- #
# hints + astdb extras
# --------------------------------------------------------------------------- #

def _ext_devs(m, e) -> List[str]:
    p = m["prefix"]
    devs = []
    for d in e["devices"]:
        if d["technology"] == "pjsip":
            devs.append("pjsip/%s%s" % (p, d["user"]))
        elif d["technology"] == "virtual":
            devs.append("Custom:VirtualDev%s" % d["device_id"])
    return devs


def queue_memberships(m) -> Dict[int, List[dict]]:
    """extension_id -> [queue rows] (any member type), in queue_id order."""
    res: Dict[int, List[dict]] = {}
    for qu in m["queues"]:
        for mem in qu["members"]:
            res.setdefault(mem["extension_id"], []).append(qu)
    return res


def r_hints_extras(m) -> str:
    """Nothing here — the per-extension Agent/QA hints are interleaved by render_hints via hint_lines_for_extension."""
    return ""


def hint_lines_for_extension(m, e) -> str:
    """Agent<n> / QA_<n> hint lines that follow an extension's own hint when it is a queue member."""
    p = m["prefix"]
    if e["extension_id"] not in queue_memberships(m):
        return ""
    devs = "&".join(_ext_devs(m, e))
    n = e["extension"]
    return ("exten => Agent%s,hint,%s&Custom:%sQAGENT\n\n"
            "exten => QA_%s,hint,%s\n\n" % (n, devs, p, n, devs))


def hint_queue_login_pause(m) -> str:
    """After `QAGENT`: the QAL/QAP login/pause hints per queue member (before the park hints)."""
    p = m["prefix"]
    out = []
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    seen_ext = set()
    for qu in m["queues"]:
        qn = qu["extension"]
        for mem in qu["members"]:
            e = ext_by_id.get(mem["extension_id"])
            if not e:
                continue
            n = e["extension"]
            out.append("exten => QAL_%s_%s,hint,Custom:%sQAL_%s_%s\n same => 1,Set(__QNUMBER=%s)\n same => 2,Gosub(%scos-all-init,*50*%s,1)\n\n"
                       % (n, qn, p, n, qn, qn, p, qn))
            if n not in seen_ext:
                out.append("exten => QAL_%s,hint,Custom:%sQAL_%s\n same => 1,Gosub(%scos-all-init,*52,1)\n\n" % (n, p, n, p))
            out.append("exten => QAP_%s_%s,hint,Custom:%sQAP_%s_%s\n same => 1,Set(__QNUMBER=%s)\n same => 2,Gosub(%scos-all-init,*51*%s,1)\n\n"
                       % (n, qn, p, n, qn, qn, p, qn))
            if n not in seen_ext:
                out.append("exten => QAP_%s,hint,Custom:%sQAP_%s\n same => 1,Gosub(%scos-all-init,*53,1)\n\n" % (n, p, n, p))
                seen_ext.add(n)
    return "".join(out)


def hint_time_conditions(m) -> str:
    """The TC<n> hints, after the park hints (T2, T8, T9, T11, T18)."""
    p, h, t = m["prefix"], m["hash"], m["t"]
    out = []
    default_park = next((l for l in m["parking"] if l.get("defpark") == "yes"), None)
    park = "parking-%d" % t if default_park else ""
    for tc in m["time_conditions"]:
        tid = tc["time_condition_id"]
        out.append("exten => TC%s,hint,Custom:TC%s\n"
                   " same => 1,NoOp(Time Condition: %s)\n"
                   " same => n,Gosub(sub-set-global-vars,s,1(%s,${EXTEN},%s))\n"
                   " same => n,Gosub(sub-set-call-vars,s,1(%s,${EXTEN},,,))\n"
                   " same => n,Gosub(sub-construct-cid,s,1)\n"
                   " same => n,Gosub(sub-toggle-tc-state,s,1(%s,TG-%s))\n\n"
                   % (tid, tid, tc["description"], h, park, h, tid, tc["time_group_id"]))
    return "".join(out)


def astdb_extras(m) -> Dict[str, str]:
    kv: Dict[str, str] = {}
    fam = "/%s" % m["hash"]
    p = m["prefix"]
    ext_by_id = {e["extension_id"]: e for e in m["extensions"]}
    for qu in m["queues"]:
        qn = qu["extension"]
        for mem in qu["members"]:
            e = ext_by_id.get(mem["extension_id"])
            if not e:
                continue
            kv["%s/queues/%s/member/%s/diversions" % (fam, qn, e["extension"])] = yn(mem.get("diversions"))
            kv["%s/queues/%s/member/%s/penalty" % (fam, qn, e["extension"])] = str(mem.get("penalty") or 0)
            kv["%s/queues/%s/member/%s/type" % (fam, qn, e["extension"])] = mem.get("type") or "static"
        kv["%s/queues/%s/moh" % (fam, qn)] = moh_name(m, qu.get("music_group_id"))
        kv["%s/queues/%s/name" % (fam, qn)] = "%sQ%s" % (p, qn)
        kv["%s/queues/%s/prefix" % (fam, qn)] = qu.get("prefix") or ""
        kv["%s/queues/%s/ring_unavailable" % (fam, qn)] = yn(qu.get("ring_unavailable"))
    for tc in m["time_conditions"]:
        st = tc.get("status") or "default"
        kv["%s/time_conditions/TC%s/override" % (fam, tc["time_condition_id"])] = {
            "default": "no", "temporary_matched": "force_match", "temporary_unmatched": "force_unmatch",
            "permanently_matched": "force_match", "permanently_unmatched": "force_unmatch"}.get(st, "no")
    return kv
PYMIRRORFEAT
chmod 0644 /opt/connect-pbx-helper/mirror_features.py

cat >/opt/connect-pbx-helper/console_writes.py <<'PYCONSOLE'
"""PBX Console direct writes — phone provisioning and the geo firewall.

⛔⛔ WHY THIS EXISTS. Both of these are refused by the VitalPBX panel once the
licence lapses ("You've reached the maximum number of provisioned devices" past
20 phones; "You may only block one country on the free version"), while
extensions and tenant edits keep working. Proven on the unlicensed clone
2026-08-19. So these two operations — and only these two — write their rows
directly and then render, exactly like the tenant mirror does.

⛔ THE KEY FINDING (clone, 2026-08-19): the cap lives in the panel's SAVE
controller, NOT in the renderer. `Device::generateProvisioningFile()` called
from PHP CLI on an unlicensed box holding 55 phones regenerated a config
**byte-identical** to the panel's own (same sha256), and produced a working
config for a brand-new 56th phone which nginx then served with 200. So the
sanctioned path is: write the rows ourselves, then let VitalPBX's OWN generator
render them. We never re-implement the 427-model config renderer.

⛔ A phone's config is a STATIC FILE. The pretty URL
`/phoneprov/<tenant-hash>/<mac>.cfg` is served by a plain nginx alias — there is
no on-demand generation on the way in (proven: removing the file makes the fetch
404). So a row change that is not followed by a render leaves the handset on its
old settings, silently, forever. Every write here renders.
"""
import json
import os
import re
import subprocess
import time

PROV_ROOT = "/var/lib/vitalpbx/provisioning/provisioning_templates"
IPSET_DIR = "/etc/firewalld/ipsets"
GEO_BUILD = "/usr/share/vitalpbx/scripts/build_geo_firewall"
# ── the geo build's out-of-process channel (2026-08-19) ─────────────────────
# The builder needs root (it writes /etc/firewalld and reloads firewalld) and
# the helper unit sets NoNewPrivileges=yes, so sudo can NEVER work from here.
# The clean design (handoff §17): the helper drops a request file, a root-owned
# systemd .path unit (connect-geo-build.path) sees it and runs the builder as
# root, then writes result.json back where this process can read it. Same
# pattern as connect-media-sync.path. The privilege boundary stays honest: the
# root side runs ONE fixed command and takes no arguments from the request
# file, so owning this process buys "trigger a rebuild of what the DB already
# says" and nothing more.
GEO_UNIT_DIR = "/var/lib/connect-pbx-helper/geo-build"
GEO_UNIT_REQUEST = os.path.join(GEO_UNIT_DIR, "request")
GEO_UNIT_RESULT = os.path.join(GEO_UNIT_DIR, "result.json")
GEO_UNIT_PATH_UNIT = "connect-geo-build.path"
GEO_UNIT_TIMEOUT_S = int(os.environ.get("CONNECT_GEO_BUILD_TIMEOUT_S", "600"))
PHP_BIN = "/usr/bin/php"
CLI_INCLUDE = "/usr/share/vitalpbx/www/includes/cli.php"

MAC_RE = re.compile(r"^[0-9A-Fa-f]{12}$")
ISO_RE = re.compile(r"^[A-Za-z]{2}$")


def norm_mac(raw):
    """`AA:BB:CC:00:11:22` — the format VitalPBX stores and looks up by."""
    hexonly = re.sub(r"[^0-9A-Fa-f]", "", str(raw or "")).upper()
    if not MAC_RE.match(hexonly):
        raise ValueError("invalid_mac")
    return ":".join(hexonly[i:i + 2] for i in range(0, 12, 2))


def mac_filename(mac):
    """The config filename a handset asks for: lowercase hex, no separators."""
    return re.sub(r"[^0-9a-f]", "", str(mac or "").lower())


def _prov_conn(read_conn_factory):
    """A connection with the `provisioning` schema selected.

    ⛔ The helper's own connection is bound to `ombutel`; provisioning lives in a
    second schema, so every statement here is schema-qualified instead of
    relying on the default database. That also means the grant is explicit and
    narrow (see the installer): INSERT/UPDATE/DELETE on exactly two tables.
    """
    return read_conn_factory()


def list_phones(conn, tenant_id=None):
    with conn.cursor() as cur:
        sql = ("SELECT d.id, d.mac, d.model_id, d.template_id, d.tenant, d.description, "
               "pm.model AS model, b.name AS brand "
               "FROM provisioning.devices d "
               "LEFT JOIN provisioning.phone_models pm ON pm.id = d.model_id "
               "LEFT JOIN provisioning.brands b ON b.id = pm.brand_id")
        args = []
        if tenant_id:
            sql += " WHERE d.tenant = %s"
            args.append(int(tenant_id))
        sql += " ORDER BY d.tenant, d.description, d.mac"
        cur.execute(sql, args)
        return list(cur.fetchall())


def tenant_path(conn, tenant_id):
    with conn.cursor() as cur:
        cur.execute("SELECT path FROM ombutel.ombu_tenants WHERE tenant_id = %s", (int(tenant_id),))
        row = cur.fetchone()
    if not row:
        raise LookupError("tenant_not_found")
    return str(row["path"])


RENDER_PHP = "/opt/connect-pbx-helper/render_phone.php"


def generate_config(mac):
    """Render one phone's config with VitalPBX's OWN generator.

    ⛔ This is the whole trick: the generator has no licence check, so it works
    on an unlicensed, over-cap box (proven on the clone at 55 phones against a
    cap of 20, output byte-identical to the panel's own).

    ⛔⛔ IT MUST RUN AS www-data. The generator reads
    /etc/vitalpbx/vitalpbx-maint.conf, which is `-rw------- www-data` — a
    credentials file that should stay that way. Run as the helper's own
    `asterisk` user it fails with a PHP warning and then `no_device` (it cannot
    reach the database at all), which is exactly what the first production
    attempt did: the row was written and the phone got NO config. So this one
    script is run as www-data through a narrow sudoers line.
    """
    mac = norm_mac(mac)
    # ⛔ Run IN PROCESS as the helper's own user. The obvious "sudo -u www-data"
    # cannot work: the helper unit sets NoNewPrivileges=yes, so sudo is refused
    # outright ("the no new privileges flag is set"). Two narrow grants make the
    # direct run work instead, both applied by the installer:
    #   • a read ACL on /etc/vitalpbx/vitalpbx-maint.conf (one 128-char API token
    #     the generator needs — NOT database credentials), and
    #   • /var/lib/vitalpbx/provisioning in the unit's ReadWritePaths, because
    #     ProtectSystem=strict otherwise makes the whole tree read-only.
    proc = subprocess.run([PHP_BIN, RENDER_PHP, mac], text=True, capture_output=True, timeout=120, check=False)
    if proc.returncode != 0:
        raise ValueError("generate_failed:%s:%s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    out = (proc.stdout or "").strip()
    if "|" not in out:
        raise ValueError("generate_failed:unexpected_output:%s" % out[:200])
    path, size = out.rsplit("|", 1)
    return {"file": path, "bytes": int(size)}


def remove_config(conn, mac, tenant_id):
    """Delete a phone's cached config so a stale file can never be served."""
    fn = mac_filename(mac)
    removed = []
    try:
        path = tenant_path(conn, tenant_id)
    except LookupError:
        path = None
    if path:
        for suffix in (".cfg", "-phone.cfg", ".boot", ".xml"):
            p = os.path.join(PROV_ROOT, path, fn + suffix)
            if os.path.exists(p):
                try:
                    os.remove(p)
                    removed.append(p)
                except OSError:
                    pass
    return removed


def save_phone(conn, *, phone_id=None, mac, tenant_id, model_id, template_id=None,
               description="", accounts=None, keys=None, phonebook=None, expansion=None):
    """Create or update one provisioned phone, then render its config.

    `accounts` is the ordered list of `ombu_devices.device_id` values (or None
    for an empty line key) that register on this handset's lines.
    """
    mac = norm_mac(mac)
    tenant_id = int(tenant_id)
    model_id = int(model_id)
    with conn.cursor() as cur:
        # A MAC is the handset's identity — it may exist exactly once.
        cur.execute("SELECT id, tenant FROM provisioning.devices WHERE mac = %s", (mac,))
        clash = cur.fetchone()
        if clash and (phone_id is None or int(clash["id"]) != int(phone_id)):
            raise ValueError("mac_already_used")
        if phone_id:
            cur.execute(
                "UPDATE provisioning.devices SET mac=%s, model_id=%s, template_id=%s, tenant=%s, description=%s "
                "WHERE id=%s",
                (mac, model_id, template_id, tenant_id, description or "", int(phone_id)))
            new_id = int(phone_id)
        else:
            cur.execute(
                "INSERT INTO provisioning.devices (model_id, template_id, mac, tenant, description, `keys`, phonebook, expansion_module_keys) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (model_id, template_id, mac, tenant_id, description or "", keys, phonebook, expansion))
            cur.execute("SELECT LAST_INSERT_ID() AS id")
            new_id = int(cur.fetchone()["id"])
        if accounts is not None:
            cur.execute("DELETE FROM provisioning.accounts WHERE device_id = %s", (new_id,))
            for dev in accounts:
                cur.execute(
                    "INSERT INTO provisioning.accounts (device_id, phone_device_id) VALUES (%s, %s)",
                    (new_id, int(dev) if dev not in (None, "", "0") else None))
    conn.commit()
    # ⛔ Render AFTER the commit: the generator reads the database itself.
    # ⛔⛔ And if the render fails on a CREATE, take the row back out. A phone row
    # with no config file is the worst state to leave behind — the console lists
    # a phone, the handset gets nothing, and nobody finds out until somebody
    # plugs it in (this happened for real on the first production attempt). An
    # EDIT keeps its row, because that phone already has a working config and
    # silently undoing the edit would be a second surprise; either way it raises.
    remove_config(conn, mac, tenant_id)
    try:
        rendered = generate_config(mac)
    except Exception:
        if not phone_id:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM provisioning.accounts WHERE device_id = %s", (new_id,))
                cur.execute("DELETE FROM provisioning.devices WHERE id = %s", (new_id,))
            conn.commit()
        raise
    return {"phoneId": new_id, "mac": mac, "rendered": rendered}


def delete_phone(conn, phone_id):
    with conn.cursor() as cur:
        cur.execute("SELECT id, mac, tenant FROM provisioning.devices WHERE id = %s", (int(phone_id),))
        row = cur.fetchone()
        if not row:
            raise LookupError("phone_not_found")
        cur.execute("DELETE FROM provisioning.accounts WHERE device_id = %s", (int(phone_id),))
        cur.execute("DELETE FROM provisioning.devices WHERE id = %s", (int(phone_id),))
    conn.commit()
    removed = remove_config(conn, row["mac"], row["tenant"])
    return {"deletedPhoneId": int(phone_id), "mac": row["mac"], "filesRemoved": removed}


# ── geo firewall ─────────────────────────────────────────────────────────────

def _blocked_isos(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT iso FROM ombutel.ombu_geo_firewall WHERE blocked = 'yes' ORDER BY id")
        return [str(r["iso"]).lower() for r in cur.fetchall()]


def geo_state(conn):
    """What is blocked, and — only when we can actually tell — which of those the
    firewall can enforce.

    ⛔ A country with no ipset file cannot be enforced and is silently dropped by
    VitalPBX's own builder (5 of prod's 232 are in that state), which is the
    difference between the panel's "232 blocked" and the 227 rules that exist.
    ⛔⛔ BUT `/etc/firewalld` is root-only and this helper runs as `asterisk`, so
    the check itself can fail. When the directory cannot be read we say
    `ipsetDirReadable: false` and return NO enforceability verdict — an earlier
    version happily reported all 232 as "missing", which is a confident lie in
    the most alarming possible direction.
    """
    isos = _blocked_isos(conn)
    readable = os.path.isdir(IPSET_DIR) and os.access(IPSET_DIR, os.R_OK | os.X_OK)
    if not readable:
        return {"blocked": isos, "ipsetDirReadable": False, "enforceable": None, "missingIpset": None}
    enforceable, missing = [], []
    for iso in isos:
        (enforceable if os.path.exists(os.path.join(IPSET_DIR, "blacklist_%s.xml" % iso)) else missing).append(iso)
    return {"blocked": isos, "ipsetDirReadable": True, "enforceable": enforceable, "missingIpset": missing}


def geo_build_available():
    """Can we actually rebuild the firewall? The builder writes /etc/firewalld and
    reloads firewalld, so it needs root.

    ⛔⛔ NEVER PROBE BY RUNNING THE BUILDER. An earlier version ran
    `sudo -n <builder> --connect-probe` and treated "no error" as "available" —
    which would have REBUILT AND RELOADED THE LIVE FIREWALL just to answer a
    capability question, on a PBX carrying calls. It also mis-read the refusal:
    under `NoNewPrivileges=yes` sudo says "the no new privileges flag is set",
    which matched none of the strings it looked for, so it reported the build as
    available and the caller wrote flags it could not enforce.
    `sudo -l` ASKS without executing, which is the only safe question.
    """
    if os.geteuid() == 0 and os.access(GEO_BUILD, os.X_OK):
        return ["direct"]
    probe = subprocess.run(["sudo", "-n", "-l", GEO_BUILD], text=True,
                           capture_output=True, timeout=30, check=False)
    if probe.returncode == 0:
        return ["sudo"]
    if _geo_unit_ready():
        return ["unit"]
    return None


def _geo_unit_ready():
    """Is the root-side build channel installed and armed?

    Both halves are required: the request directory this process can write, AND
    the root path unit actively watching it. A writable directory with no
    watcher would accept requests that nothing ever runs — the console saying
    "blocked" while the firewall never changes, the exact lie set_geo_blocks
    exists to refuse. `systemctl is-active` is a read-only query and works for
    an unprivileged user; NoNewPrivileges does not affect it.
    """
    if not (os.path.isdir(GEO_UNIT_DIR) and os.access(GEO_UNIT_DIR, os.W_OK)):
        return False
    probe = subprocess.run(["systemctl", "is-active", "--quiet", GEO_UNIT_PATH_UNIT],
                           timeout=15, check=False)
    return probe.returncode == 0


def _geo_unit_build():
    """Hand the rebuild to the root path unit and wait for its verdict.

    The request file carries ONLY a correlation id — the root side runs a fixed
    command and reads nothing else from it. We poll result.json for our own id;
    a stale result from an earlier build can never be mistaken for this one.
    """
    req_id = "geo-%d-%d" % (os.getpid(), time.time_ns())
    tmp = GEO_UNIT_REQUEST + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(req_id + "\n")
    os.replace(tmp, GEO_UNIT_REQUEST)
    deadline = time.monotonic() + GEO_UNIT_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            with open(GEO_UNIT_RESULT) as fh:
                res = json.load(fh)
            if res.get("requestId") == req_id:
                return {"code": int(res.get("code", -1)),
                        "out": str(res.get("output") or "").strip()[:400], "err": ""}
        except (OSError, ValueError):
            pass
        time.sleep(1)
    # ⛔ By this point the blocked flags ARE in the database and the build may
    # still be running — say exactly that, never "nothing was changed".
    raise ValueError(
        "geo_build_timeout: the firewall rebuild was handed to the root unit and has not "
        "reported back within %ss. The country flags ARE saved and the rebuild may still be "
        "running — check `journalctl -u connect-geo-build` on the PBX before retrying." % GEO_UNIT_TIMEOUT_S)


def set_geo_blocks(conn, *, block=(), unblock=()):
    """Set/clear the blocked flag for whole countries, then rebuild the firewall.

    ⛔ The rebuild is VitalPBX's OWN `build_geo_firewall`, for the same reason the
    provisioning render is: it is the thing that already produces the live rules,
    and re-implementing a firewall is how you lock everybody out. The caller gets
    the before/after rule counts so a build that silently produced nothing is
    visible instead of being reported as success.
    """
    block = [str(x).strip().lower() for x in (block or []) if ISO_RE.match(str(x).strip())]
    unblock = [str(x).strip().lower() for x in (unblock or []) if ISO_RE.match(str(x).strip())]
    if not block and not unblock:
        raise ValueError("nothing_to_change")
    overlap = set(block) & set(unblock)
    if overlap:
        raise ValueError("iso_both_block_and_unblock:%s" % ",".join(sorted(overlap)))
    # ⛔ REFUSE rather than write a flag we cannot enforce. Setting `blocked` with
    # no rebuild leaves the console saying "blocked" while the firewall lets the
    # traffic straight through — worse than refusing, because nobody looks again.
    runner = geo_build_available()
    if not runner:
        raise ValueError("geo_build_not_permitted: the firewall rebuild needs root "
                         "(install/enable the connect-geo-build path unit the installer ships), "
                         "so the block was NOT applied")
    before = geo_state(conn)
    with conn.cursor() as cur:
        if block:
            cur.execute("UPDATE ombutel.ombu_geo_firewall SET blocked='yes' WHERE lower(iso) IN (%s)"
                        % ",".join(["%s"] * len(block)), block)
        if unblock:
            cur.execute("UPDATE ombutel.ombu_geo_firewall SET blocked='no' WHERE lower(iso) IN (%s)"
                        % ",".join(["%s"] * len(unblock)), unblock)
    conn.commit()
    if runner == ["unit"]:
        build = _geo_unit_build()
    else:
        cmd = [GEO_BUILD] if runner == ["direct"] else ["sudo", "-n", GEO_BUILD]
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=900, check=False)
        build = {"code": proc.returncode, "out": (proc.stdout or "").strip()[:400],
                 "err": (proc.stderr or "").strip()[:400]}
    # ⛔ The after-state is read AFTER the build on purpose: the enforceability
    # view is about ipset files the builder itself maintains, so reading it
    # before the build reports the world the build is about to replace.
    after = geo_state(conn)
    # ⛔ `enforceable`/`missingIpset` are None when /etc/firewalld cannot be read
    # (see geo_state) — len(None) is what turned an honest refusal into a Python
    # error in the caller's face.
    n = lambda v: (len(v) if v is not None else None)
    return {
        "blockedBefore": n(before["blocked"]), "blockedAfter": n(after["blocked"]),
        "enforceableBefore": n(before["enforceable"]), "enforceableAfter": n(after["enforceable"]),
        "missingIpset": after["missingIpset"],
        "build": {"via": runner[0], "code": build["code"], "out": build["out"], "err": build["err"]},
    }


def whitelist_state(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT firewall_whitelist_id AS id, host, description, `default` AS is_default "
                    "FROM ombutel.ombu_firewall_whitelist ORDER BY firewall_whitelist_id")
        return list(cur.fetchall())
PYCONSOLE
chmod 0644 /opt/connect-pbx-helper/console_writes.py

cat >/opt/connect-pbx-helper/render_phone.php <<'PHPRENDER'
<?php
/**
 * PBX Console — render ONE phone's provisioning config with VitalPBX's own generator.
 *
 * ⛔ WHY THIS FILE EXISTS AT ALL. The helper runs as `asterisk`, but VitalPBX's
 * provisioning generator reads /etc/vitalpbx/vitalpbx-maint.conf, which is
 * `-rw------- www-data` — a credentials file that must stay that way. So instead
 * of widening that file's permissions, the helper runs THIS script as www-data
 * through one narrow sudoers line. The script can do exactly one thing: render
 * the config for a MAC that already exists in the provisioning database.
 *
 * ⛔ It takes a MAC and nothing else, validates the shape before use, and never
 * creates, edits or deletes a row — so the sudo grant cannot be turned into
 * "run arbitrary PHP as www-data".
 */
require_once('/usr/share/vitalpbx/www/includes/cli.php');

$raw = $argv[1] ?? '';
if (!preg_match('/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/', $raw)) {
    fwrite(STDERR, "invalid_mac\n");
    exit(2);
}
$mac = strtoupper($raw);

$dev = \modules\provisioning\Device::getByMAC($mac);
if (!$dev || !$dev->id) {
    fwrite(STDERR, "no_device\n");
    exit(3);
}

$dev->generateProvisioningFile();
$file = $dev->getProvisioningFile();
if (!$file || !file_exists($file)) {
    fwrite(STDERR, "not_generated\n");
    exit(4);
}

echo $file . '|' . filesize($file);
PHPRENDER
chmod 0644 /opt/connect-pbx-helper/render_phone.php

# -- PBX Console: what the phone-config generator needs -----------------------
# It runs in-process as `asterisk` (the unit sets NoNewPrivileges, so sudo is
# refused). Two narrow grants, both reversible:
#   1. read on ONE file: a 128-char maintenance API token the generator reads.
#   2. write on the provisioning tree, which ProtectSystem=strict otherwise
#      makes read-only for this unit.
setfacl -m u:asterisk:r /etc/vitalpbx/vitalpbx-maint.conf 2>/dev/null || true
install -d -m 0755 /etc/systemd/system/connect-pbx-helper.service.d
cat >/etc/systemd/system/connect-pbx-helper.service.d/20-provisioning-write.conf <<'UNITDROP'
[Service]
ReadWritePaths=/var/lib/vitalpbx/provisioning
UNITDROP
systemctl daemon-reload

# -- PBX Console: the geo firewall rebuild needs root -------------------------
# The helper runs as `asterisk`; the geo builder writes /etc/firewalld and
# reloads firewalld, which asterisk cannot do. ONE narrow sudoers line for
# exactly that script -- no arguments, no wildcard, nothing else. Without it the
# helper REFUSES a geo change rather than setting a flag it cannot enforce.
install -d -m 0755 /etc/sudoers.d
cat >/etc/sudoers.d/connect-pbx-console <<'SUDOERS'
asterisk ALL=(root) NOPASSWD: /usr/share/vitalpbx/scripts/build_geo_firewall
SUDOERS
chmod 0440 /etc/sudoers.d/connect-pbx-console
visudo -cf /etc/sudoers.d/connect-pbx-console >/dev/null || { echo "sudoers file invalid - removing"; rm -f /etc/sudoers.d/connect-pbx-console; }

# -- PBX Console: the geo build's OUT-OF-PROCESS root channel (2026-08-19) ----
# The sudoers line above can never actually fire from the helper: the unit sets
# NoNewPrivileges=yes, so sudo is refused outright ("the no new privileges flag
# is set"). It stays because it costs nothing and works the day anyone runs the
# builder from a root shell. The path that DOES work is this one — the same
# design as connect-media-sync.path: the helper (as asterisk) drops a request
# file, a root path unit sees it and runs VitalPBX's OWN build_geo_firewall,
# then writes result.json back where the helper can read it.
# ⛔ The privilege boundary is the whole point: the root side runs ONE fixed
# command and reads NOTHING from the request file except a correlation id it
# sanitises — so a compromised helper buys "rebuild what the DB already says"
# and nothing more.
install -d -m 0755 -o asterisk -g asterisk /var/lib/connect-pbx-helper/geo-build

cat >/usr/local/sbin/connect-geo-build <<'GEOBUILD'
#!/usr/bin/env bash
# connect-geo-build — root-side runner for PBX Console geo firewall rebuilds.
# Triggered by connect-geo-build.path when the helper drops a request file.
# ⛔ Takes NO input from the request file except a correlation id (sanitised).
# ⛔ Backs up /etc/firewalld/direct.xml before every build — that file's mtime
#    is the authoritative "did the build run" evidence (rule counts are noisy:
#    fail2ban's live bans come and go).
set -u
DIR=/var/lib/connect-pbx-helper/geo-build
REQ="$DIR/request"
WORK="$DIR/request.working.$$"
RESULT="$DIR/result.json"
BACKUPS="$DIR/backups"
BUILDER=/usr/share/vitalpbx/scripts/build_geo_firewall

[ -f "$REQ" ] || exit 0
mv -f "$REQ" "$WORK" 2>/dev/null || exit 0   # a parallel run consumed it first

REQ_ID=$(head -c 200 "$WORK" | tr -cd 'A-Za-z0-9._-' | head -c 80)
rm -f "$WORK"

install -d -m 0700 "$BACKUPS"
TS=$(date -u +%Y%m%dT%H%M%SZ)
[ -f /etc/firewalld/direct.xml ] && cp -a /etc/firewalld/direct.xml "$BACKUPS/direct.xml.$TS"
ls -1t "$BACKUPS"/direct.xml.* 2>/dev/null | tail -n +11 | xargs -r rm -f

START=$(date -u +%FT%TZ)
OUT=$("$BUILDER" 2>&1); CODE=$?
END=$(date -u +%FT%TZ)
echo "connect-geo-build: request=$REQ_ID code=$CODE"

# result.json is written atomically and left world-readable so the helper
# (running as asterisk) can poll it. The exit code travels IN the result; the
# unit itself always succeeds so a builder failure cannot wedge the path unit.
TMP=$(mktemp "$DIR/.result.XXXXXX")
OUT_JSON=$(printf '%s' "$OUT" | tail -c 800 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
printf '{"requestId":"%s","code":%d,"startedAt":"%s","finishedAt":"%s","output":%s}\n' \
  "$REQ_ID" "$CODE" "$START" "$END" "$OUT_JSON" > "$TMP"
chmod 0644 "$TMP"
mv -f "$TMP" "$RESULT"
exit 0
GEOBUILD
chmod 0755 /usr/local/sbin/connect-geo-build

cat >/etc/systemd/system/connect-geo-build.service <<'GEOSVC'
[Unit]
Description=Connect PBX Console - geo firewall rebuild (root side)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/connect-geo-build
GEOSVC

cat >/etc/systemd/system/connect-geo-build.path <<'GEOPATH'
[Unit]
Description=Connect PBX Console - watch for geo firewall build requests

[Path]
PathExists=/var/lib/connect-pbx-helper/geo-build/request
Unit=connect-geo-build.service

[Install]
WantedBy=multi-user.target
GEOPATH

systemctl daemon-reload
systemctl enable --now connect-geo-build.path

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

# transport-wss cert self-heal (certfix, 2026-07). See docs/pbx/inbound-route-helper.md.
# Defaults below match the current PBX layout; override only if the base pjsip.conf
# path or the VitalPBX-managed cert bundle location changes.
CONNECT_PBX_TRANSPORT_WSS_CONF_PATH=/etc/asterisk/pjsip.conf
CONNECT_PBX_TRANSPORT_WSS_SECTION=transport-wss
CONNECT_PBX_TRANSPORT_WSS_DESIRED_CERT_FILE=/usr/share/vitalpbx/certificates/m.connectcomunications.com/bundle.pem
CONNECT_PBX_TRANSPORT_WSS_DESIRED_KEY_FILE=/usr/share/vitalpbx/certificates/m.connectcomunications.com/private.pem
CONNECT_PBX_TRANSPORT_WSS_RELOAD_COMMAND='asterisk -rx "module reload res_pjsip.so"'
EOF

chmod 0600 /etc/connect-pbx-helper.env
chown root:root /etc/connect-pbx-helper.env

# Install the Connect VM greeting dialplan as a drop-in file matching
# VitalPBX's `#include vitalpbx/extensions__*.conf` glob in
# /etc/asterisk/extensions.conf. The DOUBLE underscore in the filename
# is REQUIRED — single-underscore drop-ins are not picked up by
# `dialplan reload` on this VitalPBX install. Ownership must be
# asterisk:asterisk 0644, otherwise the asterisk process (which does
# not run as root) cannot read the file and silently skips it.
DIALPLAN_TARGET=/etc/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf
DIALPLAN_LEGACY_FILES=(
  /etc/asterisk/vitalpbx/extensions_95-connect-vm-greeting.conf
  /etc/asterisk/extensions__95_connect_vm_greeting.conf
  /etc/asterisk/extensions_95_connect_vm_greeting.conf
)
DIALPLAN_LEGACY_INLINE_FILES=(
  /etc/asterisk/extensions_custom.conf
  /etc/asterisk/extensions__88_custom.conf
  /etc/asterisk/extensions__60_custom.conf
)

# Remove old drop-in files from prior installer revisions so there is
# exactly one source of truth.
for f in "${DIALPLAN_LEGACY_FILES[@]}"; do
  rm -f "${f}"
done

# Strip any embedded BEGIN/END block from prior `extensions_custom.conf`
# inline-embed strategy. We stopped doing that because not every VitalPBX
# install actually `#includes` extensions_custom.conf.
for f in "${DIALPLAN_LEGACY_INLINE_FILES[@]}"; do
  if [[ -f "${f}" ]]; then
    python3 - "${f}" <<'PY'
import sys, re
p = sys.argv[1]
try:
    with open(p, "r") as fh:
        body = fh.read()
except FileNotFoundError:
    sys.exit(0)
new_body = re.sub(
    r"(?ms)^[ \t]*; >>> CONNECT_VM_GREETING_BLOCK_BEGIN.*?; <<< CONNECT_VM_GREETING_BLOCK_END <<<\s*\n?",
    "",
    body,
)
new_body = re.sub(
    r"(?m)^\s*#tryinclude\s+/etc/asterisk/vitalpbx/extensions_(?:_)?95[-_]connect[-_]vm[-_]greeting\.conf\s*\n?",
    "",
    new_body,
)
new_body = re.sub(r"\n{3,}", "\n\n", new_body)
if new_body != body:
    with open(p, "w") as fh:
        fh.write(new_body)
PY
  fi
done

install -d -o asterisk -g asterisk -m 0755 /etc/asterisk/vitalpbx 2>/dev/null || true

cat >"${DIALPLAN_TARGET}" <<'EOF'
; Installed by Connect PBX helper. This file is auto-managed; do not edit.
;
; Phase B (2026-05-07): the recording flow runs ONLY after the dispatched
; Dial() answers. We use Dial(...,U(connect-vm-greeting-record-sub^...))
; so the Gosub fires on the answered party's channel and the original
; Local channel never starts prompts before the phone rings. AstDB
; populates the dial string so multiple registered endpoints (hardphone +
; mobile + WebRTC) all ring in parallel.
;
; Phase C (2026-05-07): resolve the actual VitalPBX voicemail context from
; AstDB (connect_vm_context/T<tenant>_<ext>) so recordings are written to
; the correct spool path (e.g. test-voicemail/101/) instead of the wrong
; numeric path (21/101/). Falls back to the numeric tenant id if the key
; is absent (backward compat for tenants not yet re-originated).
[connect-vm-greeting-dispatch]
exten => _X!,1,NoOp(Connect VM dispatch ${EXTEN})
 same => n,Set(CONNECT_VM_TENANT=${CUT(EXTEN,_,1)})
 same => n,Set(CONNECT_VM_EXT=${CUT(EXTEN,_,2)})
 same => n,Set(CONNECT_VM_FILE=${CUT(EXTEN,_,3)})
 same => n,Set(CALLERID(name)=Voicemail Greeting Recording)
 same => n,Set(CALLERID(num)=${CONNECT_VM_EXT})
 same => n,Wait(1)
 same => n,Set(CONNECT_VM_BASE_EP=T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})
 same => n,Set(CONNECT_VM_C1=${PJSIP_DIAL_CONTACTS(${CONNECT_VM_BASE_EP})})
 same => n,Set(CONNECT_VM_C2=${PJSIP_DIAL_CONTACTS(${CONNECT_VM_BASE_EP}_1)})
 same => n,Set(CONNECT_VM_DIAL=${CONNECT_VM_C1})
 same => n,ExecIf($[${LEN(${CONNECT_VM_C2})} > 0 & ${LEN(${CONNECT_VM_DIAL})} > 0]?Set(CONNECT_VM_DIAL=${CONNECT_VM_DIAL}&${CONNECT_VM_C2}))
 same => n,ExecIf($[${LEN(${CONNECT_VM_C2})} > 0 & ${LEN(${CONNECT_VM_DIAL})} = 0]?Set(CONNECT_VM_DIAL=${CONNECT_VM_C2}))
 same => n,GotoIf($[${LEN(${CONNECT_VM_DIAL})} > 0]?resolve_context)
 same => n,Set(CONNECT_VM_DIAL=${DB(connect_vm_dial/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})
 same => n,GotoIf($["${CONNECT_VM_DIAL}" = ""]?nodevices)
 same => n(resolve_context),Set(CONNECT_VM_CONTEXT=${DB(connect_vm_context/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})
 same => n,GotoIf($["${CONNECT_VM_CONTEXT}" != ""]?have_context)
 same => n,Set(CONNECT_VM_CONTEXT=${CONNECT_VM_TENANT})
 same => n(have_context),Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))
 same => n,Hangup()
 same => n(nodevices),Verbose(1,Connect VM dispatch: no registered devices for T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})
 same => n,Hangup()

; Post-answer subroutine. Runs on the answered party's channel only AFTER
; Dial() picks up. Args: ARG1=vmContext, ARG2=extension, ARG3=greetingFile.
[connect-vm-greeting-record-sub]
exten => s,1,NoOp(Connect VM record sub context=${ARG1} ext=${ARG2} file=${ARG3})
 same => n,Set(CONNECT_VM_CONTEXT=${ARG1})
 same => n,Set(CONNECT_VM_EXT=${ARG2})
 same => n,Set(CONNECT_VM_FILE=${ARG3})
 same => n,Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)
 same => n,Set(CONNECT_VM_TMP=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/.connect-${UNIQUEID}-${CONNECT_VM_FILE})
 same => n,Wait(1)
 same => n(start),Playback(custom/connect-vm-record-greeting)
 same => n,Playback(beep)
 same => n,Record(${CONNECT_VM_TMP}.wav,0,180,kq)
 same => n,Playback(custom/connect-vm-review)
 same => n,Playback(${CONNECT_VM_TMP})
 same => n(choose),Read(CONNECT_VM_CHOICE,custom/connect-vm-save-redo,1,,3,10)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "1"]?save)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "2"]?redo)
 same => n,Playback(custom/connect-vm-invalid-choice)
 same => n,Goto(choose)
 same => n(redo),System(rm -f ${CONNECT_VM_TMP}.wav)
 same => n,Goto(start)
 same => n(save),System(mv -f ${CONNECT_VM_TMP}.wav ${CONNECT_VM_PATH})
 same => n,System(chown asterisk:asterisk ${CONNECT_VM_PATH})
 same => n,System(chmod 0644 ${CONNECT_VM_PATH})
 same => n,Playback(custom/connect-vm-saved)
 same => n,Hangup()

exten => h,1,System(rm -f ${CONNECT_VM_TMP}.wav)

; Legacy context retained for back-compat. The Phase A dialplan and any
; older Connect API build that originates `extension X@connect-vm-greeting-record`
; still works. The new originate path uses dispatch + record-sub above.
[connect-vm-greeting-record]
exten => _X!,1,NoOp(Connect voicemail greeting record request ${EXTEN})
 same => n,Set(CONNECT_VM_PARSE=${REGEX("^([0-9]+)_([0-9]+)_(unavail|busy|temp|greet)$" ${EXTEN})})
 same => n,GotoIf($["${CONNECT_VM_PARSE}" = "1"]?valid:invalid)
 same => n(valid),Set(CONNECT_VM_TENANT=${CUT(EXTEN,_,1)})
 same => n,Set(CONNECT_VM_EXT=${CUT(EXTEN,_,2)})
 same => n,Set(CONNECT_VM_FILE=${CUT(EXTEN,_,3)})
 same => n,Set(CONNECT_VM_CONTEXT=${DB(connect_vm_context/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})
 same => n,GotoIf($["${CONNECT_VM_CONTEXT}" != ""]?have_ctx)
 same => n,Set(CONNECT_VM_CONTEXT=${CONNECT_VM_TENANT})
 same => n(have_ctx),Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)
 same => n,Set(CONNECT_VM_TMP=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/.connect-${UNIQUEID}-${CONNECT_VM_FILE})
 same => n,Answer()
 same => n,Wait(1)
 same => n(start),Playback(custom/connect-vm-record-greeting)
 same => n,Playback(beep)
 same => n,Record(${CONNECT_VM_TMP}.wav,0,180,kq)
 same => n,Playback(custom/connect-vm-review)
 same => n,Playback(${CONNECT_VM_TMP})
 same => n(choose),Read(CONNECT_VM_CHOICE,custom/connect-vm-save-redo,1,,3,10)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "1"]?save)
 same => n,GotoIf($["${CONNECT_VM_CHOICE}" = "2"]?redo)
 same => n,Playback(custom/connect-vm-invalid-choice)
 same => n,Goto(choose)
 same => n(redo),System(rm -f ${CONNECT_VM_TMP}.wav)
 same => n,Goto(start)
 same => n(save),System(mv -f ${CONNECT_VM_TMP}.wav ${CONNECT_VM_PATH})
 same => n,System(chown asterisk:asterisk ${CONNECT_VM_PATH})
 same => n,System(chmod 0644 ${CONNECT_VM_PATH})
 same => n,Playback(custom/connect-vm-saved)
 same => n,Hangup()
 same => n(invalid),Verbose(1,Rejecting invalid Connect voicemail greeting record request ${EXTEN})
 same => n,Hangup()
EOF
chown asterisk:asterisk "${DIALPLAN_TARGET}"
chmod 0644 "${DIALPLAN_TARGET}"
echo "Installed Connect VM greeting dialplan: ${DIALPLAN_TARGET}"
ls -la "${DIALPLAN_TARGET}" || true

asterisk -rx "dialplan reload" || true
asterisk -rx "dialplan show connect-vm-greeting-record" >/tmp/connect-vm-dialplan-check.txt 2>&1 || true
asterisk -rx "dialplan show connect-vm-greeting-dispatch" >>/tmp/connect-vm-dialplan-check.txt 2>&1 || true
echo
echo "Dialplan load check:"
head -20 /tmp/connect-vm-dialplan-check.txt 2>/dev/null || true

echo "Creating narrow MySQL user connect_route_helper..."
mysql ${MYSQL_ROOT_ARGS} <<SQL
CREATE USER IF NOT EXISTS 'connect_route_helper'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
ALTER USER 'connect_route_helper'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
CREATE USER IF NOT EXISTS 'connect_route_helper'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASS}';
ALTER USER 'connect_route_helper'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASS}';
GRANT SELECT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'localhost';
GRANT UPDATE (destination_id, music_group_id) ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_extensions TO 'connect_route_helper'@'localhost';
GRANT UPDATE (music_group_id) ON ombutel.ombu_extensions TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_queues TO 'connect_route_helper'@'localhost';
GRANT UPDATE (music_group_id) ON ombutel.ombu_queues TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_music_groups TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_destinations TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (destination_id, music_group_id) ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_extensions TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (music_group_id) ON ombutel.ombu_extensions TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_queues TO 'connect_route_helper'@'127.0.0.1';
GRANT UPDATE (music_group_id) ON ombutel.ombu_queues TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_music_groups TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON ombutel.ombu_destinations TO 'connect_route_helper'@'127.0.0.1';
-- the MIRROR renderer reads the whole ombutel schema (byte-identical file generation), so it needs
-- broad SELECT. Read-only; the write grants below are the only mutations.
GRANT SELECT ON ombutel.* TO 'connect_route_helper'@'localhost';
GRANT SELECT ON ombutel.* TO 'connect_route_helper'@'127.0.0.1';
-- the MIRROR (2026-08-19): /mirror/tenant-create writes the rows the panel writes for a NEW tenant
-- (scripts/pbx/mirror/mirror_writes.py::create_tenant). SELECT+INSERT only, no UPDATE/DELETE.
GRANT SELECT, INSERT ON ombutel.ombu_tenants TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenants_users TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_settings TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_classes_of_service TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_dial_profiles TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_maintenance TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_parking_lots TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_numbers TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_ars TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_dids TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'localhost';
GRANT INSERT ON ombutel.ombu_destinations TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_queued_changes TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_settings TO 'connect_route_helper'@'localhost';
GRANT SELECT, INSERT ON ombutel.ombu_tenants TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_tenants_users TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_settings TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_classes_of_service TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_dial_profiles TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_maintenance TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_parking_lots TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_numbers TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_ars TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_tenant_dids TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_inbound_routes TO 'connect_route_helper'@'127.0.0.1';
GRANT INSERT ON ombutel.ombu_destinations TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_queued_changes TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT ON ombutel.ombu_settings TO 'connect_route_helper'@'127.0.0.1';
-- PBX Console (2026-08-19): the two operations the unlicensed panel refuses.
-- Deliberately the narrowest grants that do the job — two provisioning tables
-- and one column-level flag; no DROP, no schema-wide write anywhere.
GRANT SELECT, INSERT, UPDATE, DELETE ON provisioning.devices TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON provisioning.accounts TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON provisioning.phone_models TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON provisioning.brands TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT ON provisioning.templates TO 'connect_route_helper'@'127.0.0.1';
GRANT SELECT, UPDATE (blocked) ON ombutel.ombu_geo_firewall TO 'connect_route_helper'@'127.0.0.1';
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
# 2026-08-06: restore_gui_conf_ownership()/_chown_gui_conf() hand each
# regenerated tenant conf back to www-data so the VitalPBX panel can still
# save it. Handing a file to ANOTHER user is root-only, so as a plain
# User=asterisk process every one of those calls raised PermissionError and
# was swallowed by design ("never raises") — the fix shipped in fc826643 was
# live and silently doing nothing, and the panel stayed locked out with
# "file_put_contents ... Permission denied". These are the two narrow
# capabilities that code needs and nothing more; do NOT run this as root.
AmbientCapabilities=CAP_CHOWN CAP_FOWNER
CapabilityBoundingSet=CAP_CHOWN CAP_FOWNER
# 2026-08-12: the default 1024-fd soft limit is what turned an overload into a
# hard wedge (every open() -> Errno 24, including the helper's own sqlite +
# audit files). The in-process cap (CONNECT_PBX_HELPER_MAX_INFLIGHT) is the
# real guard; this is headroom so fd pressure never lands exactly on the code
# that needs an fd to report the problem.
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/connect-pbx-helper /var/lib/asterisk/sounds/custom /var/spool/asterisk/voicemail /run/asterisk /etc/asterisk /var/lib/vitalpbx/static
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
  CONNECT_PBX_TRANSPORT_WSS_CONF_PATH=/etc/asterisk/pjsip.conf \
  CONNECT_PBX_TRANSPORT_WSS_SECTION=transport-wss \
  CONNECT_PBX_TRANSPORT_WSS_DESIRED_CERT_FILE=/usr/share/vitalpbx/certificates/m.connectcomunications.com/bundle.pem \
  CONNECT_PBX_TRANSPORT_WSS_DESIRED_KEY_FILE=/usr/share/vitalpbx/certificates/m.connectcomunications.com/private.pem \
  CONNECT_PBX_TRANSPORT_WSS_RELOAD_COMMAND='asterisk -rx "module reload res_pjsip.so"' \
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
echo "Helper also accepts transport-wss cert self-heal endpoints (certfix, 2026-07):"
echo "  GET  /transport-wss/status              (read-only; never writes)"
echo "  POST /ensure-transport-wss-cert          (idempotent no-op if cert already valid;"
echo "                                             pass {\"dryRun\": true} to preview the plan"
echo "                                             without writing)"
echo
echo "Verify with:"
echo "  curl -sS http://${HELPER_BIND}:${HELPER_PORT}/health"
echo "  ls -la /var/lib/asterisk/sounds/custom/   # connect-route-helper must be in 'asterisk' group"
echo
echo "Service status:"
systemctl status connect-pbx-helper --no-pager -l || true
