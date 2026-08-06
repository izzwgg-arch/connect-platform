#!/usr/bin/env bash
# ── ivr-stress — prove the IVR Studio end-to-end, repeatedly ────────────────
#
# Drives REAL config changes through the production API path (the internal
# agent door, which applies the change AND publishes exactly like the Studio's
# Publish button), then places a REAL call into the live inbound route and
# asserts what the caller actually got from the Asterisk log.
#
# This exists because every failure in this system has been a disagreement
# between what the database says and what a caller hears. Only the call counts.
#
# Usage: ivr-stress.sh <rounds>
# Env:   API=http://127.0.0.1:3001  SECRET=<AGENT_INTERNAL_SECRET>
#        TENANT=<connect tenant id> PROFILE=<menu id> DID=<digits>
set -uo pipefail

ROUNDS="${1:-3}"
API="${API:?}"; SECRET="${SECRET:?}"; TENANT="${TENANT:?}"; PROFILE="${PROFILE:?}"; DID="${DID:?}"
PASS=0; FAIL=0
declare -a FAILURES=()

agent() { # action json-fragment
  curl -s -m 120 -X POST "$API/internal/agent/ivr/action" \
    -H "x-agent-internal-secret: $SECRET" -H "content-type: application/json" \
    -d "{\"tenantId\":\"$TENANT\",\"profileId\":\"$PROFILE\",\"agentActionId\":\"stress-$(date +%s%N)\",$1}"
}

check() { # label expect-regex [keys]
  local label="$1" expect="$2" keys="${3:-}"
  local out
  out=$(bash /root/ivr-e2e.sh "$DID" "$expect" "$keys" 12 2>&1)
  if echo "$out" | grep -q "^PASS"; then
    PASS=$((PASS+1)); echo "  ✓ $label"
  else
    FAIL=$((FAIL+1)); FAILURES+=("$label")
    echo "  ✗ $label"; echo "$out" | sed 's/^/      /' | head -12
  fi
}

for r in $(seq 1 "$ROUNDS"); do
  echo "── round $r/$ROUNDS ─────────────────────────────"

  for pair in "$GREETING_A" "$GREETING_B"; do
    resp=$(agent "\"action\":\"set_prompt\",\"promptSlot\":\"greeting\",\"promptRef\":\"$pair\"")
    if ! echo "$resp" | grep -q '"ok":true'; then
      FAIL=$((FAIL+1)); FAILURES+=("set greeting $pair"); echo "  ✗ set greeting $pair -> $(echo "$resp" | head -c 200)"
      continue
    fi
    base=${pair#custom/}
    check "greeting change takes effect: $pair" "(BackGround|Background|Playback)\(\"?$base" ""
  done

  # A key the menu does not define must re-prompt, never dead-air or hang up.
  check "undefined key re-prompts (invalid path)" "connect-menu" "9"

  # No input must reach the timeout path and stay in the menu.
  check "no input stays in the menu (timeout path)" "WaitExten" ""
done

echo "════════════════════════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then printf 'failed: %s\n' "${FAILURES[@]}"; exit 1; fi
echo "ALL GREEN"
