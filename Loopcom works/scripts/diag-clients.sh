#!/bin/bash
export PGPASSWORD='<REDACTED-legacy-trimpro-db-password-2026-09-18>'
DB="psql -h localhost -U trimpro_user -d trimpro -t -A"

echo "=== CLIENT COUNTS ==="
echo "Total local clients:"
$DB -c "SELECT count(*) FROM clients"
echo "QB import success logs:"
$DB -c "SELECT count(*) FROM quickbooks_sync_logs WHERE type='client' AND action='import' AND status='success'"
echo "QB import error logs:"
$DB -c "SELECT count(*) FROM quickbooks_sync_logs WHERE type='client' AND action='import' AND status='error'"
echo "Latest import errors:"
$DB -c "SELECT error FROM quickbooks_sync_logs WHERE type='client' AND status='error' ORDER BY created_at DESC LIMIT 5"
echo "Unique QB IDs mapped to local clients:"
$DB -c "SELECT count(DISTINCT qbo_id) FROM quickbooks_sync_logs WHERE type='client' AND status='success' AND qbo_id IS NOT NULL"
