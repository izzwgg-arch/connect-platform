#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com}"
API_LOCAL="${API_LOCAL:-http://127.0.0.1:3001/health}"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[release:status] repo=$(pwd)"

commit="$(git show -s --format=%h HEAD 2>/dev/null || echo unknown)"
head_tag="$(git tag --points-at HEAD | sort -V | tail -n1 || true)"
if [[ -z "${head_tag}" ]]; then
  head_tag="$(git describe --tags --abbrev=0 2>/dev/null || echo none)"
fi

echo "[release:status] git_head=${commit} tag=${head_tag} branch=$(git branch --show-current 2>/dev/null || echo detached)"

echo "[release:status] containers"
while IFS= read -r c; do
  [[ -z "$c" ]] && continue
  img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || echo unknown)"
  created="$(docker image inspect "$img" -f '{{.Created}}' 2>/dev/null || echo unknown)"
  printf '  - %s | %s | image_created=%s
' "$c" "$img" "$created"
done < <(docker ps --format '{{.Names}}' | grep -E '^(app-|connectcomms-)' || true)

api_code="$(curl -ksS -o /dev/null -w '%{http_code}' "$API_LOCAL" || echo 000)"
portal_code="$(curl -ksS -o /dev/null -w '%{http_code}' "$BASE_URL/dashboard" || echo 000)"
echo "[release:status] api_health_code=${api_code} portal_dashboard_code=${portal_code}"

echo "[release:status] check-migrations"
if ./scripts/check-migrations.sh >/tmp/release_status_mig.out 2>&1; then
  tail -n 3 /tmp/release_status_mig.out
else
  tail -n 20 /tmp/release_status_mig.out
  exit 1
fi
