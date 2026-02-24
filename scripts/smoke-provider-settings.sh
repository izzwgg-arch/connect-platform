#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3001}"
SUFFIX="$(date +%s)"
ADMIN_EMAIL="support-provider-${SUFFIX}@connectcomunications.com"
ADMIN_PASSWORD="AdminPass!234"

sid_prefix="A"
sid_account="${sid_prefix}C$(printf '%030d' "${SUFFIX:0:10}")"
sid_service="M$(printf 'G%s' "$(printf '%030d' "${SUFFIX:0:10}")")"

echo "[1/4] Create admin tenant/user"
signup_json="$(curl -sS -X POST "${API_BASE}/auth/signup" -H 'content-type: application/json' -d "{\"tenantName\":\"Provider Smoke ${SUFFIX}\",\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")"
token="$(printf '%s' "$signup_json" | jq -r '.token')"
if [[ -z "$token" || "$token" == "null" ]]; then
  echo "signup failed" >&2
  exit 1
fi

echo "[2/4] Save twilio credentials (test values)"
resp_put="$(curl -sS -X PUT "${API_BASE}/settings/providers/twilio" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer ${token}" \
  -d "{\"accountSid\":\"${sid_account}\",\"authToken\":\"example-token\",\"messagingServiceSid\":\"${sid_service}\",\"label\":\"Smoke Twilio\"}")"
if ! printf '%s' "$resp_put" | jq -e '.provider == "TWILIO"' >/dev/null; then
  echo "provider save failed" >&2
  exit 1
fi

echo "[3/4] Enable twilio"
curl -sS -X POST "${API_BASE}/settings/providers/twilio/enable" -H "Authorization: Bearer ${token}" >/dev/null

echo "[4/4] List providers (masked values only)"
resp_get="$(curl -sS -X GET "${API_BASE}/settings/providers" -H "Authorization: Bearer ${token}")"
if ! printf '%s' "$resp_get" | jq -e '.[0].preview.authToken != null' >/dev/null; then
  echo "masking verification failed" >&2
  exit 1
fi

echo "provider settings smoke test passed"
