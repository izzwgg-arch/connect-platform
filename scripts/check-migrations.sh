#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.app.yml"

log(){ echo "[check-migrations] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

cd "$REPO_ROOT"

EXPECTED_MIGRATION="$(ls -1 packages/db/prisma/migrations | grep -E '^[0-9]{14}_.+' | sort | tail -n1 || true)"
[[ -n "$EXPECTED_MIGRATION" ]] || fail "No versioned migration directories found in packages/db/prisma/migrations"

log "expected latest migration: ${EXPECTED_MIGRATION}"

if ! /opt/connectcomms/ops/run-heavy.sh "check-migrations:prisma-status" -- docker compose -f "$COMPOSE_FILE" exec -T api sh -lc 'cd /app && pnpm --filter @connect/db exec prisma migrate status --schema prisma/schema.prisma' >/tmp/check-migrations-status.txt 2>/tmp/check-migrations-status.err; then
  cat /tmp/check-migrations-status.err >&2 || true
  fail "Unable to run prisma migrate status inside api container (DB may be unreachable or api not ready)"
fi

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"

if ! docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'select 1;' >/dev/null; then
  fail "database is not reachable via psql"
fi

LATEST_APPLIED="$(docker exec -i "$PG_CONTAINER" psql -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1;' | tr -d '\r')"
CHECK_SQL="SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='${EXPECTED_MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;"
IS_EXPECTED_APPLIED="$(docker exec -i "$PG_CONTAINER" psql -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$CHECK_SQL" | tr -d '\r')"

log "latest applied migration in DB: ${LATEST_APPLIED:-<none>}"
log "expected latest migration in repo: ${EXPECTED_MIGRATION}"

if [[ "${IS_EXPECTED_APPLIED}" != "1" ]]; then
  fail "DB schema is behind: expected migration '${EXPECTED_MIGRATION}' is not applied"
fi

log "PASS: expected migration is applied"
