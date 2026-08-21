#!/usr/bin/env bash
# Behavioural tests for the blue/green "public verify" probe in
#   scripts/lib/deploy-api-rollout.sh    -> deploy_api_rollout_wait_ready
#   scripts/lib/deploy-portal-rollout.sh -> deploy_portal_rollout_wait_ready
#
# Run:  bash scripts/lib/deploy-rollout-probe.test.sh
#       (or `pnpm test:deploy-rollout` from the repo root)
#
# WHY THIS EXISTS — 2026-08-21, api + portal deploys were failing PLATFORM-WIDE for a whole
# morning and the platform was healthy the entire time. `DEPLOY_{API,PORTAL}_PUBLIC_VERIFY_RESOLVE_LOCAL=1`
# (set in the deploy worker's pm2 environment, in no file anywhere) makes the probe
# `curl --resolve host:443:127.0.0.1`, and nginx did not listen on 127.0.0.1:443. The probe could
# therefore never connect, logged `http_code=000`, and every rollout rolled a good deploy back.
#
# These tests stub `curl` so the fallback can be proven WITHOUT a server: the loopback path is
# preferred, ordinary DNS is the fallback, and only both failing is a real failure.
#
# ⛔ `curl` and `sleep` are stubbed as SHELL FUNCTIONS, which shadow the real binaries inside this
# process only. Nothing here touches the network.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PASS=0
FAIL=0

# --- stubs -------------------------------------------------------------------------------------
# deploy_common_log is provided by deploy-common.sh in production; the rollout scripts are sourced
# standalone here, so provide a capturing stub.
LOG_CAPTURE=""
deploy_common_log() { LOG_CAPTURE+="$*"$'\n'; }
deploy_common_log_timing() { :; }
deploy_common_stopwatch_start() { echo 0; }
deploy_common_stopwatch_elapsed_ms() { echo 0; }

sleep() { :; } # keep the test instant; the probe loops with `sleep "$delay"`

# CURL_OK_SPECS: newline-separated list of resolve specs that "work".
#   the literal token `dns` means "a call with no --resolve at all succeeds"
# CURL_CALLS: every invocation recorded as `<spec-or-dns> <url>`
CURL_OK_SPECS=""
CURL_CALLS=""
curl() {
  local spec="dns" url="" want_resolve=0 a
  for a in "$@"; do
    if [[ "$want_resolve" == 1 ]]; then spec="$a"; want_resolve=0; continue; fi
    case "$a" in
      --resolve) want_resolve=1 ;;
      http://*|https://*) url="$a" ;;
    esac
  done
  CURL_CALLS+="${spec} ${url}"$'\n'
  if printf '%s\n' "$CURL_OK_SPECS" | grep -qxF "$spec"; then
    # -w '%{http_code}' is used by the failure-diagnostic pass; emit a plausible code.
    [[ "$*" == *"%{http_code}"* ]] && printf '200'
    return 0
  fi
  [[ "$*" == *"%{http_code}"* ]] && printf '000'
  return 7 # curl(7) = failed to connect
}

reset_stub() {
  CURL_OK_SPECS="$1"
  CURL_CALLS=""
  LOG_CAPTURE=""
}

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '       %s\n' "$2"
  return 0
}

assert_rc() { # name expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1" "expected rc=$2 got rc=$3"; fi
}
assert_contains() { # name haystack needle
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else no "$1" "missing '$3' in: $(printf '%s' "$2" | tr '\n' '|')"; fi
}
assert_not_contains() { # name haystack needle
  if [[ "$2" != *"$3"* ]]; then ok "$1"; else no "$1" "unexpected '$3' in: $(printf '%s' "$2" | tr '\n' '|')"; fi
}

# --- subject under test ------------------------------------------------------------------------
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/deploy-api-rollout.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/deploy-portal-rollout.sh"
set +e # the sourced scripts turn on `set -e`; the tests deliberately call failing functions

URL_API="https://app.connectcomunications.com/api/health"
URL_PORTAL="https://app.connectcomunications.com/ready"
LOOPBACK_API="app.connectcomunications.com:443:127.0.0.1"

echo "deploy-api-rollout: public verify probe"

# 1. Loopback listener present -> preferred path is used, DNS is never tried.
export DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1
reset_stub "$LOOPBACK_API"
deploy_api_rollout_wait_ready "$URL_API" 3 0
assert_rc "loopback healthy -> success" 0 "$?"
assert_contains "loopback healthy -> probed 127.0.0.1" "$CURL_CALLS" "$LOOPBACK_API"
assert_not_contains "loopback healthy -> did NOT fall back to dns" "$CURL_CALLS" "dns "
assert_contains "loopback healthy -> logs which path won" "$LOG_CAPTURE" "public verify ok via ${LOOPBACK_API}"

# 2. THE REGRESSION: no 127.0.0.1:443 listener, public hostname healthy.
#    Before the 2026-08-21 fix this returned 1 and rolled a healthy deploy back.
reset_stub "dns"
deploy_api_rollout_wait_ready "$URL_API" 3 0
assert_rc "loopback dead + dns healthy -> success (was a rollback)" 0 "$?"
assert_contains "loopback dead -> still TRIED loopback first" "$CURL_CALLS" "$LOOPBACK_API"
assert_contains "loopback dead -> fell back to dns" "$CURL_CALLS" "dns ${URL_API}"
assert_contains "loopback dead -> logs the fallback" "$LOG_CAPTURE" "public verify ok via dns"

# 3. Genuinely unreachable both ways -> fail, and say so with BOTH codes.
reset_stub ""
deploy_api_rollout_wait_ready "$URL_API" 2 0
assert_rc "both paths dead -> failure" 1 "$?"
assert_contains "both dead -> reports loopback code" "$LOG_CAPTURE" "${LOOPBACK_API}=000"
assert_contains "both dead -> reports dns code" "$LOG_CAPTURE" "dns=000"
assert_contains "both dead -> explains 000" "$LOG_CAPTURE" "CONNECTION failure"

# 4. RESOLVE_LOCAL=0 -> plain DNS only, no --resolve ever.
export DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=0
reset_stub "dns"
deploy_api_rollout_wait_ready "$URL_API" 3 0
assert_rc "resolve_local=0 -> success via dns" 0 "$?"
assert_not_contains "resolve_local=0 -> never resolves to loopback" "$CURL_CALLS" "127.0.0.1"

# 5. The http:// candidate /ready probe must never get --resolve, even with the flag on.
export DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1
reset_stub "dns"
deploy_api_rollout_wait_ready "http://127.0.0.1:3004/ready" 3 0
assert_rc "http candidate probe -> success" 0 "$?"
assert_not_contains "http candidate probe -> no --resolve" "$CURL_CALLS" ":443:"

echo "deploy-portal-rollout: public verify probe"

# 6. Same regression on the portal side.
export DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=1
reset_stub "dns"
deploy_portal_rollout_wait_ready "$URL_PORTAL" 3 0
assert_rc "portal: loopback dead + dns healthy -> success" 0 "$?"
assert_contains "portal: tried loopback first" "$CURL_CALLS" "$LOOPBACK_API"
assert_contains "portal: fell back to dns" "$CURL_CALLS" "dns ${URL_PORTAL}"

# 7. Portal used to fail SILENTLY — it must now log a diagnostic like the api side.
reset_stub ""
deploy_portal_rollout_wait_ready "$URL_PORTAL" 2 0
assert_rc "portal: both paths dead -> failure" 1 "$?"
assert_contains "portal: failure is no longer silent" "$LOG_CAPTURE" "public verify probe failed"
assert_contains "portal: reports both codes" "$LOG_CAPTURE" "dns=000"

# 8. Portal honours resolve_local=0.
export DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=0
reset_stub "dns"
deploy_portal_rollout_wait_ready "$URL_PORTAL" 3 0
assert_rc "portal: resolve_local=0 -> success via dns" 0 "$?"
assert_not_contains "portal: resolve_local=0 -> no loopback" "$CURL_CALLS" "127.0.0.1"

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1
