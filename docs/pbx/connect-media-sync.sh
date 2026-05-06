#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# connect-media-sync
#
# Cron-driven puller that mirrors Connect-managed MOH assets onto a VitalPBX /
# Asterisk host without ever letting Connect SSH in. The script:
#
#   1. GETs  https://<CONNECT_URL>/voice/moh/sync-manifest with the shared
#      secret in the `x-connect-secret` header.
#   2. For each file:
#        • compares local sha256 to the manifest entry
#        • (re-)downloads via the signed URL only when they differ
#        • writes atomically (tmp → rename) so Asterisk never sees a partial file
#   3. Removes any files in `$MOH_ROOT/<class>` that are NOT in the manifest
#      (archive / delete happened in Connect).
#   4. Runs `asterisk -rx "moh reload"` ONLY if something actually changed.
#
# Non-goals:
#   - This script NEVER calls Asterisk during a live call; cron is the only
#     trigger.
#   - It never calls Connect per call; manifest is fetched on cadence only.
#
# Installation: see docs/pbx/connect-media-sync-install.md
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
CONNECT_URL="${CONNECT_URL:-https://connect.example.com}"
MOH_ROOT="${MOH_ROOT:-/var/lib/asterisk/moh}"
# Asterisk only plays MOH classes that exist in musiconhold.conf. This fragment
# is regenerated each run from the manifest (connect_* classes only). Add once
# to your main musiconhold include chain, e.g.:
#   #tryinclude musiconhold__99_connect_assets.conf
# See docs/pbx/connect-media-sync-install.md
MOH_GENERATED_CONF="${MOH_GENERATED_CONF:-/etc/asterisk/musiconhold__99_connect_assets.conf}"
MAIN_MOH_CONF="${MAIN_MOH_CONF:-/etc/asterisk/musiconhold.conf}"
STATE_DIR="${STATE_DIR:-/var/lib/connect-media-sync}"
SECRET_FILE="${SECRET_FILE:-/etc/connect/connect_media_secret}"
LOG_FILE="${LOG_FILE:-/var/log/connect-media-sync.log}"
ASTERISK_BIN="${ASTERISK_BIN:-asterisk}"
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() {
  # Timestamped log line, appended to LOG_FILE and stderr (so cron mails work).
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '%s %s\n' "$ts" "$*" | tee -a "$LOG_FILE" >&2
}

need() {
  command -v "$1" >/dev/null 2>&1 || { log "FATAL: missing dependency: $1"; exit 2; }
}

sha256_of() {
  # Portable sha256 for CentOS/RHEL (sha256sum) and macOS dev boxes (shasum).
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

atomic_mkdir() {
  install -d -m 0755 "$1"
}

# ── Preflight ────────────────────────────────────────────────────────────────
need curl
need jq
need awk
atomic_mkdir "$STATE_DIR"
atomic_mkdir "$MOH_ROOT"
touch "$LOG_FILE"

if [[ ! -r "$SECRET_FILE" ]]; then
  log "FATAL: secret file $SECRET_FILE not readable"
  exit 2
fi
SECRET="$(tr -d ' \t\r\n' < "$SECRET_FILE")"
if [[ -z "$SECRET" ]]; then
  log "FATAL: secret file $SECRET_FILE is empty"
  exit 2
fi

# Concurrency guard — don't ever run two pulls at once.
LOCK="$STATE_DIR/sync.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another sync run is in progress (lock $LOCK); exiting"
  exit 0
fi

MANIFEST_JSON="$STATE_DIR/manifest.json"

# ── Fetch manifest ───────────────────────────────────────────────────────────
log "fetching manifest from $CONNECT_URL"
if ! curl -fsSL \
      --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 4))" \
      -H "x-connect-secret: $SECRET" \
      -o "$MANIFEST_JSON" \
      "$CONNECT_URL/voice/moh/sync-manifest"; then
  log "ERROR: manifest fetch failed — leaving MOH state as-is"
  exit 1
fi

# Basic sanity check so a malformed response doesn't nuke the local MOH tree.
if ! jq -e '.files | type == "array"' "$MANIFEST_JSON" >/dev/null; then
  log "ERROR: manifest missing .files[] — leaving MOH state as-is"
  exit 1
fi

CHANGED=0

# ── Download / update files ──────────────────────────────────────────────────
# Walk the manifest one row at a time. `jq -c` emits one JSON object per line
# so we can pipe safely even with spaces in paths.
while IFS= read -r row; do
  rel="$(jq -r '.relPath // empty' <<<"$row")"
  cls="$(jq -r '.mohClass // empty' <<<"$row")"
  sha="$(jq -r '.sha256 // empty'   <<<"$row")"
  url="$(jq -r '.downloadUrl // empty' <<<"$row")"
  if [[ -z "$rel" || -z "$cls" || -z "$sha" || -z "$url" ]]; then
    log "WARN: skipping manifest row with missing fields: $row"
    continue
  fi

  case "$rel" in
    *.wav) : ;;
    *)
      log "WARN: skipping non-WAV manifest row (Connect only syncs PBX-ready WAV): $rel"
      continue
      ;;
  esac

  # Reject any relative path attempting traversal. `connect-media-sync` runs
  # as root-ish in most deployments; belt-and-suspenders matters.
  case "$rel" in
    *..*|/*) log "WARN: refusing unsafe relPath: $rel"; continue ;;
  esac

  dest="$MOH_ROOT/$rel"
  dest_dir="$(dirname "$dest")"
  atomic_mkdir "$dest_dir"
  chmod 0755 "$dest_dir" 2>/dev/null || true

  if [[ -f "$dest" ]] && [[ "$(sha256_of "$dest")" == "$sha" ]]; then
    continue
  fi

  tmp="$dest.tmp.$$"
  log "downloading class=$cls rel=$rel"
  if ! curl -fsSL \
        --connect-timeout "$CURL_TIMEOUT" --max-time "$((CURL_TIMEOUT * 6))" \
        -o "$tmp" "$url"; then
    log "ERROR: download failed for $rel"
    rm -f "$tmp"
    continue
  fi

  got="$(sha256_of "$tmp")"
  if [[ "$got" != "$sha" ]]; then
    log "ERROR: sha256 mismatch for $rel (expected $sha got $got) — discarding"
    rm -f "$tmp"
    continue
  fi

  mv -f "$tmp" "$dest"
  chmod 0644 "$dest"
  CHANGED=1
done < <(jq -c '.files[]' "$MANIFEST_JSON")

# ── Reconcile deletes ────────────────────────────────────────────────────────
# Remove any file under $MOH_ROOT/<class>/ that Connect no longer advertises.
# We only touch directories whose name starts with `connect_` to avoid
# stomping on manually-managed MOH classes on the same PBX.
while IFS= read -r cls_dir; do
  class="$(basename "$cls_dir")"
  case "$class" in
    connect_*) : ;;
    *) continue ;;
  esac
  while IFS= read -r f; do
    rel="${f#"$MOH_ROOT/"}"
    if ! jq -e --arg rel "$rel" '.files[] | select(.relPath==$rel)' "$MANIFEST_JSON" >/dev/null; then
      log "removing orphan $rel"
      rm -f "$f"
      CHANGED=1
    fi
  done < <(find "$cls_dir" -maxdepth 1 -type f 2>/dev/null)
done < <(find "$MOH_ROOT" -maxdepth 1 -type d -name 'connect_*' 2>/dev/null)

# ── Regenerate musiconhold stanzas for connect_* classes ─────────────────────
# Files on disk are not enough: Asterisk needs a [classname] section per MOH class.
tmpconf="$(mktemp)"
{
  echo "; AUTO-GENERATED by connect-media-sync ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "; One-time on this PBX: ensure musiconhold.conf (or VitalPBX custom include) contains:"
  echo ";   #include musiconhold__99_connect_assets.conf"
  while IFS= read -r cls; do
    [[ -z "$cls" ]] && continue
    case "$cls" in connect_*) : ;; *) continue ;; esac
    printf '\n[%s]\n' "$cls"
    echo "mode=files"
    echo "directory=${MOH_ROOT}/${cls}"
    echo "sort=random"
  done < <(jq -r '.files[] | select(.relPath | test(".wav$")) | .mohClass' "$MANIFEST_JSON" 2>/dev/null | sort -u)
} > "$tmpconf"
if [[ ! -f "$MOH_GENERATED_CONF" ]] || ! cmp -s "$tmpconf" "$MOH_GENERATED_CONF"; then
  atomic_mkdir "$(dirname "$MOH_GENERATED_CONF")"
  mv -f "$tmpconf" "$MOH_GENERATED_CONF"
  chmod 0644 "$MOH_GENERATED_CONF"
  log "wrote MOH class definitions to $MOH_GENERATED_CONF"
  CHANGED=1
else
  rm -f "$tmpconf"
fi

# ── Ensure musiconhold.conf references this fragment (idempotent, backup first) ─
ensure_musiconhold_include() {
  if [[ ! -f "$MAIN_MOH_CONF" ]]; then
    log "WARN: $MAIN_MOH_CONF not found — skipping include-chain check (set MAIN_MOH_CONF if non-standard)"
    return 0
  fi
  if grep -qE '(^|[[:space:]])#(include|tryinclude)[[:space:]]+musiconhold__99_connect_assets\.conf' "$MAIN_MOH_CONF" \
      || grep -qE '(^|[[:space:]])#include[[:space:]]+"?musiconhold__99_connect_assets\.conf"?[[:space:]]*$' "$MAIN_MOH_CONF"; then
    log "musiconhold include chain already references musiconhold__99_connect_assets.conf"
    return 0
  fi
  local stamp backup line
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${MAIN_MOH_CONF}.bak.connect-media-sync.${stamp}"
  if ! cp -a "$MAIN_MOH_CONF" "$backup"; then
    log "ERROR: could not backup $MAIN_MOH_CONF — not modifying include chain"
    return 1
  fi
  line='#include musiconhold__99_connect_assets.conf'
  {
    echo ""
    echo "; BEGIN connect-media-sync managed include (do not duplicate)"
    echo "$line"
    echo "; END connect-media-sync managed include"
  } >>"$MAIN_MOH_CONF"
  log "appended managed MOH include to $MAIN_MOH_CONF (backup: $backup)"
  CHANGED=1
  return 0
}
ensure_musiconhold_include

# ── Reload Asterisk MOH ──────────────────────────────────────────────────────
if [[ "$CHANGED" -eq 1 ]]; then
  if command -v "$ASTERISK_BIN" >/dev/null 2>&1; then
    log "triggering 'moh reload' on Asterisk"
    "$ASTERISK_BIN" -rx "moh reload" >>"$LOG_FILE" 2>&1 || \
      log "WARN: moh reload exit code $?"
  else
    log "WARN: $ASTERISK_BIN not found — skipping moh reload"
  fi
else
  log "no changes — skipping moh reload"
fi

log "done"
