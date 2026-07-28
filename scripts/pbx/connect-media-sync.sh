#!/usr/bin/env bash
# connect-media-sync — pull Connect-uploaded hold-music (MOH) onto the PBX host.
#
# The Connect API catalogs tenant uploads as MohAsset rows and serves
# GET /voice/moh/sync-manifest (shared-secret header) with signed download
# URLs. This helper mirrors those WAVs into /var/lib/asterisk/moh/<class>/,
# generates the Asterisk MOH class definitions, and reloads res_musiconhold —
# only when something actually changed.
#
# Design notes:
#   • PULL model: the PBX fetches from Connect on a cron; Connect never pushes
#     or SSHes into the PBX. Zero call-time impact.
#   • Class names are strictly ^connect_[a-z0-9_-]+$ — this helper never touches
#     native VitalPBX classes (mohN) or their files.
#   • Class definitions land in /etc/asterisk/vitalpbx/musiconhold__60-connect-uploads.conf,
#     picked up by the stock `#include vitalpbx/musiconhold__*.conf` in
#     /etc/asterisk/musiconhold.conf. VitalPBX regenerates only its own
#     musiconhold__50-* files, so this file survives tenant re-saves.
#
# Install (root):
#   install -m 0755 connect-media-sync.sh /usr/local/sbin/connect-media-sync
#   echo 'CONNECT_URL=https://app.connectcomunications.com/api' > /etc/default/connect-media-sync
#   # secret already at /etc/connect/connect_media_secret (shared with prompt-sync)
#   # cron (already present on the PBX):
#   #   */5 * * * * root . /etc/default/connect-media-sync; /usr/local/sbin/connect-media-sync >>/var/log/connect-media-sync.log 2>&1

set -euo pipefail

# Self-source the defaults file: cron's `. /etc/default/...` sets plain (un-
# exported) shell variables that do NOT reach this child process (live miss on
# first install 2026-07-28: CONNECT_URL stayed at the example default). Values
# in the file win; set DEFAULTS_FILE=/dev/null to run with pure env overrides.
DEFAULTS_FILE="${DEFAULTS_FILE:-/etc/default/connect-media-sync}"
if [[ -r "$DEFAULTS_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEFAULTS_FILE"
  set +a
fi

CONNECT_URL="${CONNECT_URL:-https://connect.example.com}"
MOH_DIR="${MOH_DIR:-/var/lib/asterisk/moh}"
CONF_FILE="${CONF_FILE:-/etc/asterisk/vitalpbx/musiconhold__60-connect-uploads.conf}"
STATE_DIR="${STATE_DIR:-/var/lib/connect-media-sync}"
SECRET_FILE="${SECRET_FILE:-/etc/connect/connect_media_secret}"
LOG_FILE="${LOG_FILE:-/var/log/connect-media-sync.log}"
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"

# stderr only — cron already appends both streams to LOG_FILE; tee-ing here
# too double-writes every line (seen on first install 2026-07-28).
log() {
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '%s %s\n' "$ts" "$*" >&2
}

need() {
  command -v "$1" >/dev/null 2>&1 || { log "FATAL: missing dependency: $1"; exit 2; }
}

sha256_of() {
  sha256sum "$1" | awk '{print $1}'
}

need curl
need jq
need awk
need sha256sum
install -d -m 0755 "$STATE_DIR"
touch "$LOG_FILE"

if [[ ! -d "$MOH_DIR" ]]; then
  log "FATAL: MOH dir $MOH_DIR does not exist"
  exit 2
fi
if [[ ! -r "$SECRET_FILE" ]]; then
  log "FATAL: secret file $SECRET_FILE not readable"
  exit 2
fi
SECRET="$(tr -d ' \t\r\n' < "$SECRET_FILE")"
if [[ -z "$SECRET" ]]; then
  log "FATAL: secret file $SECRET_FILE is empty"
  exit 2
fi

LOCK="$STATE_DIR/sync.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another sync run is in progress (lock $LOCK); exiting"
  exit 0
fi

MANIFEST_JSON="$STATE_DIR/manifest.json"
if ! curl -fsSL \
      --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 4))" \
      -H "x-connect-secret: $SECRET" \
      -o "$MANIFEST_JSON" \
      "$CONNECT_URL/voice/moh/sync-manifest"; then
  log "ERROR: manifest fetch failed - leaving MOH alone"
  exit 1
fi
if ! jq -e '.files | type == "array"' "$MANIFEST_JSON" >/dev/null; then
  log "ERROR: manifest missing .files[] - aborting"
  exit 1
fi

ASTERISK_UID="$(id -u asterisk 2>/dev/null || echo "")"
ASTERISK_GID="$(id -g asterisk 2>/dev/null || echo "")"

CHANGED=0
PULLED=0
SKIPPED=0
FAILED=0
declare -A WANT_CLASS=()

# ── pull leg: mirror every manifest file into $MOH_DIR/<class>/asset.wav ──
while IFS=$'\t' read -r moh_class want_sha url; do
  [[ -z "$moh_class" || -z "$want_sha" || -z "$url" ]] && continue
  if ! [[ "$moh_class" =~ ^connect_[a-z0-9_-]+$ ]]; then
    log "WARN: skipping non-connect class name in manifest: $moh_class"
    continue
  fi
  WANT_CLASS["$moh_class"]=1
  # Re-base the signed URL onto CONNECT_URL: the API builds downloadUrl from
  # PUBLIC_API_URL, which is unset in production, so the manifest says
  # http://localhost:3001/... (live miss 2026-07-28). The HMAC covers only
  # storageKey+exp — never the host — and downloads come from the same API
  # as the manifest, so this rewrite is always safe.
  url="$CONNECT_URL$(printf '%s' "$url" | sed -E 's#^[a-z]+://[^/]+##')"
  target_dir="$MOH_DIR/$moh_class"
  target="$target_dir/asset.wav"

  if [[ -f "$target" ]] && [[ "$(sha256_of "$target")" == "$want_sha" ]]; then
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  install -d -m 0755 "$target_dir"
  tmp="$(mktemp "$target_dir/.asset.XXXXXX.wav.tmp")"
  log "pulling $moh_class/asset.wav (want sha=${want_sha:0:12})"
  if ! curl -fsSL \
        --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 6))" \
        -o "$tmp" \
        "$url"; then
    log "ERROR: download failed for $moh_class"
    rm -f "$tmp"
    FAILED=$((FAILED+1))
    continue
  fi
  got_sha="$(sha256_of "$tmp")"
  if [[ "$got_sha" != "$want_sha" ]]; then
    log "ERROR: sha mismatch for $moh_class (got=${got_sha:0:12} want=${want_sha:0:12})"
    rm -f "$tmp"
    FAILED=$((FAILED+1))
    continue
  fi
  chmod 0644 "$tmp"
  if [[ -n "$ASTERISK_UID" && -n "$ASTERISK_GID" ]]; then
    chown "${ASTERISK_UID}:${ASTERISK_GID}" "$tmp" 2>/dev/null || true
    chown "${ASTERISK_UID}:${ASTERISK_GID}" "$target_dir" 2>/dev/null || true
  fi
  mv -f "$tmp" "$target"
  PULLED=$((PULLED+1))
  CHANGED=1
done < <(jq -r '.files[] | [.mohClass // "", .sha256 // "", .downloadUrl // ""] | @tsv' "$MANIFEST_JSON")

# ── reap leg: drop LOCAL connect_* class dirs no longer in the manifest.
#    Native classes and stock MOH files are untouched (connect_ prefix guard). ──
for dir in "$MOH_DIR"/connect_*/; do
  [[ -d "$dir" ]] || continue
  cls="$(basename "$dir")"
  [[ "$cls" =~ ^connect_[a-z0-9_-]+$ ]] || continue
  if [[ -z "${WANT_CLASS[$cls]:-}" ]]; then
    log "removing retired class $cls"
    rm -rf "$dir"
    CHANGED=1
  fi
done

# ── conf leg: one files-mode class stanza per synced class dir ──
NEW_CONF="$STATE_DIR/conf.new"
{
  echo "; Generated by connect-media-sync — DO NOT EDIT (regenerated every run)."
  echo "; Connect-uploaded hold-music classes; audio lives in $MOH_DIR/<class>/."
  for cls in $(printf '%s\n' "${!WANT_CLASS[@]}" | sort); do
    echo ""
    echo "[$cls]"
    echo "mode=files"
    echo "directory=$MOH_DIR/$cls"
  done
} > "$NEW_CONF"

if [[ ! -f "$CONF_FILE" ]] || ! cmp -s "$NEW_CONF" "$CONF_FILE"; then
  install -m 0644 "$NEW_CONF" "$CONF_FILE"
  log "updated $CONF_FILE (${#WANT_CLASS[@]} class(es))"
  CHANGED=1
fi
rm -f "$NEW_CONF"

# ── reload leg: only when files or conf changed ──
# Full path: cron's PATH (/usr/bin:/bin) misses /usr/sbin/asterisk — the bare
# name made every cron reload fail on first install (2026-07-28).
AST_BIN="${AST_BIN:-$(command -v asterisk || echo /usr/sbin/asterisk)}"
if [[ "$CHANGED" -eq 1 ]]; then
  if "$AST_BIN" -rx "module reload res_musiconhold" >/dev/null 2>&1; then
    log "reloaded res_musiconhold"
  else
    log "ERROR: asterisk moh reload failed"
    exit 1
  fi
fi

log "done - pulled=$PULLED skipped=$SKIPPED failed=$FAILED classes=${#WANT_CLASS[@]} changed=$CHANGED"
