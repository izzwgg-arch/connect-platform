#!/bin/bash
echo "=== All sessions ordered by upload time ==="
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.callFlightSession.findMany({
  orderBy: { uploadedAt: 'desc' },
  take: 10
}).then(sessions => {
  sessions.forEach(s => {
    const events = Array.isArray(s.events) ? s.events : [];
    const stages = events.map(e => e.stage);
    console.log('---');
    console.log('id:', s.id);
    console.log('inviteId:', s.inviteId);
    console.log('result:', s.result);
    console.log('uploadedAt:', s.uploadedAt);
    console.log('events:', events.length, '| stages:', stages.join(' → '));
    console.log('warningFlags:', JSON.stringify(s.warningFlags));
  });
  process.exit(0);
}).catch(e => { console.error('ERR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "=== Full events for most recent session ==="
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.callFlightSession.findFirst({
  orderBy: { uploadedAt: 'desc' },
  where: { id: { not: 'test_cfs_synthetic_001' } }
}).then(s => {
  if (!s) { console.log('NO_SESSION'); process.exit(0); }
  console.log('id:', s.id, '| inviteId:', s.inviteId, '| result:', s.result);
  const events = Array.isArray(s.events) ? s.events : [];
  events.forEach((e,i) => console.log('['+i+']', e.stage, '|', e.category, '|', e.ts, '|', JSON.stringify(e.payload || {})));
  process.exit(0);
}).catch(e => { console.error('ERR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "=== API logs — PUSH events since last restart ==="
docker logs app-api-1 --since=30m 2>&1 | grep -E 'PUSH_SEND_SUCCESS|PUSH_TARGET_RESOLVED|PUSH_SEND_ATTEMPT|PUSH_SEND_ZERO|flight-recorder/upload' | tail -20
