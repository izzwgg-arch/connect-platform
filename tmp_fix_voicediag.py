#!/usr/bin/env python3
"""
Fix /voice/diag/event: wrap db.voiceDiagEvent.create in a try/catch so
unknown enum values (e.g. UI_SHOWN not yet in DB) don't crash the endpoint.
"""
import shutil

SERVER = '/opt/connectcomms/app/apps/api/src/server.ts'

with open(SERVER, 'r', encoding='utf-8') as f:
    content = f.read()

OLD = '''  const payload = sanitizeDiagPayload(input.payload || {});
  const event = await db.voiceDiagEvent.create({
    data: {
      tenantId: user.tenantId,
      userId: user.sub,
      sessionId: session.id,
      type: input.type,
      payload: payload as any
    }
  });'''

NEW = '''  const payload = sanitizeDiagPayload(input.payload || {});
  let event: any;
  try {
    event = await db.voiceDiagEvent.create({
      data: {
        tenantId: user.tenantId,
        userId: user.sub,
        sessionId: session.id,
        type: input.type as any,
        payload: payload as any
      }
    });
  } catch (diagCreateErr: any) {
    // Unknown event type not yet in DB enum — log and continue rather than return 500
    app.log.warn({ type: input.type, err: diagCreateErr?.message }, "voice_diag_event: unknown type, skipped");
    return reply.send({ ok: true, note: "event_type_not_in_schema" });
  }'''

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    print('FIXED: voice/diag/event now handles unknown event types gracefully')
else:
    print('WARNING: could not find the exact pattern. Trying broader search...')
    idx = content.find('const event = await db.voiceDiagEvent.create(')
    if idx >= 0:
        print('Found at:', idx, 'line ~', content[:idx].count('\n')+1)
        print(repr(content[idx-100:idx+300]))

shutil.copy2(SERVER, SERVER + '.bak_fix3')
with open(SERVER, 'w', encoding='utf-8') as f:
    f.write(content)
print('WRITTEN')

# Verify
with open(SERVER, 'r') as f:
    out = f.read()
verify_idx = out.find('event_type_not_in_schema')
print('Verification:', 'FOUND' if verify_idx >= 0 else 'NOT FOUND')
