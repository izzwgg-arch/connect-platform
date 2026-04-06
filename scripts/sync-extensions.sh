#!/bin/bash
# Login and trigger extension sync
LOGIN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"support@connectcomunications.com","password":"'"$1"'"}')
TOKEN=$(echo "$LOGIN" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:40}..."
RESULT=$(curl -s -X POST "http://localhost:3001/admin/pbx/instances/cmmi7huxy0000qq3igj493o5q/sync-extensions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}')
echo "Sync result: $RESULT"
