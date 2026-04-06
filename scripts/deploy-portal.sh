#!/bin/sh
docker cp /tmp/liveCall.ts app-portal-1:/app/apps/portal/types/liveCall.ts
docker cp /tmp/dashboard_page.tsx "/app/apps/portal/app/(platform)/dashboard/page.tsx" 2>/dev/null || \
  docker exec app-portal-1 sh -c 'mkdir -p /app/apps/portal/app/\(platform\)/dashboard' && \
  docker cp /tmp/dashboard_page.tsx "app-portal-1:/app/apps/portal/app/(platform)/dashboard/page.tsx"
docker cp /tmp/calls_page.tsx "app-portal-1:/app/apps/portal/app/(platform)/calls/page.tsx"
docker cp /tmp/globals.css app-portal-1:/app/apps/portal/app/globals.css
echo "Portal files deployed"
