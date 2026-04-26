#!/usr/bin/env bash
set -euo pipefail
CONTAINER="${1:-app-portal-1}"

echo "=== container status ==="
docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo
echo "=== git HEAD in image ==="
docker exec "$CONTAINER" sh -c 'head -1 /app/.git/HEAD 2>/dev/null || echo no-git-in-image'
echo
echo "=== MohClassPicker grouping markers ==="
docker exec "$CONTAINER" sh -c '
  F="apps/portal/app/(platform)/pbx/moh-scheduling/page.tsx"
  echo "file size: $(wc -l "$F" | awk '\''{print $1}'\'') lines"
  echo "markers:"
  echo "  System (available to all tenants) : $(grep -c "System (available to all tenants)" "$F" 2>/dev/null || echo 0)"
  echo "  Other tenants on this PBX         : $(grep -c "Other tenants on this PBX" "$F" 2>/dev/null || echo 0)"
  echo "  Refresh from PBX                  : $(grep -c "Refresh from PBX" "$F" 2>/dev/null || echo 0)"
  echo "  Show all tenants                  : $(grep -c "Show all tenants" "$F" 2>/dev/null || echo 0)"
  echo "  includeAll query                  : $(grep -c "includeAll=1" "$F" 2>/dev/null || echo 0)"
'
