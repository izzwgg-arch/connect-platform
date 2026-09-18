#!/bin/bash
export PGPASSWORD='<REDACTED-legacy-trimpro-db-password-2026-09-18>'
echo "Total local clients:"
psql -h localhost -U trimpro_user -d trimpro -t -A -c "SELECT count(*) FROM clients"
echo "Unique QB IDs mapped (import):"
psql -h localhost -U trimpro_user -d trimpro -t -A -c 'SELECT count(DISTINCT "qboId") FROM quickbooks_sync_logs WHERE type='"'"'client'"'"' AND status='"'"'success'"'"' AND "qboId" IS NOT NULL'
echo "Unique local IDs in sync logs:"
psql -h localhost -U trimpro_user -d trimpro -t -A -c 'SELECT count(DISTINCT "entityId") FROM quickbooks_sync_logs WHERE type='"'"'client'"'"' AND status='"'"'success'"'"' AND "entityId" IS NOT NULL'
echo "Latest 5 errors in sync logs:"
psql -h localhost -U trimpro_user -d trimpro -t -A -c 'SELECT error FROM quickbooks_sync_logs WHERE type='"'"'client'"'"' AND status='"'"'error'"'"' ORDER BY "createdAt" DESC LIMIT 5'
