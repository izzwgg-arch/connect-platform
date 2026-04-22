#!/bin/bash
echo "================================================================"
echo "PART 1: Recent CallFlightSessions from DB"
echo "================================================================"
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.callFlightSession.findMany({
  orderBy: { uploadedAt: 'desc' },
  take: 20
}).then(sessions => {
  if (sessions.length === 0) { console.log('NO_SESSIONS'); process.exit(0); }
  sessions.forEach(s => {
    const events = Array.isArray(s.events) ? s.events : [];
    const pushRx = events.find(e => e.stage && (e.stage.includes('PUSH_RECEIVED') || e.stage.includes('PUSH_RX')));
    const pushSent = events.find(e => e.stage && e.stage.includes('PUSH_SEND'));
    console.log('---');
    console.log('ID:', s.id);
    console.log('inviteId:', s.inviteId);
    console.log('result:', s.result);
    console.log('uploadedAt:', s.uploadedAt);
    console.log('events:', events.length);
    console.log('has_push_received:', !!pushRx);
    console.log('has_push_send:', !!pushSent);
    console.log('flags:', JSON.stringify(s.flags));
    console.log('summary:', s.aiSummary ? s.aiSummary.substring(0, 150) : 'none');
    console.log('first_5_events:', JSON.stringify(events.slice(0,5).map(e=>({stage:e.stage,ts:e.ts,cat:e.category}))));
  });
  process.exit(0);
}).catch(e => { console.error('DB_ERROR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "================================================================"
echo "PART 2: Backend PUSH_SEND logs (last 2 hours)"
echo "================================================================"
docker logs app-api-1 --since=2h 2>&1 | grep -E 'PUSH_SEND|push_send|CALL_TIMELINE.*PUSH|pushSent|sendPush|expo.*push|fcm.*send|notif.*send|ring_notify' | tail -40

echo ""
echo "================================================================"
echo "PART 3: Backend CALL_TIMELINE logs (last 2 hours)"
echo "================================================================"
docker logs app-api-1 --since=2h 2>&1 | grep -E 'CALL_TIMELINE|call_timeline|ring_notify|mobile_notify|invite_created|push_target' | tail -40

echo ""
echo "================================================================"
echo "PART 4: Worker logs (last 2 hours)"
echo "================================================================"
docker logs app-worker-1 --since=2h 2>&1 | grep -E 'PUSH|push|notify|invite|ring' | tail -40

echo ""
echo "================================================================"
echo "PART 5: Device tokens in DB for ext 103"
echo "================================================================"
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.mobileDevice.findMany({
  where: { OR: [{ user: { extensions: { some: { extension: '103' } } } }, {}] },
  take: 5,
  orderBy: { updatedAt: 'desc' },
  select: {
    id: true,
    platform: true,
    expoPushToken: true,
    deviceName: true,
    updatedAt: true,
    userId: true,
    tenantId: true,
    user: { select: { email: true } }
  }
}).then(devices => {
  if (devices.length === 0) console.log('NO_DEVICES_FOUND');
  devices.forEach(d => {
    const tok = d.expoPushToken || '';
    console.log(JSON.stringify({
      id: d.id,
      platform: d.platform,
      tokenTail: tok.slice(-20),
      tokenFull: tok,
      deviceName: d.deviceName,
      updatedAt: d.updatedAt,
      userId: d.userId,
      tenantId: d.tenantId,
      email: d.user?.email
    }));
  });
  process.exit(0);
}).catch(e => { console.error('DB_ERROR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "================================================================"
echo "PART 6: All MobileDevices in DB"
echo "================================================================"
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.mobileDevice.findMany({
  orderBy: { updatedAt: 'desc' },
  take: 10,
  select: {
    id: true,
    platform: true,
    expoPushToken: true,
    deviceName: true,
    updatedAt: true,
    userId: true,
    tenantId: true
  }
}).then(devices => {
  console.log('TOTAL_DEVICES:', devices.length);
  devices.forEach(d => {
    const tok = d.expoPushToken || '';
    console.log(JSON.stringify({
      id: d.id,
      platform: d.platform,
      tokenPrefix: tok.slice(0, 30),
      tokenTail: tok.slice(-20),
      deviceName: d.deviceName,
      updatedAt: d.updatedAt,
      userId: d.userId,
      tenantId: d.tenantId
    }));
  });
  process.exit(0);
}).catch(e => { console.error('DB_ERROR:', e.message); process.exit(1); });
" 2>&1
