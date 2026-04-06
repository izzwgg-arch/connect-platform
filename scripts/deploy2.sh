#!/bin/sh
CALLS_PATH='/app/apps/portal/app/(platform)/calls/page.tsx'
docker cp /tmp/calls_page.tsx "app-portal-1:${CALLS_PATH}"
docker cp /tmp/globals.css app-portal-1:/app/apps/portal/app/globals.css
echo "done"
