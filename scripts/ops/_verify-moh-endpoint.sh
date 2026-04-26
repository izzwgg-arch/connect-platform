#!/usr/bin/env bash
set -uo pipefail

# Verify the new /voice/moh/pbx-classes behaviour on production.
# Drives the API directly via the api-container (loopback, no auth needed for
# this local inspection: we query Prisma through a small node script, since the
# HTTP endpoint requires an authenticated user session).

docker cp /tmp/qmoh-endpoint.js app-api-1:/app/apps/api/qmoh-endpoint.js
docker exec -w /app/apps/api app-api-1 node qmoh-endpoint.js
