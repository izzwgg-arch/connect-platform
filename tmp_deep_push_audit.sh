#!/bin/bash
echo "================================================================"
echo "PART A: Full session events for cfs_mo55lws2_jmknw"
echo "================================================================"
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.callFlightSession.findUnique({ where: { id: 'cfs_mo55lws2_jmknw' } }).then(s => {
  if (!s) { console.log('NOT_FOUND'); process.exit(0); }
  console.log('inviteId:', s.inviteId);
  console.log('result:', s.result);
  console.log('deviceInfo:', JSON.stringify(s.deviceInfo));
  console.log('appState:', JSON.stringify(s.appState));
  console.log('pushState:', JSON.stringify(s.pushState));
  const events = Array.isArray(s.events) ? s.events : [];
  console.log('total events:', events.length);
  events.forEach((e,i) => console.log('EVENT['+i+']:', JSON.stringify(e)));
  process.exit(0);
}).catch(e => { console.error('ERR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "================================================================"
echo "PART B: Backend push logs with full context (last 2h)"
echo "================================================================"
docker logs app-api-1 --since=2h 2>&1 | grep -B3 -A3 'expo accepted\|expo.*push\|push.*expo\|ring_notify\|INCOMING_CALL\|fcm\|push.*token\|token.*push\|mobile-push' | grep -v 'metrics\|health\|heartbeat' | head -80

echo ""
echo "================================================================"
echo "PART C: Invite creation logs (last 2h)"  
echo "================================================================"
docker logs app-api-1 --since=2h 2>&1 | grep -E 'invite.*creat|call.*invite|incoming.*call|INVITE|invite_id|inviteId|ring.*notify|call-invite' | grep -v 'metrics\|health' | tail -30

echo ""
echo "================================================================"
echo "PART D: Worker service logs (ALL since restart)"
echo "================================================================"
docker logs app-worker-1 2>&1 | tail -50

echo ""
echo "================================================================"
echo "PART E: Expo push token from device vs DB"  
echo "================================================================"
echo "=== DB Token (SM-S921U, most recent) ==="
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.mobileDevice.findFirst({
  where: { deviceName: 'SM-S921U' },
  orderBy: { updatedAt: 'desc' }
}).then(d => {
  if (!d) { console.log('DEVICE_NOT_FOUND'); process.exit(0); }
  console.log('FULL_TOKEN:', d.expoPushToken);
  console.log('updatedAt:', d.updatedAt);
  console.log('userId:', d.userId);
  console.log('tenantId:', d.tenantId);
  process.exit(0);
}).catch(e => { console.error('ERR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "=== Device ADB token (from logcat or storage) ==="

echo ""
echo "================================================================"
echo "PART F: CallInvite records in DB — recent"
echo "================================================================"
docker exec app-api-1 node -e "
const { PrismaClient } = require('/app/packages/db/node_modules/@prisma/client');
const db = new PrismaClient();
db.callInvite.findMany({
  orderBy: { createdAt: 'desc' },
  take: 15,
  select: {
    id: true,
    status: true,
    createdAt: true,
    expiresAt: true,
    userId: true,
    tenantId: true,
    toExtension: true,
    fromNumber: true,
    pbxCallId: true,
    pushSentAt: true,
    answeredAt: true
  }
}).then(invites => {
  if (invites.length === 0) { console.log('NO_INVITES'); process.exit(0); }
  invites.forEach(inv => console.log(JSON.stringify(inv)));
  process.exit(0);
}).catch(e => { console.error('ERR:', e.message); process.exit(1); });
" 2>&1

echo ""
echo "================================================================"
echo "PART G: Recent push send audit from API (all push-related)"
echo "================================================================"
docker logs app-api-1 --since=2h 2>&1 | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    try:
        obj = json.loads(line)
        msg = str(obj.get('msg',''))
        if any(k in msg.lower() for k in ['push','ring','notify','invite','expo','fcm','token']):
            print(line)
    except:
        if any(k in line.lower() for k in ['push','ring_notify','expo','fcm','mobile-push']):
            print(line)
" 2>&1 | head -60
