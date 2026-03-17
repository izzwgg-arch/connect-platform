#!/usr/bin/env bash
# Deploy (or redeploy) the telephony service on the ConnectComms server.
# Run from the project root on the server: bash scripts/deploy-telephony.sh
set -euo pipefail

SERVER_IP="45.14.194.179"
COMPOSE_FILE="docker-compose.app.yml"
SERVICE="telephony"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "Building $SERVICE..."
docker compose -f "$COMPOSE_FILE" build "$SERVICE"

log "Stopping existing $SERVICE container (if running)..."
docker compose -f "$COMPOSE_FILE" stop "$SERVICE" || true
docker compose -f "$COMPOSE_FILE" rm -f "$SERVICE" || true

log "Starting $SERVICE..."
docker compose -f "$COMPOSE_FILE" up -d "$SERVICE"

log "Waiting for $SERVICE to become healthy..."
for i in $(seq 1 15); do
  sleep 2
  STATUS=$(docker compose -f "$COMPOSE_FILE" ps --format json "$SERVICE" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('State','?'))" 2>/dev/null || echo "?")
  if [ "$STATUS" = "running" ]; then
    log "$SERVICE is running."
    break
  fi
  log "  Attempt $i/15: state=$STATUS"
done

log "Health check..."
curl -sf "http://127.0.0.1:3003/health" | python3 -m json.tool || log "WARNING: health endpoint not yet ready"

log "Done. Logs: docker compose -f $COMPOSE_FILE logs -f $SERVICE"
