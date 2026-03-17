#!/bin/bash
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"
AUTH=$($DB -c "SELECT \"apiAuthEncrypted\" FROM \"PbxInstance\" WHERE id = 'cmmi7huxy0000qq3igj493o5q'")

docker exec app-api-1 node -e "
const crypto = require('crypto');
const enc = process.argv[1];
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'hex');
const parsed = JSON.parse(Buffer.from(enc, 'base64').toString('utf8'));
const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
const plain = decipher.update(parsed.ciphertext, 'base64', 'utf8') + decipher.final('utf8');
const token = JSON.parse(plain).token;
const BASE = 'https://m.connectcomunications.com';
(async () => {
  // Full raw CDR response to see the exact shape
  console.log('=== Full CDR raw response ===');
  let r = await fetch(BASE + '/api/v2/cdr?limit=5', {headers:{'app-key':token}});
  let text = await r.text();
  console.log('Full response:', text);

  // Try with tenant in header (X-Tenant-ID)
  console.log('\n=== CDR with X-Tenant-ID header ===');
  r = await fetch(BASE + '/api/v2/cdr?limit=5', {headers:{'app-key':token, 'X-Tenant-ID': '1'}});
  text = await r.text();
  console.log('Full response:', text);

  // Try POST instead of GET for CDR
  console.log('\n=== POST /api/v2/cdr ===');
  r = await fetch(BASE + '/api/v2/cdr', {
    method: 'POST',
    headers: {'app-key': token, 'Content-Type': 'application/json'},
    body: JSON.stringify({limit: 5, sort_by: 'date', sort_order: 'desc'})
  });
  text = await r.text();
  console.log('Status:', r.status, 'Response:', text.substring(0,300));

  // Check available API routes
  console.log('\n=== Check more paths ===');
  for (const p of ['/api/v2/cdr/report', '/api/v2/cdr/today', '/api/v2/calls', '/api/v2/active-calls', '/api/v2/channels']) {
    r = await fetch(BASE + p + '?limit=3', {headers:{'app-key':token}});
    text = await r.text();
    console.log(r.status, p, '->', text.substring(0,120));
  }
})();
" -- "$AUTH" 2>&1
