#!/usr/bin/env python3
"""
Enhance mobile-ring-notify logs with structured push diagnostic events:
- PUSH_TARGET_RESOLVED: when we successfully find the extension owner
- PUSH_TARGET_NOT_FOUND: when no owner found (already logged, improve detail)
- PUSH_SEND_ATTEMPT: before sending to Expo
- PUSH_SEND_ZERO_DEVICES: if no device tokens found
- PUSH_SEND_SUCCESS / PUSH_SEND_PROVIDER_ERROR: after provider response
"""
import shutil

SERVER = '/opt/connectcomms/app/apps/api/src/server.ts'

with open(SERVER, 'r', encoding='utf-8') as f:
    content = f.read()

# ─── 1. Add PUSH_TARGET_RESOLVED log after target is resolved ─────────────────
OLD_TARGET_FOUND = '''  if (!target) {
    app.log.warn(
      { linkedId: input.linkedId, toExtension: input.toExtension, connectTenantId: input.connectTenantId },
      "mobile-ring-notify: extension owner not found — no push sent"
    );
    return { ok: false, reason: "TARGET_NOT_FOUND" };
  }'''

NEW_TARGET_FOUND = '''  if (!target) {
    app.log.warn(
      { linkedId: input.linkedId, toExtension: input.toExtension, connectTenantId: input.connectTenantId,
        diagnostic: "PUSH_TARGET_NOT_FOUND" },
      "mobile-ring-notify: extension owner not found — no push sent"
    );
    return { ok: false, reason: "TARGET_NOT_FOUND" };
  }
  app.log.info(
    { linkedId: input.linkedId, toExtension: input.toExtension, tenantId: target.tenantId,
      userId: target.userId, extensionId: target.extensionId, diagnostic: "PUSH_TARGET_RESOLVED" },
    "mobile-ring-notify: PUSH_TARGET_RESOLVED"
  );'''

if OLD_TARGET_FOUND in content:
    content = content.replace(OLD_TARGET_FOUND, NEW_TARGET_FOUND, 1)
    print('FIXED: added PUSH_TARGET_RESOLVED log')
else:
    print('WARNING: could not find target not found block')

# ─── 2. Add PUSH_SEND_ATTEMPT and better response logging ─────────────────────
OLD_PUSH_SEND = '''  // ── Send Expo push to all registered devices for this user ───────────────────
  const push = await sendPushToUserDevices({'''

NEW_PUSH_SEND = '''  // ── Send Expo push to all registered devices for this user ───────────────────
  app.log.info(
    { inviteId: invite.id, userId: target.userId, tenantId: target.tenantId,
      diagnostic: "PUSH_SEND_ATTEMPT" },
    "mobile-ring-notify: PUSH_SEND_ATTEMPT"
  );
  const push = await sendPushToUserDevices({'''

if OLD_PUSH_SEND in content:
    content = content.replace(OLD_PUSH_SEND, NEW_PUSH_SEND, 1)
    print('FIXED: added PUSH_SEND_ATTEMPT log')
else:
    print('WARNING: could not find sendPushToUserDevices call')

# ─── 3. Enhance push sent log with PUSH_SEND_SUCCESS / PUSH_SEND_ZERO_DEVICES ──
OLD_PUSH_SENT = '''  app.log.info(
    { inviteId: invite.id, tenantId: target.tenantId, userId: target.userId, push },
    "mobile-ring-notify: push sent"
  );'''

NEW_PUSH_SENT = '''  const pushedCount = push?.queued ?? 0;
  if (pushedCount === 0) {
    app.log.warn(
      { inviteId: invite.id, tenantId: target.tenantId, userId: target.userId, push,
        diagnostic: "PUSH_SEND_ZERO_DEVICES" },
      "mobile-ring-notify: PUSH_SEND_ZERO_DEVICES — no device tokens for this user"
    );
  } else {
    app.log.info(
      { inviteId: invite.id, tenantId: target.tenantId, userId: target.userId, push,
        deviceCount: pushedCount, diagnostic: "PUSH_SEND_SUCCESS" },
      "mobile-ring-notify: PUSH_SEND_SUCCESS"
    );
  }
  app.log.info(
    { inviteId: invite.id, tenantId: target.tenantId, userId: target.userId, push },
    "mobile-ring-notify: push sent"
  );'''

if OLD_PUSH_SENT in content:
    content = content.replace(OLD_PUSH_SENT, NEW_PUSH_SENT, 1)
    print('FIXED: added PUSH_SEND_SUCCESS / PUSH_SEND_ZERO_DEVICES log')
else:
    print('WARNING: could not find push sent log')

shutil.copy2(SERVER, SERVER + '.bak_fix4')
with open(SERVER, 'w', encoding='utf-8') as f:
    f.write(content)
print('WRITTEN')

# Verify
with open(SERVER, 'r') as f:
    out = f.read()
for marker in ['PUSH_TARGET_RESOLVED', 'PUSH_SEND_ATTEMPT', 'PUSH_SEND_ZERO_DEVICES', 'PUSH_SEND_SUCCESS']:
    found = marker in out
    print(f'{marker}: {"FOUND" if found else "MISSING"}')
