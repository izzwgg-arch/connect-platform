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

VERSION = "2026.08.22.1"
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

def redact_secrets(value):
    """Deep-copy with any key whose name contains secret/password replaced by
    '***'. The mirror extension edit posts device secrets and voicemail
    passwords; an audit trail is the wrong place for either (the robot panel
    password already leaked once through a shell mistake — never again via
    this file)."""
    if isinstance(value, dict):
        return {k: ("***" if any(s in str(k).lower() for s in ("secret", "password")) and v not in (None, "")
                    else redact_secrets(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [redact_secrets(v) for v in value]
    return value


def audit(action, ok, payload, result=None, error=None):
    entry = {"ts": utc_now(), "version": VERSION, "action": action, "ok": ok,
             "payload": redact_secrets(payload), "result": redact_secrets(result), "error": error}
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


def mirror_extension_edit(body):
    """Edit an EXISTING extension without the panel (2026-08-22).

    ⛔ WHY THIS EXISTS: over the free tier's 12-extension cap the panel refuses
    an extension edit-SAVE outright (proven on the Community-edition clone
    2026-08-21, both request shapes), and the fleet holds 119 extensions — so
    the day the licence lapses this is the ONLY way an extension changes.
    While the licence is live the console still edits through the panel; the
    api falls back here only when the panel answers the cap refusal.

    Two halves, in order: mirror_writes.edit_extension UPDATEs the same rows
    the panel's save writes (whitelisted columns, one transaction), then
    apply_extension_edit_pbx splices ONLY this extension's pjsip blocks and
    voicemail line into the tenant's existing files (tmp + os.replace, the
    same atomic shape as the helper's other conf writers), refreshes the
    bounded AstDB key set, and reloads. ⛔ Never a whole-tenant re-render —
    that would rewrite hand-edited lines on OTHER extensions (the opus
    overrides) and, as recorded in the licence-exit assessment, a full
    re-render by this user cannot reopen files it already chowned to www-data.
    """
    mw = _load_mirror_writes()
    tenant_id = require_num("tenantId", body.get("tenantId"))
    extension = str(body.get("extension") or "").strip()
    if not re.fullmatch(r"\d{1,6}", extension):
        raise ValueError("extension must be the extension number")
    set_fields = body.get("set") or {}
    vm_fields = body.get("vm") or {}
    devices = body.get("devices") or []
    if not isinstance(set_fields, dict) or not isinstance(vm_fields, dict) or not isinstance(devices, list):
        raise ValueError("set/vm must be objects and devices a list")
    if not set_fields and not vm_fields and not devices:
        raise ValueError("nothing to change")
    conn = db_conn()
    try:
        res = mw.edit_extension(conn, int(tenant_id), extension, set=set_fields, vm=vm_fields, devices=devices)
    finally:
        conn.close()
    applied = None
    try:
        applied = mw.apply_extension_edit_pbx(_mirror_read_conn(), int(tenant_id), extension)
    except Exception as exc:
        # The rows ARE updated; a failed file patch must be visible, not silent —
        # the caller re-renders or retries rather than believing the phone changed.
        applied = {"error": str(exc)}
    return {"ok": True, "tenantId": int(tenant_id), "extension": extension,
            "extensionId": res.get("extensionId"), "changed": res.get("changed"), "applied": applied}


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
            "/mirror/extension-edit": mirror_extension_edit,
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
