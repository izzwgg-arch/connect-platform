#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# one-shot-prompt-push
#
# Single-use uploader: reads every system recording under
# /var/lib/asterisk/sounds/custom/ on the VitalPBX host and pushes each one to
# Connect's /voice/ivr/prompts/upload endpoint. Exits when done — not a cron,
# not a daemon, not a service. Safe to re-run (Connect dedupes by sha256).
#
# Usage (from the PBX host):
#   SECRET=<shared_secret> ./one-shot-prompt-push.sh
#
# Requires curl + sha256sum (both always present on a VitalPBX box).
# ─────────────────────────────────────────────────────────────────────────────
set -u

CONNECT_URL="${CONNECT_URL:-https://app.connectcomunications.com/api}"
SOUNDS_DIR="${SOUNDS_DIR:-/var/lib/asterisk/sounds/custom}"
SECRET="${SECRET:-}"

if [[ -z "${SECRET}" ]]; then
  echo "FATAL: SECRET env var is required" >&2
  exit 2
fi
if [[ ! -d "${SOUNDS_DIR}" ]]; then
  echo "FATAL: ${SOUNDS_DIR} does not exist" >&2
  exit 2
fi

UPLOADED=0; SKIPPED=0; FAILED=0; TOTAL=0
declare -A SEEN_BASE=()

# Prefer .wav > .mp3 > .gsm > .sln16 per basename so we don't upload three
# formats of the same recording. We rank extensions; lowest rank wins.
rank_ext() {
  case "${1,,}" in
    wav)   echo 0 ;;
    mp3)   echo 1 ;;
    ogg)   echo 2 ;;
    m4a)   echo 3 ;;
    gsm)   echo 4 ;;
    g722)  echo 5 ;;
    g729)  echo 6 ;;
    sln16) echo 7 ;;
    sln)   echo 8 ;;
    ulaw)  echo 9 ;;
    alaw)  echo 10 ;;
    *)     echo 99 ;;
  esac
}

declare -A BEST=()
declare -A BEST_RANK=()

shopt -s nullglob
for f in "${SOUNDS_DIR}"/*; do
  [[ -f "$f" ]] || continue
  name="$(basename "$f")"
  ext="${name##*.}"
  stem="${name%.*}"
  [[ -z "$stem" ]] && continue
  r=$(rank_ext "$ext")
  [[ $r -ge 99 ]] && continue
  prev="${BEST_RANK[$stem]:-99}"
  if [[ $r -lt $prev ]]; then
    BEST_RANK[$stem]="$r"
    BEST[$stem]="$f"
  fi
done

for stem in "${!BEST[@]}"; do
  f="${BEST[$stem]}"
  TOTAL=$((TOTAL+1))
  filename="$(basename "$f")"
  sha="$(sha256sum "$f" | awk '{print $1}')"
  if [[ -z "$sha" ]]; then
    echo "  FAIL  $filename  (sha256sum failed)" >&2
    FAILED=$((FAILED+1))
    continue
  fi
  meta=$(printf '{"fileBaseName":"%s","originalFilename":"%s","sha256":"%s"}' \
    "$stem" "$filename" "$sha")

  code="$(curl -sS -o /tmp/prompt-upload-resp.json -w '%{http_code}' \
      --connect-timeout 10 --max-time 60 \
      -H "x-connect-secret: ${SECRET}" \
      -F "file=@${f}" \
      -F "meta=${meta}" \
      "${CONNECT_URL}/voice/ivr/prompts/upload" || echo '000')"

  if [[ "$code" =~ ^2 ]]; then
    echo "  ok    $filename"
    UPLOADED=$((UPLOADED+1))
  else
    body="$(head -c 200 /tmp/prompt-upload-resp.json 2>/dev/null)"
    echo "  FAIL  $filename  (HTTP $code) $body" >&2
    FAILED=$((FAILED+1))
  fi
done

echo ""
echo "done. uploaded=${UPLOADED} failed=${FAILED} total=${TOTAL}"
