#!/bin/bash
echo "=== All CallFlightSessions in DB ==="
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.callFlightSession.findMany({ orderBy: { uploadedAt: 'desc' }, take: 10 }).then(sessions => {
  if (sessions.length === 0) { console.log('NO_SESSIONS_IN_DB'); }
  sessions.forEach(s => console.log('SESSION:', JSON.stringify({
    id: s.id,
    inviteId: s.inviteId,
    result: s.result,
    uploadedAt: s.uploadedAt,
    events: s.events?.length || 0
  })));
  process.exit(0);
}).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
" 2>&1

echo "=== Recent API upload requests ==="
docker logs app-api-1 --since=5m 2>&1 | grep 'flight-recorder/upload' | cat
