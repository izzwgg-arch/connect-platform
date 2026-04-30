#!/usr/bin/env bash
# Idempotent patch for /etc/asterisk/extensions__60_custom.conf that adds a
# runtime file-presence probe before each Background(${PROMPT_VAR}) call in
# [connect-tenant-ivr]. If Connect's publish validation ever lets a missing
# recording through (or an admin deletes a file from VitalPBX between publish
# and call), the caller falls through to the default prompt instead of
# hearing silence.
#
# Safe to run multiple times — the patcher detects the sentinel NoOp and skips
# regions it has already modified. Always creates a timestamped backup first.
#
# Usage on the VitalPBX host (as root):
#   bash patch-dialplan-file-presence.sh
#
# Or paste this whole file into an SSH session via `cat > /tmp/p.sh << 'EOF' … EOF`
# and run `bash /tmp/p.sh`.
set -euo pipefail

CONF=/etc/asterisk/extensions__60_custom.conf
TS="$(date +%Y%m%d-%H%M%S)"
BAK="${CONF}.bak-${TS}"

if [[ ! -f "${CONF}" ]]; then
  echo "ERROR: ${CONF} not found — is this the VitalPBX host?"
  exit 1
fi

cp -p "${CONF}" "${BAK}"
echo "Backed up existing dialplan to ${BAK}"

python3 - <<'PY' "${CONF}"
import io, os, re, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

# Sentinel — if this NoOp already exists we know the patch is applied.
SENTINEL = 'Connect IVR greeting attempt tenant='

if SENTINEL in src:
    print('Patch already applied — no changes made.')
    sys.exit(0)

# Patch 1: main greeting block
# Replace the two-line "GotoIf empty → Background → Goto waitdigit" with the
# probed version.
old1 = (
    ' same =>      n,GotoIf($["${GREETING}" = ""]?default_greet)\n'
    ' same =>      n,Background(${GREETING})\n'
    ' same =>      n,Goto(waitdigit)\n'
)
new1 = (
    ' same =>      n,GotoIf($["${GREETING}" = ""]?default_greet)\n'
    ' ; Defense-in-depth for Connect publish/recording drift — fall back to\n'
    ' ; the default prompt if the file isn\'t on disk, never play silence.\n'
    ' same =>      n,NoOp(Connect IVR greeting attempt tenant=${TENANT_SLUG} ref=${GREETING})\n'
    ' same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${GREETING}.ulaw)}" = "1"]?play_greet)\n'
    ' same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${GREETING}.wav)}" = "1"]?play_greet)\n'
    ' same =>      n,NoOp(Connect IVR greeting file missing ref=${GREETING} — falling back to default)\n'
    ' same =>      n,Goto(default_greet)\n'
    ' same =>      n(play_greet),Background(${GREETING})\n'
    ' same =>      n,Goto(waitdigit)\n'
)
if old1 not in src:
    print('ERROR: greeting block anchor not found — is this the Connect Option A dialplan?')
    sys.exit(2)
src = src.replace(old1, new1, 1)

# Patch 2: timeout prompt block
old2 = (
    ' same =>      n,GotoIf($["${TIMEOUT_PROMPT}" = ""]?prompt)\n'
    ' same =>      n,Background(${TIMEOUT_PROMPT})\n'
    ' same =>      n,Goto(waitdigit)\n'
)
new2 = (
    ' same =>      n,GotoIf($["${TIMEOUT_PROMPT}" = ""]?prompt)\n'
    ' same =>      n,NoOp(Connect IVR timeout prompt tenant=${TENANT_SLUG} ref=${TIMEOUT_PROMPT})\n'
    ' same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${TIMEOUT_PROMPT}.ulaw)}" = "1"]?play_timeout)\n'
    ' same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${TIMEOUT_PROMPT}.wav)}" = "1"]?play_timeout)\n'
    ' same =>      n,NoOp(Connect IVR timeout prompt missing ref=${TIMEOUT_PROMPT} — reprompting)\n'
    ' same =>      n,Goto(prompt)\n'
    ' same =>      n(play_timeout),Background(${TIMEOUT_PROMPT})\n'
    ' same =>      n,Goto(waitdigit)\n'
)
if old2 not in src:
    print('ERROR: timeout block anchor not found.')
    sys.exit(3)
src = src.replace(old2, new2, 1)

# Patch 3: invalid prompt block (indentation uses 3 spaces after "same =>")
old3 = (
    ' same =>   n,GotoIf($["${INVALID_PROMPT}" = ""]?reprompt)\n'
    ' same =>   n,Background(${INVALID_PROMPT})\n'
    ' same =>   n(reprompt),Goto(connect-tenant-ivr,${EXTEN},prompt)\n'
)
new3 = (
    ' same =>   n,GotoIf($["${INVALID_PROMPT}" = ""]?reprompt)\n'
    ' same =>   n,NoOp(Connect IVR invalid prompt tenant=${TENANT_SLUG} ref=${INVALID_PROMPT})\n'
    ' same =>   n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${INVALID_PROMPT}.ulaw)}" = "1"]?play_invalid)\n'
    ' same =>   n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${INVALID_PROMPT}.wav)}" = "1"]?play_invalid)\n'
    ' same =>   n,NoOp(Connect IVR invalid prompt missing ref=${INVALID_PROMPT} — reprompting)\n'
    ' same =>   n,Goto(reprompt)\n'
    ' same =>   n(play_invalid),Background(${INVALID_PROMPT})\n'
    ' same =>   n(reprompt),Goto(connect-tenant-ivr,${EXTEN},prompt)\n'
)
if old3 not in src:
    print('ERROR: invalid block anchor not found.')
    sys.exit(4)
src = src.replace(old3, new3, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(src)
print('Patched all three prompt playback sites.')
PY

echo ""
echo "Reloading Asterisk dialplan…"
asterisk -rx "dialplan reload" | tail -n 5

echo ""
echo "Verifying the patched context parsed:"
asterisk -rx "dialplan show _X!@connect-tenant-ivr" | grep -E "greeting attempt|STAT|play_greet" | head -n 10 || true

echo ""
echo "Done. Backup: ${BAK}"
echo "If anything goes wrong: cp ${BAK} ${CONF} && asterisk -rx 'dialplan reload'"
