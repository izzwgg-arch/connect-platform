#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# connect-prompt-sync — bidirectional IVR prompt sync between VitalPBX and Connect.
#
# DIRECTION 1 (PBX → Connect, original behaviour):
#   Pushes VitalPBX System Recordings (/var/lib/asterisk/sounds/custom/*)
#   into Connect's prompt catalog so admins can preview them via the
#   in-browser "Play" button.
#
# DIRECTION 2 (Connect → PBX, added 2026-05-03):
#   Pulls any prompt whose authoritative bytes live in Connect (e.g. an
#   admin uploaded a greeting through Connect's IVR section) so it lands
#   on the PBX's filesystem where `Background()` can play it during a call.
#   This is the *catch-up* channel; the immediate route-helper push from
#   Connect's API at upload time is the primary delivery — this loop
#   guarantees eventual consistency if that push ever fails or the admin
#   uploads while the helper is briefly down.
#
# Flow:
#   1. GET  https://<CONNECT_URL>/voice/ivr/prompts/sync-manifest
#      (x-connect-secret header) — returns the current catalog with each
#      prompt's current sha256 plus a signed `downloadUrl` for any row
#      whose audio bytes are stored on Connect.
#   2. PUSH (PBX → Connect): For every *.wav / *.mp3 / *.gsm in SOUNDS_DIR:
#        • compute local sha256
#        • if the catalog already has that sha256 for this fileBaseName,
#          SKIP (zero bandwidth)
#        • otherwise POST /voice/ivr/prompts/upload with the file bytes +
#          meta JSON.
#   3. PULL (Connect → PBX): For every catalog row with a non-empty
#      downloadUrl whose sha256 doesn't match the local file under
#      SOUNDS_DIR (or the file is missing entirely):
#        • download via the signed URL (no extra credentials in the
#          query string — the URL itself carries an HMAC).
#        • atomic rename into /var/lib/asterisk/sounds/custom/<base>.wav
#        • chown asterisk:asterisk, chmod 0644.
#
# Non-goals:
#   - Not for per-call traffic. Cron is the only trigger.
#   - Never deletes files on the PBX; missing-from-catalog rows are left
#     alone so a manual upload via the VitalPBX UI is never overwritten.
#
# Installation:
#   1. Drop this script at /usr/local/bin/connect-prompt-sync and chmod +x.
#   2. Store the shared secret (same value as MOH_SYNC_SHARED_SECRET on
#      Connect) at /etc/connect/connect_media_secret (mode 0600).
#   3. Schedule: `*/10 * * * * /usr/local/bin/connect-prompt-sync` in root's
#      crontab. Ten-minute cadence is a safe default; increase if your PBX
#      has thousands of recordings.
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
CONNECT_URL="${CONNECT_URL:-https://connect.example.com}"
SOUNDS_DIR="${SOUNDS_DIR:-/var/lib/asterisk/sounds/custom}"
STATE_DIR="${STATE_DIR:-/var/lib/connect-prompt-sync}"
SECRET_FILE="${SECRET_FILE:-/etc/connect/connect_media_secret}"
LOG_FILE="${LOG_FILE:-/var/log/connect-prompt-sync.log}"
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"

# Which extensions we consider playable. Asterisk stores the same recording
# in multiple formats; we pick ONE per basename (prefer .wav → .mp3 → .gsm).
EXT_PRIORITY=(wav mp3 ogg m4a gsm g722 g729 sln16 sln ulaw alaw)

# ── Helpers ──────────────────────────────────────────────────────────────────
log() {
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '%s %s\n' "$ts" "$*" | tee -a "$LOG_FILE" >&2
}

need() {
  command -v "$1" >/dev/null 2>&1 || { log "FATAL: missing dependency: $1"; exit 2; }
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

atomic_mkdir() { install -d -m 0755 "$1"; }

# ── Preflight ────────────────────────────────────────────────────────────────
need curl
need jq
need awk
atomic_mkdir "$STATE_DIR"
touch "$LOG_FILE"

if [[ ! -d "$SOUNDS_DIR" ]]; then
  log "FATAL: sounds dir $SOUNDS_DIR does not exist"
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

# Concurrency guard.
LOCK="$STATE_DIR/sync.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another sync run is in progress (lock $LOCK); exiting"
  exit 0
fi

MANIFEST_JSON="$STATE_DIR/manifest.json"

# ── Fetch the catalog manifest ───────────────────────────────────────────────
log "fetching catalog from $CONNECT_URL"
if ! curl -fsSL \
      --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 4))" \
      -H "x-connect-secret: $SECRET" \
      -o "$MANIFEST_JSON" \
      "$CONNECT_URL/voice/ivr/prompts/sync-manifest"; then
  log "ERROR: manifest fetch failed — leaving prompts alone"
  exit 1
fi

if ! jq -e '.files | type == "array"' "$MANIFEST_JSON" >/dev/null; then
  log "ERROR: manifest missing .files[] — aborting"
  exit 1
fi

# Build a quick lookup: fileBaseName → sha256 in the existing catalog.
# jq emits "base<TAB>sha" pairs we stuff into an associative array.
declare -A CATALOG_SHA=()
while IFS=$'\t' read -r base sha; do
  [[ -z "$base" ]] && continue
  CATALOG_SHA["$base"]="$sha"
done < <(jq -r '.files[] | [.fileBaseName // "", .sha256 // ""] | @tsv' "$MANIFEST_JSON")

# ── Walk the sounds dir ──────────────────────────────────────────────────────
# For each basename, pick the best-supported format (EXT_PRIORITY order) so we
# don't upload four copies of the same recording. Asterisk writes e.g.
# acme_main.wav + acme_main.sln16 + acme_main.gsm; we'd pick .wav.
declare -A BEST_PATH=()
declare -A BEST_RANK=()

for f in "$SOUNDS_DIR"/*; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  ext="${base##*.}"
  stem="${base%.*}"
  [[ -z "$stem" ]] && continue

  # Determine rank (lower is better).
  rank=9999
  for i in "${!EXT_PRIORITY[@]}"; do
    if [[ "${EXT_PRIORITY[$i]}" == "${ext,,}" ]]; then
      rank="$i"
      break
    fi
  done
  [[ "$rank" -eq 9999 ]] && continue

  prev="${BEST_RANK[$stem]:-9999}"
  if [[ "$rank" -lt "$prev" ]]; then
    BEST_RANK[$stem]="$rank"
    BEST_PATH[$stem]="$f"
  fi
done

UPLOADED=0
SKIPPED=0
FAILED=0

for stem in "${!BEST_PATH[@]}"; do
  src="${BEST_PATH[$stem]}"
  sha="$(sha256_of "$src")"
  [[ -z "$sha" ]] && { log "WARN: sha failed for $src"; FAILED=$((FAILED+1)); continue; }

  existing="${CATALOG_SHA[$stem]:-}"
  if [[ -n "$existing" && "$existing" == "$sha" ]]; then
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  filename="$(basename "$src")"
  meta_json="$(jq -cn \
    --arg base "$stem" \
    --arg orig "$filename" \
    --arg sha  "$sha" \
    '{fileBaseName: $base, originalFilename: $orig, sha256: $sha}')"

  log "uploading $filename (sha=${sha:0:12}…)"
  http_status="$(curl -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 6))" \
        -H "x-connect-secret: $SECRET" \
        -F "file=@${src}" \
        -F "meta=${meta_json}" \
        "$CONNECT_URL/voice/ivr/prompts/upload" || echo '000')"

  if [[ "$http_status" =~ ^2 ]]; then
    UPLOADED=$((UPLOADED+1))
  else
    log "ERROR: upload failed for $filename (HTTP $http_status)"
    FAILED=$((FAILED+1))
  fi
done

# ── Pull leg: Connect-authoritative prompts → /var/lib/asterisk/sounds/custom ─
# This is the catch-up half of the bidirectional sync. The Connect API also
# pushes prompts to the route-helper directly at upload time; this loop
# backstops that path so an admin upload during a network blip eventually
# becomes audible without manual intervention.
PULLED=0
PULL_SKIPPED=0
PULL_FAILED=0

# Build a quick lookup of every fileBaseName that the API marked as
# "Connect-authoritative" (has a downloadUrl), with its expected sha.
# Rows without downloadUrl are PBX-authoritative and are never touched
# by the pull leg.
PULL_TUPLES_FILE="$STATE_DIR/pull-tuples.tsv"
jq -r '
  .files[]
  | select(.downloadUrl != null and .downloadUrl != "")
  | [.fileBaseName // "", .sha256 // "", .downloadUrl // "", .sizeBytes // 0]
  | @tsv
' "$MANIFEST_JSON" > "$PULL_TUPLES_FILE" || true

if [[ -s "$PULL_TUPLES_FILE" ]]; then
  log "pull-leg: $(wc -l < "$PULL_TUPLES_FILE" | tr -d ' ') Connect-authoritative prompt(s) to reconcile"
  ASTERISK_UID="$(id -u asterisk 2>/dev/null || echo "")"
  ASTERISK_GID="$(id -g asterisk 2>/dev/null || echo "")"

  while IFS=$'\t' read -r base want_sha url _size; do
    [[ -z "$base" || -z "$want_sha" || -z "$url" ]] && continue

    # Locate the local file in ANY of the supported extensions; we
    # always WRITE as .wav (matches the dialplan's STAT() check) but
    # tolerate legacy formats already on disk.
    local_path=""
    local_sha=""
    for ext in wav WAV mp3 ogg gsm; do
      candidate="$SOUNDS_DIR/${base}.${ext}"
      if [[ -f "$candidate" ]]; then
        local_path="$candidate"
        local_sha="$(sha256_of "$candidate")"
        break
      fi
    done

    if [[ -n "$local_sha" && "$local_sha" == "$want_sha" ]]; then
      PULL_SKIPPED=$((PULL_SKIPPED+1))
      continue
    fi

    target="$SOUNDS_DIR/${base}.wav"
    tmp="$(mktemp "$SOUNDS_DIR/.${base}.XXXXXX.wav.tmp")"

    log "pulling ${base}.wav (want sha=${want_sha:0:12}…)"
    if ! curl -fsSL \
          --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 6))" \
          -o "$tmp" \
          "$url"; then
      log "ERROR: pull download failed for ${base}.wav"
      rm -f "$tmp"
      PULL_FAILED=$((PULL_FAILED+1))
      continue
    fi

    got_sha="$(sha256_of "$tmp")"
    if [[ "$got_sha" != "$want_sha" ]]; then
      log "ERROR: pull sha mismatch for ${base}.wav (got=${got_sha:0:12} want=${want_sha:0:12})"
      rm -f "$tmp"
      PULL_FAILED=$((PULL_FAILED+1))
      continue
    fi

    # Best-effort ownership change. If we're not root and the asterisk
    # account isn't in our supplementary groups, the chown will fail
    # silently and the rename will still succeed — Asterisk reads the
    # file via the world-read bit (0644).
    chmod 0644 "$tmp" 2>/dev/null || true
    if [[ -n "$ASTERISK_UID" && -n "$ASTERISK_GID" ]]; then
      chown "${ASTERISK_UID}:${ASTERISK_GID}" "$tmp" 2>/dev/null || true
    fi
    mv -f "$tmp" "$target"
    PULLED=$((PULLED+1))
  done < "$PULL_TUPLES_FILE"

  rm -f "$PULL_TUPLES_FILE"
fi

log "done — uploaded=$UPLOADED skipped=$SKIPPED failed=$FAILED total=${#BEST_PATH[@]} | pulled=$PULLED pull_skipped=$PULL_SKIPPED pull_failed=$PULL_FAILED"
