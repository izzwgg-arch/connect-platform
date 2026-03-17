#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ConnectComms — TURN server diagnostics
# Run on the backend server (45.14.194.179) or any host with network access.
# Usage: bash scripts/test-turn.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TURN_HOST="${TURN_SERVER:-45.14.194.179}"
TURN_PORT="${TURN_PORT:-3478}"
TURNS_PORT="${TURNS_PORT:-5349}"
API_URL="${API_URL:-http://127.0.0.1:3001}"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; ((PASS++)) || true; }
fail() { echo -e "  ${RED}✗${RESET} $1"; ((FAIL++)) || true; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
info() { echo -e "  ${CYAN}i${RESET} $1"; }

echo ""
echo "══════════════════════════════════════════════════"
echo "  ConnectComms TURN Server Diagnostics"
echo "  Host: $TURN_HOST"
echo "══════════════════════════════════════════════════"
echo ""

# ── 1. coturn process ─────────────────────────────────────────────────────
echo "1. coturn service"
if command -v systemctl &>/dev/null; then
  if systemctl is-active --quiet coturn 2>/dev/null; then
    ok "coturn service is active"
  else
    fail "coturn service is NOT running"
    info "Start with: systemctl start coturn"
    info "Check logs: journalctl -u coturn -n 30"
  fi
else
  warn "systemctl not available — skipping service check"
fi
echo ""

# ── 2. TURN UDP port 3478 ─────────────────────────────────────────────────
echo "2. Port reachability"
if command -v nc &>/dev/null; then
  if nc -zvu "$TURN_HOST" "$TURN_PORT" 2>/dev/null; then
    ok "TURN UDP $TURN_HOST:$TURN_PORT reachable"
  else
    fail "TURN UDP $TURN_HOST:$TURN_PORT NOT reachable"
    info "Check firewall: ufw allow $TURN_PORT/udp"
  fi
else
  warn "netcat (nc) not installed — skipping UDP port check"
fi

if command -v curl &>/dev/null; then
  if curl -s --connect-timeout 3 "http://$TURN_HOST:$TURN_PORT" -o /dev/null 2>/dev/null || \
     timeout 3 bash -c "echo > /dev/tcp/$TURN_HOST/$TURN_PORT" 2>/dev/null; then
    ok "TURN TCP $TURN_HOST:$TURN_PORT reachable"
  else
    fail "TURN TCP $TURN_HOST:$TURN_PORT NOT reachable"
    info "Check firewall: ufw allow $TURN_PORT/tcp"
  fi
fi
echo ""

# ── 3. TURN config file ───────────────────────────────────────────────────
echo "3. coturn configuration"
CONF="/etc/turnserver.conf"
if [[ -f "$CONF" ]]; then
  ok "$CONF exists"
  REALM_VAL="$(grep -E '^realm=' "$CONF" | head -1 | cut -d= -f2 || true)"
  LT_CRED="$(grep -c '^lt-cred-mech' "$CONF" || true)"
  FINGERPRINT="$(grep -c '^fingerprint' "$CONF" || true)"
  [[ -n "$REALM_VAL" ]] && ok "realm=$REALM_VAL" || fail "realm not set in config"
  [[ "$LT_CRED" -gt 0 ]] && ok "lt-cred-mech enabled" || fail "lt-cred-mech not enabled"
  [[ "$FINGERPRINT" -gt 0 ]] && ok "fingerprint enabled" || warn "fingerprint not set"
  # Check relay port range
  MIN_PORT="$(grep -E '^min-port=' "$CONF" | cut -d= -f2 || true)"
  MAX_PORT="$(grep -E '^max-port=' "$CONF" | cut -d= -f2 || true)"
  if [[ -n "$MIN_PORT" && -n "$MAX_PORT" ]]; then
    ok "relay port range: $MIN_PORT–$MAX_PORT"
  else
    warn "relay port range not set in config"
  fi
else
  fail "$CONF not found — run scripts/install-turn.sh first"
fi
echo ""

# ── 4. Environment variables ──────────────────────────────────────────────
echo "4. API environment variables"
ENV_FILE="/opt/connectcomms/app/.env"
if [[ -f "$ENV_FILE" ]]; then
  TS="$(grep '^TURN_SERVER=' "$ENV_FILE" | cut -d= -f2 || true)"
  TU="$(grep '^TURN_USERNAME=' "$ENV_FILE" | cut -d= -f2 || true)"
  TP="$(grep '^TURN_PASSWORD=' "$ENV_FILE" | cut -d= -f2 || true)"
  [[ -n "$TS" ]] && ok "TURN_SERVER=$TS" || fail "TURN_SERVER not set in $ENV_FILE"
  [[ -n "$TU" ]] && ok "TURN_USERNAME=$TU" || fail "TURN_USERNAME not set in $ENV_FILE"
  [[ -n "$TP" ]] && ok "TURN_PASSWORD=(set, ${#TP} chars)" || fail "TURN_PASSWORD not set in $ENV_FILE"
else
  warn "$ENV_FILE not found — checking container env..."
  CONTAINER_TS="$(docker exec app-api-1 env 2>/dev/null | grep '^TURN_SERVER=' | cut -d= -f2 || true)"
  CONTAINER_TU="$(docker exec app-api-1 env 2>/dev/null | grep '^TURN_USERNAME=' | cut -d= -f2 || true)"
  CONTAINER_TP="$(docker exec app-api-1 env 2>/dev/null | grep '^TURN_PASSWORD=' | cut -d= -f2 || true)"
  [[ -n "$CONTAINER_TS" ]] && ok "TURN_SERVER=$CONTAINER_TS (in container)" || fail "TURN_SERVER not in API container"
  [[ -n "$CONTAINER_TU" ]] && ok "TURN_USERNAME=$CONTAINER_TU (in container)" || fail "TURN_USERNAME not in API container"
  [[ -n "$CONTAINER_TP" ]] && ok "TURN_PASSWORD=(set, ${#CONTAINER_TP} chars, in container)" || fail "TURN_PASSWORD not in API container"
fi
echo ""

# ── 5. API health endpoint ────────────────────────────────────────────────
echo "5. API WebRTC health"
HEALTH_RESP="$(curl -s --connect-timeout 3 "$API_URL/voice/webrtc/health" 2>/dev/null || true)"
if [[ -z "$HEALTH_RESP" ]]; then
  warn "API not reachable at $API_URL (may require auth token — try with Bearer token)"
elif echo "$HEALTH_RESP" | grep -q '"turnConfigured":true'; then
  ok "API reports turnConfigured: true"
elif echo "$HEALTH_RESP" | grep -q '"turnConfigured":false'; then
  fail "API reports turnConfigured: false"
  info "Set TURN_SERVER, TURN_USERNAME, TURN_PASSWORD in .env and restart API"
elif echo "$HEALTH_RESP" | grep -q '"error"'; then
  warn "API returned error (endpoint may require JWT auth): $HEALTH_RESP"
else
  info "API response: $HEALTH_RESP"
fi
echo ""

# ── 6. Firewall check (UFW) ───────────────────────────────────────────────
echo "6. Firewall (UFW)"
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  UFW_STATUS="$(ufw status 2>/dev/null)"
  echo "$UFW_STATUS" | grep -q "3478" && ok "3478 open in UFW" || warn "3478 not found in UFW rules — run: ufw allow 3478/udp && ufw allow 3478/tcp"
  echo "$UFW_STATUS" | grep -q "5349" && ok "5349 open in UFW" || warn "5349 not found in UFW rules — run: ufw allow 5349/tcp"
  echo "$UFW_STATUS" | grep -q "49152" && ok "49152:65535/udp relay range open" || warn "Relay ports not found — run: ufw allow 49152:65535/udp"
else
  warn "UFW not active — verify iptables or cloud security group rules manually"
fi
echo ""

# ── 7. Summary ────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}All checks passed — TURN server looks good.${RESET}"
  echo ""
  echo "  Next: open the browser phone and verify:"
  echo "    ICE diagnostics show 'TURN: available'"
  echo "    https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
  echo "    Add: turn:45.14.194.179:3478 user/pass and confirm relay candidates"
else
  echo -e "  ${RED}$FAIL check(s) failed — review output above.${RESET}"
fi
echo "══════════════════════════════════════════════════"
echo ""
