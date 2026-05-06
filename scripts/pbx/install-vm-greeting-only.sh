#!/usr/bin/env bash
# Connect — Voicemail greeting "Call to Record" only (VitalPBX / Asterisk).
#
# Production-safe, idempotent, re-runnable. Does NOT restart Asterisk (only
# dialplan reload when the drop-in file changes). Restarts connect-pbx-helper
# when the Python helper file changes so HTTP /voicemail/greeting/* matches.
#
# Prerequisite: full helper once installed (venv + systemd + /etc/connect-pbx-helper.env).
#   curl -fsSL …/install-vitalpbx-inbound-route-helper.sh | bash
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/izzwgg-arch/connect-platform/main/scripts/pbx/install-vm-greeting-only.sh | bash
#
# Override upstream installer URL:
#   CONNECT_PBX_INSTALLER_URL=https://raw.githubusercontent.com/OWNER/REPO/REF/scripts/pbx/install-vitalpbx-inbound-route-helper.sh

set -euo pipefail

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "ERROR: run as root on the PBX host." >&2
  exit 1
fi

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing command: $1" >&2; exit 1; }; }
need_cmd curl
need_cmd python3
need_cmd systemctl
command -v asterisk >/dev/null 2>&1 || { echo "ERROR: asterisk CLI not found" >&2; exit 1; }

INSTALLER_URL="${CONNECT_PBX_INSTALLER_URL:-https://raw.githubusercontent.com/izzwgg-arch/connect-platform/main/scripts/pbx/install-vitalpbx-inbound-route-helper.sh}"
DIALPLAN_TARGET="/etc/asterisk/vitalpbx/extensions__95-connect-vm-greeting.conf"
HELPER_PY="/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py"
VENV_PY="/opt/connect-pbx-helper/.venv/bin/python"
SOUNDS_DIR="/var/lib/asterisk/sounds/custom"
VM_SPOOL="/var/spool/asterisk/voicemail"
BACKUP_ROOT="/root/connect-vm-greeting-backup-$(date +%Y%m%d-%H%M%S)"
PY_CHANGED=0
DP_CHANGED=0
TMP_INSTALLER="$(mktemp)"
TMP_PY="$(mktemp)"
TMP_DP="$(mktemp)"
cleanup_tmp() { rm -f "$TMP_INSTALLER" "$TMP_PY" "$TMP_DP"; }
trap cleanup_tmp EXIT

mkdir -p "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
echo "==> Backup directory: $BACKUP_ROOT"

if [[ ! -x "$VENV_PY" ]]; then
  echo "ERROR: $VENV_PY missing. Install the full Connect PBX helper first:" >&2
  echo "  curl -fsSL \"$INSTALLER_URL\" | bash" >&2
  exit 2
fi

if ! systemctl list-unit-files connect-pbx-helper.service >/dev/null 2>&1; then
  echo "WARN: connect-pbx-helper.service not found — helper HTTP will not run until full install." >&2
fi

curl -fsSL "$INSTALLER_URL" -o "$TMP_INSTALLER"
echo "==> Fetched installer: $INSTALLER_URL"

if [[ -f "$HELPER_PY" ]]; then
  cp -a "$HELPER_PY" "$BACKUP_ROOT/vitalpbx-inbound-route-helper.py.bak" || true
fi
if [[ -f "$DIALPLAN_TARGET" ]]; then
  cp -a "$DIALPLAN_TARGET" "$BACKUP_ROOT/extensions__95-connect-vm-greeting.conf.bak" || true
fi

# Extract embedded helper + dialplan from the canonical installer (no fragile line numbers).
python3 - "$TMP_INSTALLER" "$TMP_PY" "$TMP_DP" <<'PY'
import re
import sys
from pathlib import Path

installer_path, out_py, out_dp = sys.argv[1:4]
text = Path(installer_path).read_text(encoding="utf-8", errors="ignore")

m_py = re.search(
    r'^cat >/opt/connect-pbx-helper/vitalpbx-inbound-route-helper\.py <<\'PYHELPER\'\n(.*?)^PYHELPER\n',
    text,
    re.M | re.S,
)
if not m_py:
    sys.stderr.write("ERROR: could not extract Python helper from installer (marker PYHELPER).\n")
    sys.exit(1)

m_dp = re.search(
    r'^cat >"\$\{DIALPLAN_TARGET\}" <<\'EOF\'\n(.*?)^EOF\n',
    text,
    re.M | re.S,
)
if not m_dp:
    sys.stderr.write("ERROR: could not extract VM greeting dialplan from installer (marker EOF).\n")
    sys.exit(1)

Path(out_py).write_text(m_py.group(1), encoding="utf-8")
Path(out_dp).write_text(m_dp.group(1), encoding="utf-8")
PY
echo "==> Extracted helper + dialplan from upstream installer"

if [[ -f "$BACKUP_ROOT/vitalpbx-inbound-route-helper.py.bak" ]]; then
  cmp -s "$BACKUP_ROOT/vitalpbx-inbound-route-helper.py.bak" "$TMP_PY" || PY_CHANGED=1
else
  PY_CHANGED=1
fi

if [[ -f "$BACKUP_ROOT/extensions__95-connect-vm-greeting.conf.bak" ]]; then
  cmp -s "$BACKUP_ROOT/extensions__95-connect-vm-greeting.conf.bak" "$TMP_DP" || DP_CHANGED=1
else
  DP_CHANGED=1
fi

install -d -m 0755 /opt/connect-pbx-helper
mv -f "$TMP_PY" "$HELPER_PY"
mv -f "$TMP_DP" "$DIALPLAN_TARGET"

install -d -o asterisk -g asterisk -m 0755 /etc/asterisk/vitalpbx 2>/dev/null || install -d -m 0755 /etc/asterisk/vitalpbx
install -d -o asterisk -g asterisk -m 0775 "$SOUNDS_DIR" 2>/dev/null || install -d -m 0775 "$SOUNDS_DIR"
install -d -o asterisk -g asterisk -m 0775 "$VM_SPOOL" 2>/dev/null || install -d -m 0775 "$VM_SPOOL"

# Remove legacy duplicate drop-ins (same as full installer).
for f in \
  /etc/asterisk/vitalpbx/extensions_95-connect-vm-greeting.conf \
  /etc/asterisk/extensions__95_connect_vm_greeting.conf \
  /etc/asterisk/extensions_95_connect_vm_greeting.conf; do
  [[ -f "$f" ]] && cp -a "$f" "$BACKUP_ROOT/$(basename "$f").removed" && rm -f "$f"
done

# Strip legacy inline blocks from custom includes (idempotent).
for f in /etc/asterisk/extensions_custom.conf /etc/asterisk/extensions__88_custom.conf /etc/asterisk/extensions__60_custom.conf; do
  [[ -f "$f" ]] || continue
  cp -a "$f" "$BACKUP_ROOT/$(basename "$f").bak" || true
  python3 - "$f" <<'PY'
import re, sys
p = sys.argv[1]
try:
    body = open(p, "r", encoding="utf-8", errors="ignore").read()
except OSError:
    sys.exit(0)
pat = re.compile(
    r"(?ms)^[ \t]*; >>> CONNECT_VM_GREETING_BLOCK_BEGIN.*?; <<< CONNECT_VM_GREETING_BLOCK_END <<<\s*\n?"
)
new_body = pat.sub("", body)
new_body = re.sub(
    r"(?m)^\s*#tryinclude\s+/etc/asterisk/vitalpbx/extensions_(?:_)?95[-_]connect[-_]vm[-_]greeting\.conf\s*\n?",
    "",
    new_body,
)
new_body = re.sub(r"\n{3,}", "\n\n", new_body)
if new_body != body:
    open(p, "w", encoding="utf-8").write(new_body)
PY
done

chmod 0755 "$HELPER_PY"
chown asterisk:asterisk "$HELPER_PY" 2>/dev/null || chown root:root "$HELPER_PY"

chown asterisk:asterisk "$DIALPLAN_TARGET" 2>/dev/null || true
chmod 0644 "$DIALPLAN_TARGET"
echo "==> Installed dialplan: $DIALPLAN_TARGET"

# Placeholder prompts (8 kHz mono s16le WAV) — replace with branded audio later.
python3 - "$SOUNDS_DIR" <<'PY'
import os, struct, wave, sys

out_dir = sys.argv[1]
os.makedirs(out_dir, mode=0o775, exist_ok=True)

def write_silence(path: str, seconds: float = 1.0) -> None:
    n = int(8000 * seconds)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        frames = b"\x00\x00" * n
        w.writeframes(frames)

names = [
    "connect-vm-record-greeting.wav",
    "connect-vm-review.wav",
    "connect-vm-invalid-choice.wav",
    "connect-vm-saved.wav",
    "connect-vm-save-redo.wav",
]
# Read() may use digit suffixes on some builds — add minimal prompts.
for d in ("1", "2", "3"):
    names.append(f"connect-vm-save-redo-{d}.wav")

for name in names:
    p = os.path.join(out_dir, name)
    if os.path.exists(p) and os.path.getsize(p) > 256:
        continue
    write_silence(p, 0.8)

print("==> Ensured prompt WAVs under", out_dir)
PY
chown -R asterisk:asterisk "$SOUNDS_DIR" 2>/dev/null || true

if id asterisk >/dev/null 2>&1; then
  chown -R asterisk:asterisk "$VM_SPOOL" 2>/dev/null || true
  find "$VM_SPOOL" -type d -exec chmod 0750 {} + 2>/dev/null || true
  find "$VM_SPOOL" -type f -exec chmod 0644 {} + 2>/dev/null || true
fi

if [[ "$DP_CHANGED" -eq 1 ]]; then
  echo "==> Dialplan file changed — asterisk -rx \"dialplan reload\""
  asterisk -rx "dialplan reload" || { echo "ERROR: dialplan reload failed" >&2; exit 3; }
else
  echo "==> Dialplan unchanged — skipping dialplan reload"
fi

if [[ "$PY_CHANGED" -eq 1 ]] || [[ "${CONNECT_VM_GREETING_RESTART_HELPER_FORCE:-0}" == "1" ]]; then
  if systemctl is-enabled connect-pbx-helper >/dev/null 2>&1; then
    echo "==> systemctl restart connect-pbx-helper (not Asterisk)"
    systemctl restart connect-pbx-helper
    sleep 1
    systemctl --no-pager -l status connect-pbx-helper || true
  else
    echo "WARN: connect-pbx-helper not enabled — start it after full install." >&2
  fi
else
  echo "==> Helper Python unchanged — skipping helper restart (set CONNECT_VM_GREETING_RESTART_HELPER_FORCE=1 to force)"
fi

echo
echo "========== VALIDATION =========="
echo "--- dialplan show connect-vm-greeting-record (first 40 lines) ---"
asterisk -rx "dialplan show connect-vm-greeting-record" 2>&1 | sed -n '1,40p' || true
echo
echo "--- dialplan show connect-vm-greeting-dispatch (first 40 lines) ---"
asterisk -rx "dialplan show connect-vm-greeting-dispatch" 2>&1 | sed -n '1,40p' || true
echo
echo "--- voicemail show users (first 30 lines) ---"
asterisk -rx "voicemail show users" 2>&1 | sed -n '1,30p' || true
echo
echo "--- prompt files (connect-vm-*) ---"
ls -la "$SOUNDS_DIR"/connect-vm-*.wav 2>/dev/null || echo "(none — check permissions)"
echo
echo "--- voicemail spool sample (depth 2) ---"
find "$VM_SPOOL" -maxdepth 2 -type d 2>/dev/null | sed -n '1,25p' || true
echo
echo "--- helper health ---"
if [[ -f /etc/connect-pbx-helper.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck disable=SC1091
  source /etc/connect-pbx-helper.env || true
  set +a
  HB="${CONNECT_PBX_HELPER_BIND:-127.0.0.1}"
  HP="${CONNECT_PBX_HELPER_PORT:-8757}"
  curl -sS --max-time 3 "http://${HB}:${HP}/health" && echo || echo "(health curl failed — check bind/port/firewall)"
else
  echo "(no /etc/connect-pbx-helper.env — full install not done?)"
fi

echo
echo "========== ROLLBACK =========="
echo "To restore previous files:"
echo "  cp -a \"$BACKUP_ROOT/vitalpbx-inbound-route-helper.py.bak\" $HELPER_PY   # if backup exists"
echo "  cp -a \"$BACKUP_ROOT/extensions__95-connect-vm-greeting.conf.bak\" $DIALPLAN_TARGET   # if backup exists"
echo "  asterisk -rx \"dialplan reload\""
echo "  systemctl restart connect-pbx-helper"
echo
echo "DONE. Asterisk was NOT restarted; only dialplan reload (if changed) + helper restart."
