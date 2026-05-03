#!/usr/bin/env bash
#
# install-prompt-sync.sh — one-shot installer that wires the PBX side of
# Connect's IVR-prompt sync (Connect → PBX direction).
#
# Run on the VitalPBX host (209.145.60.79) as root:
#
#   curl -sSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/pbx/install-prompt-sync.sh | bash
#
# …or, simpler, scp this file up and:
#
#   sudo bash install-prompt-sync.sh
#
# What it does (idempotent — safe to re-run):
#
#   1. Re-runs the route-helper installer so the helper service:
#        • picks up VERSION 2026.05.03
#        • exposes the new /upload-prompt action
#        • runs with SupplementaryGroups=asterisk + ReadWritePaths
#          covering /var/lib/asterisk/sounds/custom
#      The installer is fully idempotent; secrets are preserved
#      (the installer ROTATES the helper secret on every run, so if you
#      already wired PBX_ROUTE_HELPER_SECRET into Connect, supply
#      PRESERVE_HELPER_SECRET=1 and copy the value out of the existing
#      /etc/connect-pbx-helper.env BEFORE running this script).
#
#   2. Adds the helper user to the 'asterisk' group so it can write into
#      /var/lib/asterisk/sounds/custom.
#
#   3. Drops the bidirectional connect-prompt-sync.sh into
#      /usr/local/bin and adds a 10-minute root cron entry. This is the
#      catch-up channel that backstops the API's instant push at upload
#      time — if the immediate push ever fails, this loop pulls the
#      bytes within 10 minutes.
#
#   4. Smoke-tests:
#        • helper /health
#        • helper /upload-prompt with a tiny generated WAV
#        • cron entry installed
#
# Required environment variables (set before running, OR be prompted):
#   CONNECT_URL                — public Connect API base, e.g.
#                                 https://app.connectcomunications.com/api
#   PROMPT_SYNC_SHARED_SECRET  — shared secret for the cron's manifest call.
#                                 If you already use connect-media-sync,
#                                 reuse that value (it's the same secret
#                                 family).
#
# Optional:
#   CONNECT_DESTINATION_ID     — defaults to 607 (Connect IVR custom
#                                 destination on this PBX).
#   PRESERVE_HELPER_SECRET=1   — keep the existing CONNECT_PBX_HELPER_SECRET
#                                 (re-installer would otherwise mint a new
#                                 one and you'd have to update Connect env).
#

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root on the PBX host" >&2
  exit 1
fi

# ── Inputs ───────────────────────────────────────────────────────────────────
CONNECT_URL="${CONNECT_URL:-}"
PROMPT_SYNC_SHARED_SECRET="${PROMPT_SYNC_SHARED_SECRET:-}"
CONNECT_DESTINATION_ID="${CONNECT_DESTINATION_ID:-607}"
PRESERVE_HELPER_SECRET="${PRESERVE_HELPER_SECRET:-1}"

if [[ -z "$CONNECT_URL" ]]; then
  read -rp "Connect API base URL [https://app.connectcomunications.com/api]: " CONNECT_URL
  CONNECT_URL="${CONNECT_URL:-https://app.connectcomunications.com/api}"
fi
if [[ -z "$PROMPT_SYNC_SHARED_SECRET" ]]; then
  read -rsp "PROMPT_SYNC_SHARED_SECRET (same value Connect API uses): " PROMPT_SYNC_SHARED_SECRET
  echo
fi

if [[ -z "$PROMPT_SYNC_SHARED_SECRET" ]]; then
  echo "ERROR: PROMPT_SYNC_SHARED_SECRET is required" >&2
  exit 1
fi

# ── Sanity: required tools ───────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing dep: $1" >&2; exit 1; }; }
for c in curl jq awk install systemctl; do need "$c"; done

# ── Step 1: capture existing helper secret if requested ──────────────────────
EXISTING_HELPER_SECRET=""
EXISTING_MYSQL_PASS=""
EXISTING_HELPER_BIND="127.0.0.1"
EXISTING_HELPER_PORT="8757"
if [[ -f /etc/connect-pbx-helper.env ]]; then
  if [[ "$PRESERVE_HELPER_SECRET" == "1" ]]; then
    EXISTING_HELPER_SECRET="$(awk -F= '/^CONNECT_PBX_HELPER_SECRET=/{print $2; exit}' /etc/connect-pbx-helper.env || true)"
    EXISTING_MYSQL_PASS="$(awk -F= '/^OMBU_MYSQL_PASSWORD=/{print $2; exit}' /etc/connect-pbx-helper.env || true)"
  fi
  EXISTING_HELPER_BIND="$(awk -F= '/^CONNECT_PBX_HELPER_BIND=/{print $2; exit}' /etc/connect-pbx-helper.env || echo "127.0.0.1")"
  EXISTING_HELPER_PORT="$(awk -F= '/^CONNECT_PBX_HELPER_PORT=/{print $2; exit}' /etc/connect-pbx-helper.env || echo "8757")"
fi

# ── Step 2: re-run the route-helper installer ────────────────────────────────
INSTALLER_URL="${INSTALLER_URL:-}"
INSTALLER_LOCAL="${INSTALLER_LOCAL:-/tmp/install-vitalpbx-inbound-route-helper.sh}"

if [[ ! -f "$INSTALLER_LOCAL" ]]; then
  if [[ -n "$INSTALLER_URL" ]]; then
    echo "Downloading helper installer from $INSTALLER_URL"
    curl -fsSL "$INSTALLER_URL" -o "$INSTALLER_LOCAL"
  elif [[ -f /opt/connect-pbx-helper-src/install-vitalpbx-inbound-route-helper.sh ]]; then
    cp /opt/connect-pbx-helper-src/install-vitalpbx-inbound-route-helper.sh "$INSTALLER_LOCAL"
  else
    cat <<EOF >&2
ERROR: cannot find install-vitalpbx-inbound-route-helper.sh.

Either:
  • scp it onto this host first, e.g.
      scp scripts/pbx/install-vitalpbx-inbound-route-helper.sh root@<this-host>:/tmp/
  • or set INSTALLER_URL=<https url> before re-running this script.
EOF
    exit 1
  fi
fi

CONNECT_DESTINATION_ID="$CONNECT_DESTINATION_ID" \
CONNECT_PBX_HELPER_BIND="$EXISTING_HELPER_BIND" \
CONNECT_PBX_HELPER_PORT="$EXISTING_HELPER_PORT" \
  bash "$INSTALLER_LOCAL"

# ── Step 3: restore preserved secrets (if any) so Connect doesn't lose auth ──
if [[ -n "$EXISTING_HELPER_SECRET" ]]; then
  echo "Restoring preserved CONNECT_PBX_HELPER_SECRET"
  sed -i "s|^CONNECT_PBX_HELPER_SECRET=.*|CONNECT_PBX_HELPER_SECRET=${EXISTING_HELPER_SECRET}|" /etc/connect-pbx-helper.env
fi
if [[ -n "$EXISTING_MYSQL_PASS" ]]; then
  echo "Restoring preserved OMBU_MYSQL_PASSWORD"
  sed -i "s|^OMBU_MYSQL_PASSWORD=.*|OMBU_MYSQL_PASSWORD=${EXISTING_MYSQL_PASS}|" /etc/connect-pbx-helper.env
  # Also re-grant the MySQL password back to the connect_route_helper user.
  mysql -e "ALTER USER 'connect_route_helper'@'127.0.0.1' IDENTIFIED BY '${EXISTING_MYSQL_PASS}'; FLUSH PRIVILEGES;" || \
    echo "WARN: could not reset MySQL password; you may need to run mysql_secure_installation cycle." >&2
fi

# Always make sure the asterisk group membership and sounds dir perms hold.
if getent group asterisk >/dev/null 2>&1; then
  if ! id -nG connect-route-helper 2>/dev/null | tr ' ' '\n' | grep -qx asterisk; then
    usermod -a -G asterisk connect-route-helper
    echo "Added connect-route-helper to the asterisk group"
  fi
fi
install -d -o asterisk -g asterisk -m 0775 /var/lib/asterisk/sounds/custom 2>/dev/null || \
  install -d -m 0775 /var/lib/asterisk/sounds/custom

# Restart so the systemd unit picks up new SupplementaryGroups + ReadWritePaths.
systemctl daemon-reload
systemctl restart connect-pbx-helper
sleep 1

# ── Step 4: install bidirectional connect-prompt-sync cron ───────────────────
SYNC_SCRIPT_LOCAL="${SYNC_SCRIPT_LOCAL:-/tmp/connect-prompt-sync.sh}"
if [[ ! -f "$SYNC_SCRIPT_LOCAL" ]]; then
  cat <<EOF >&2
ERROR: cannot find connect-prompt-sync.sh.
scp it onto this host first:
  scp docs/pbx/connect-prompt-sync.sh root@<this-host>:/tmp/
EOF
  exit 1
fi

install -d -m 0700 /etc/connect
echo -n "$PROMPT_SYNC_SHARED_SECRET" > /etc/connect/connect_media_secret
chmod 0600 /etc/connect/connect_media_secret

install -m 0755 "$SYNC_SCRIPT_LOCAL" /usr/local/bin/connect-prompt-sync

cat >/etc/default/connect-prompt-sync <<EOF
CONNECT_URL=${CONNECT_URL%/}
SOUNDS_DIR=/var/lib/asterisk/sounds/custom
STATE_DIR=/var/lib/connect-prompt-sync
SECRET_FILE=/etc/connect/connect_media_secret
LOG_FILE=/var/log/connect-prompt-sync.log
CURL_TIMEOUT=30
EOF
chmod 0644 /etc/default/connect-prompt-sync

install -d -m 0755 /var/lib/connect-prompt-sync
touch /var/log/connect-prompt-sync.log
chmod 0644 /var/log/connect-prompt-sync.log

cat >/etc/cron.d/connect-prompt-sync <<'EOF'
# Bidirectional Connect ↔ VitalPBX IVR prompt sync. Runs every 10 minutes.
# Push leg: PBX system recordings → Connect catalog (for portal preview)
# Pull leg: Connect-uploaded greetings → /var/lib/asterisk/sounds/custom
*/10 * * * * root . /etc/default/connect-prompt-sync && /usr/local/bin/connect-prompt-sync >>/var/log/connect-prompt-sync.log 2>&1
EOF
chmod 0644 /etc/cron.d/connect-prompt-sync
systemctl reload cron 2>/dev/null || systemctl restart cron 2>/dev/null || service cron reload 2>/dev/null || true

# ── Step 5: smoke tests ──────────────────────────────────────────────────────
echo
echo "──────────── smoke tests ────────────"

HELPER_SECRET="$(awk -F= '/^CONNECT_PBX_HELPER_SECRET=/{print $2; exit}' /etc/connect-pbx-helper.env)"
HELPER_PORT="$(awk -F= '/^CONNECT_PBX_HELPER_PORT=/{print $2; exit}' /etc/connect-pbx-helper.env)"
HELPER_BIND="$(awk -F= '/^CONNECT_PBX_HELPER_BIND=/{print $2; exit}' /etc/connect-pbx-helper.env)"

echo "[1/4] helper /health:"
curl -sS "http://${HELPER_BIND}:${HELPER_PORT}/health"
echo

echo "[2/4] helper version expected 2026.05.03:"
ver=$(curl -sS "http://${HELPER_BIND}:${HELPER_PORT}/health" | jq -r '.version // empty')
if [[ "$ver" != "2026.05.03" ]]; then
  echo "WARN: helper version is '$ver', expected 2026.05.03 (re-run the installer with the latest scripts/pbx/install-vitalpbx-inbound-route-helper.sh)"
else
  echo "OK ($ver)"
fi

echo "[3/4] helper /upload-prompt round-trip with a 1-second silent WAV:"
TMPWAV="$(mktemp --suffix=.wav)"
# Generate a 1-second 8 kHz mono PCM silent WAV without ffmpeg dep.
python3 - "$TMPWAV" <<'PYWAV'
import sys, struct, wave
path = sys.argv[1]
with wave.open(path, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(b"\x00\x00" * 8000)
print("wrote", path)
PYWAV
SHA=$(sha256sum "$TMPWAV" | awk '{print $1}')
SIZE=$(stat -c%s "$TMPWAV")
B64=$(base64 -w0 "$TMPWAV")
TEST_BASE="connect_prompt_sync_smoketest"
RESP=$(curl -sS -o /tmp/upload-resp.json -w '%{http_code}' \
  -X POST "http://${HELPER_BIND}:${HELPER_PORT}/upload-prompt" \
  -H 'content-type: application/json' \
  -H "x-connect-pbx-helper-secret: ${HELPER_SECRET}" \
  --data "{\"fileBaseName\":\"${TEST_BASE}\",\"sha256\":\"${SHA}\",\"sizeBytes\":${SIZE},\"bytesB64\":\"${B64}\",\"requestedBy\":\"installer:smoketest\"}" )
echo "HTTP $RESP — body:"
cat /tmp/upload-resp.json
echo
ls -la "/var/lib/asterisk/sounds/custom/${TEST_BASE}.wav" || true
rm -f "$TMPWAV" /tmp/upload-resp.json
# Leave the test file on disk so you can re-trigger /upload-prompt to see
# the "unchanged: true" idempotent path; remove it manually when done:
#   rm -f /var/lib/asterisk/sounds/custom/connect_prompt_sync_smoketest.wav

echo "[4/4] cron entry:"
cat /etc/cron.d/connect-prompt-sync

echo
echo "DONE. Connect → PBX prompt sync is wired."
echo
echo "Next test:"
echo "  1. Open Connect portal → IVR section → re-upload your greeting."
echo "  2. The portal response should include pbxPush.status = \"pushed\"."
echo "  3. Verify it landed:"
echo "       ls -la /var/lib/asterisk/sounds/custom/"
echo "       tail -5 /var/lib/connect-pbx-helper/audit.jsonl"
echo "  4. Place a test call to your IVR DID — you'll hear the new greeting."
