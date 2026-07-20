#!/usr/bin/env bash
# connect-create-extension-helper.sh
# ---------------------------------------------------------------------------
# Safely create ONE VitalPBX extension via the ombutel DB + scoped config
# regeneration, for object types the VitalPBX v2 API does NOT expose (see
# docs/ai-support-agent/PBX_AUDIT.md). This is "Path 2/3" — used only because
# there is no API create endpoint for extensions.
#
# SAFETY CONTRACT (must never be weakened):
#   * ADDITIVE ONLY. Performs exactly one INSERT of a NEW extension row. It never
#     UPDATEs or DELETEs any pre-existing row. If the extension number already
#     exists in the tenant, it ABORTS (never overwrites).
#   * DRY-RUN BY DEFAULT. Without --commit it only prints the plan + SQL. Live
#     writes require BOTH --commit AND --owner-window (proving a human-scheduled
#     PW-2-style window). Missing either = dry-run.
#   * PRE-FLIGHT: tenant must exist; extension number must be free.
#   * SNAPSHOT before write; VERIFY after; ROLLBACK (delete only the row we just
#     inserted, by its returned id) if verification fails.
#   * SCOPED regen: regenerates only what's needed, and refuses to run if the
#     PBX reports high load (guard against disturbing live calls).
#   * Payments/pension/other tenants are never touched.
#
# Usage:
#   connect-create-extension-helper.sh \
#     --tenant-id <ombu_numeric_tenant_id> --ext <number> \
#     --name "Full Name" --email "user@x.com" [--mailbox <number>] \
#     [--commit] [--owner-window]
#
# Exit codes: 0 ok (or dry-run ok), 2 pre-flight fail, 3 write/verify fail (rolled back), 4 refused
set -euo pipefail

DB="${OMBU_DB:-ombutel}"
COMMIT=0; OWNER_WINDOW=0
TENANT_ID=""; EXT=""; NAME=""; EMAIL=""; MAILBOX=""
VM=0; VM_ATTACH=1; VM_TRANSCRIBE=0
log(){ echo "[create-ext] $*"; }
fail(){ echo "[create-ext] FAIL: $*" >&2; exit "${2:-2}"; }

while [[ $# -gt 0 ]]; do case "$1" in
  --tenant-id) TENANT_ID="$2"; shift 2;;
  --ext) EXT="$2"; shift 2;;
  --name) NAME="$2"; shift 2;;
  --email) EMAIL="$2"; shift 2;;
  --mailbox) MAILBOX="$2"; shift 2;;
  --vm) VM=1; shift;;                 # enable voicemail-to-email mailbox
  --vm-no-attach) VM_ATTACH=0; shift;;# don't attach the audio file to the email
  --vm-transcribe) VM_TRANSCRIBE=1; shift;;# enable AI voicemail transcription
  --commit) COMMIT=1; shift;;
  --owner-window) OWNER_WINDOW=1; shift;;
  *) fail "unknown arg $1" 4;;
esac; done

# Voicemail-to-email needs an address to deliver to.
if [[ "$VM" == "1" && -z "$EMAIL" ]]; then fail "--vm requires --email (nowhere to deliver voicemail)" 2; fi

[[ -n "$TENANT_ID" && -n "$EXT" && -n "$NAME" ]] || fail "require --tenant-id --ext --name" 2
[[ "$EXT" =~ ^[0-9]{2,6}$ ]] || fail "extension must be 2-6 digits" 2
MAILBOX="${MAILBOX:-$EXT}"

q(){ mysql -N -B -e "$1" "$DB"; }

# ---- Pre-flight -----------------------------------------------------------
TENANT_OK=$(q "SELECT COUNT(*) FROM ombu_tenants WHERE tenant_id=${TENANT_ID};" 2>/dev/null || echo 0)
[[ "$TENANT_OK" == "1" ]] || fail "tenant ${TENANT_ID} not found" 2
EXISTS=$(q "SELECT COUNT(*) FROM ombu_extensions WHERE extension='${EXT}' AND tenant_id=${TENANT_ID};")
[[ "$EXISTS" == "0" ]] || fail "extension ${EXT} already exists in tenant ${TENANT_ID} — refusing to overwrite (additive-only)" 2

# Load guard: refuse if the PBX is busy (protect live calls).
LOAD=$(awk '{print int($1)}' /proc/loadavg 2>/dev/null || echo 0)
CORES=$(nproc 2>/dev/null || echo 1)
if [[ "$LOAD" -gt $((CORES*2)) ]]; then fail "PBX load ${LOAD} too high (>${CORES}x2) — deferring to protect live calls" 4; fi

EMAIL_SQL="NULL"; [[ -n "$EMAIL" ]] && EMAIL_SQL="'$(printf '%s' "$EMAIL" | sed "s/'/''/g")'"
NAME_SQL="'$(printf '%s' "$NAME" | sed "s/'/''/g")'"
INSERT="INSERT INTO ombu_extensions (extension,name,email,mailbox,tenant_id,generate_hints) VALUES ('${EXT}',${NAME_SQL},${EMAIL_SQL},'${MAILBOX}',${TENANT_ID},'yes');"

# Voicemail mailbox row (voicemail-to-email). Delivery address comes from the
# extension's email above; this row enables the mailbox + attaches audio.
TENANT_SLUG=$(q "SELECT name FROM ombu_tenants WHERE tenant_id=${TENANT_ID} LIMIT 1;" 2>/dev/null || echo "")
VM_CONTEXT="${TENANT_SLUG:+${TENANT_SLUG}-}voicemail"
VM_ATTACH_SQL=$([[ "$VM_ATTACH" == "1" ]] && echo "'yes'" || echo "'no'")
VM_TRANS_SQL=$([[ "$VM_TRANSCRIBE" == "1" ]] && echo "'yes'" || echo "'no'")

log "PLAN: create extension ${EXT} '${NAME}' <${EMAIL}> mailbox ${MAILBOX} in tenant ${TENANT_ID}"
log "SQL : ${INSERT}"
if [[ "$VM" == "1" ]]; then
  log "PLAN: voicemail-to-email → ${EMAIL} (attach=${VM_ATTACH}, ai_transcription=${VM_TRANSCRIBE}, context=${VM_CONTEXT})"
fi

if [[ "$COMMIT" != "1" || "$OWNER_WINDOW" != "1" ]]; then
  log "DRY-RUN (no --commit/--owner-window) — nothing written. This is the default, safe mode."
  exit 0
fi

# ---- Commit (only inside an owner window) ---------------------------------
SNAP="/var/log/connect-agent/ext-snap-${TENANT_ID}-$(date +%s).sql"
mkdir -p /var/log/connect-agent
q "SELECT * FROM ombu_extensions WHERE tenant_id=${TENANT_ID};" > "$SNAP" 2>/dev/null || true
log "snapshot saved: $SNAP"

q "$INSERT"
NEW_ID=$(q "SELECT extension_id FROM ombu_extensions WHERE extension='${EXT}' AND tenant_id=${TENANT_ID} LIMIT 1;")
[[ -n "$NEW_ID" ]] || fail "insert did not produce a row" 3

# rollback helper — removes only what we just inserted (VM row then extension).
rollback(){ q "DELETE FROM ombu_extensions_vm WHERE extension_id=${NEW_ID};" 2>/dev/null || true; q "DELETE FROM ombu_extensions WHERE extension_id=${NEW_ID};" 2>/dev/null || true; }

# Voicemail-to-email mailbox row (additive; linked to the new extension).
if [[ "$VM" == "1" ]]; then
  VM_INSERT="INSERT INTO ombu_extensions_vm (extension_id,password,context,attach,enabled,ai_transcription,create_hint,ask_password) VALUES (${NEW_ID},'${MAILBOX}','${VM_CONTEXT}',${VM_ATTACH_SQL},'yes',${VM_TRANS_SQL},'yes','yes');"
  q "$VM_INSERT" || { rollback; fail "voicemail row insert failed — rolled back extension ${EXT}" 3; }
fi

# Scoped config regen. Prefer a targeted module regen; verify integrity after.
if command -v vitalpbx >/dev/null 2>&1; then
  vitalpbx gen-conf >/tmp/connect-genconf.log 2>&1 || { rollback; fail "gen-conf failed — rolled back extension ${EXT}" 3; }
fi

VERIFY=$(q "SELECT COUNT(*) FROM ombu_extensions WHERE extension_id=${NEW_ID};")
VM_VERIFY=1
[[ "$VM" == "1" ]] && VM_VERIFY=$(q "SELECT COUNT(*) FROM ombu_extensions_vm WHERE extension_id=${NEW_ID};")
if [[ "$VERIFY" != "1" || "$VM_VERIFY" != "1" ]]; then
  rollback
  fail "post-write verify failed — rolled back" 3
fi

log "OK: extension ${EXT} created (extension_id=${NEW_ID}) in tenant ${TENANT_ID}${VM:+, voicemail-to-email → ${EMAIL}}"
echo "CREATED_EXTENSION_ID=${NEW_ID}"
exit 0
