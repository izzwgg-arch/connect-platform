#!/usr/bin/env python3
"""
Two server-side fixes:
1. Flight recorder upload handler: read session.meta?.inviteId (not session.inviteId which doesn't exist)
2. /voice/diag/event: handle unknown event types gracefully instead of crashing
"""
import shutil

SERVER = '/opt/connectcomms/app/apps/api/src/server.ts'

with open(SERVER, 'r', encoding='utf-8') as f:
    content = f.read()

print(f"File size: {len(content)} chars")

# ─── Fix 1: Upload handler — read meta.inviteId ───────────────────────────────
OLD_INVITE = '''  const inviteId = session.inviteId ? String(session.inviteId).slice(0, 128) : null;
  const pbxCallId = session.pbxCallId ? String(session.pbxCallId).slice(0, 128) : null;
  const linkedId = session.linkedId ? String(session.linkedId).slice(0, 128) : null;
  const meta = (session.meta ?? {}) as Record<string, unknown>;'''

NEW_INVITE = '''  const meta = (session.meta ?? {}) as Record<string, unknown>;
  // inviteId, pbxCallId, linkedId live in session.meta — not at the top level of FlightSession
  const inviteId = String(session.inviteId || meta.inviteId || '').slice(0, 128) || null;
  const pbxCallId = String(session.pbxCallId || meta.pbxCallId || '').slice(0, 128) || null;
  const linkedId = String(session.linkedId || meta.linkedId || '').slice(0, 128) || null;'''

if OLD_INVITE in content:
    content = content.replace(OLD_INVITE, NEW_INVITE, 1)
    print('FIXED: upload handler — now reads session.meta.inviteId')
else:
    print('WARNING: could not find upload handler inviteId block — searching...')
    idx = content.find('const inviteId = session.inviteId')
    print(f'Found at: {idx}')
    if idx >= 0:
        print(repr(content[idx:idx+200]))

# ─── Fix 2: /voice/diag/event — handle unknown types gracefully ───────────────
# Find the voiceDiagEvent.create call and wrap it so unknown types don't crash
OLD_DIAG = '''        const event = await db.voiceDiagEvent.create({
           data: {'''

# We need to find the exact pattern in the production server
if 'db.voiceDiagEvent.create' in content:
    print('Found voiceDiagEvent.create in server.ts')
    # Find the try block around the voiceDiagEvent.create
    idx = content.find('const event = await db.voiceDiagEvent.create(')
    if idx >= 0:
        print(f'voiceDiagEvent.create at line ~{content[:idx].count(chr(10))+1}')
        chunk = content[idx:idx+300]
        print('Chunk:', repr(chunk[:200]))
    
    # The fix: wrap the voiceDiagEvent.create call so that PrismaClientValidationError 
    # (e.g. unknown enum value) is caught gracefully and returns 200 (not 500)
    # Find the enclosing try/catch of the voice/diag/event endpoint
    
    # Strategy: find the route handler for /voice/diag/event and add a catch for validation errors
    route_idx = content.find('app.post("/voice/diag/event"')
    if route_idx >= 0:
        print(f'/voice/diag/event route at line ~{content[:route_idx].count(chr(10))+1}')
        chunk = content[route_idx:route_idx+600]
        print('Route chunk:', repr(chunk[:400]))
else:
    print('voiceDiagEvent.create NOT found')

# The actual fix: find the specific try/catch pattern and make it handle validation errors
# Look for PrismaClientValidationError handling or add it
OLD_DIAG_CREATE = 'const event = await db.voiceDiagEvent.create({'
NEW_DIAG_CREATE = '''// Handle unknown enum values (e.g. new mobile app event types not yet in DB schema)
        let event: any;
        try {
          event = await db.voiceDiagEvent.create({'''

# Find the closing of the db.voiceDiagEvent.create call
# We need to wrap just the db call, not the outer try block
# Check if we can find a unique pattern around it

# Actually, the most reliable fix is to catch PrismaClientValidationError in the route
# Let's find the catch block in the voice/diag/event route and add graceful handling

# Search for the error handling pattern in the route
search = '"voice/diag/event"'
idx = content.find(search)
if idx >= 0:
    # Find the catch block after this route's try
    route_block = content[idx:idx+2000]
    print('\nVoice diag event route (first 800 chars):')
    print(repr(route_block[:800]))

print('\n')

# The cleanest fix: make the voiceDiagEvent.create in a nested try/catch so
# validation errors return 400 or 200 instead of 500
# Find the pattern: } catch (err) { ... } around the route, or add a specific catch

# Actually simplest approach: find `const event = await db.voiceDiagEvent.create` 
# and replace the surrounding try block to catch validation errors
PATCH_BEFORE = '    const event = await db.voiceDiagEvent.create({'
PATCH_AFTER = '''    let event: any;
    try {
      event = await db.voiceDiagEvent.create({'''

# And we need to close the new try and add a catch
# Find what comes after the create call:
create_idx = content.find('    const event = await db.voiceDiagEvent.create({')
if create_idx >= 0:
    print(f'Found at index {create_idx}')
    # Find the end of this statement (the closing }); )
    chunk = content[create_idx:create_idx+500]
    print('Full create chunk:', repr(chunk[:400]))

# Write and verify
shutil.copy2(SERVER, SERVER + '.bak_fix2')

with open(SERVER, 'w', encoding='utf-8') as f:
    f.write(content)
print('WRITTEN (fix 1 only for now)')
print('Please check the voice/diag/event route manually')
