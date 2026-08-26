#!/usr/bin/env bash
# Install/refresh the [connect-voice-agent] dialplan context on the PBX.
#
# Idempotent: removes any prior [connect-voice-agent] block, appends the
# current one, verifies the file still parses, and reloads. Backs up first.
# Sets the global AstDB host/port keys. Does NOT enable any tenant — enabling
# a tenant (connect/va/<slug>/enabled + fallback_dest, and pointing the DID
# here) is a separate, per-tenant, deliberate step.
#
# ⛔ Run ONLY on the PBX. Reads the context from the repo copy shipped beside
# this script so the live dialplan and git never drift.
set -euo pipefail

CONF=/etc/asterisk/extensions__60_custom.conf
BLOCK_SRC="$(dirname "$0")/connect-voice-agent.conf"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
VA_HOST="${VA_HOST:-45.14.194.179}"
VA_PORT="${VA_PORT:-4590}"

[ -f "$CONF" ] || { echo "FATAL: $CONF not found — run on the PBX"; exit 1; }
[ -f "$BLOCK_SRC" ] || { echo "FATAL: $BLOCK_SRC not found"; exit 1; }

cp -a "$CONF" "${CONF}.bak.voiceagent.${STAMP}"
echo "backup: ${CONF}.bak.voiceagent.${STAMP}"

# Strip any existing [connect-voice-agent] block (from '[connect-voice-agent]'
# up to the next '[' section header or EOF).
awk '
  /^\[connect-voice-agent\]/ { skip=1; next }
  skip==1 && /^\[/ { skip=0 }
  skip==1 { next }
  { print }
' "$CONF" > "${CONF}.tmp.${STAMP}"

# Append the current block.
printf "\n" >> "${CONF}.tmp.${STAMP}"
cat "$BLOCK_SRC" >> "${CONF}.tmp.${STAMP}"

mv "${CONF}.tmp.${STAMP}" "$CONF"

# Verify the dialplan parses BEFORE reloading. A parse error leaves the OLD
# dialplan live (Asterisk keeps it), so reload only after a clean parse.
if ! asterisk -rx "dialplan reload" >/dev/null 2>&1; then
  echo "FATAL: dialplan reload failed — restoring backup"
  cp -a "${CONF}.bak.voiceagent.${STAMP}" "$CONF"
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  exit 1
fi

# Prove the context loaded.
if ! asterisk -rx "dialplan show connect-voice-agent" 2>/dev/null | grep -q "connect-voice-agent"; then
  echo "FATAL: [connect-voice-agent] did not load — restoring backup"
  cp -a "${CONF}.bak.voiceagent.${STAMP}" "$CONF"
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  exit 1
fi

# Global AstDB keys (host/port). Per-tenant enablement is separate.
asterisk -rx "database put connect/va host ${VA_HOST}" >/dev/null
asterisk -rx "database put connect/va port ${VA_PORT}" >/dev/null

echo "OK: [connect-voice-agent] installed; host=${VA_HOST} port=${VA_PORT}"
asterisk -rx "dialplan show connect-voice-agent" 2>/dev/null | head -5
