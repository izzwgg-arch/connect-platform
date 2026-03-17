#!/bin/bash
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"
AUTH=$($DB -c "SELECT \"apiAuthEncrypted\" FROM \"PbxInstance\" WHERE id = 'cmmi7huxy0000qq3igj493o5q'")

docker exec app-api-1 node -e "
const crypto = require('crypto');
const enc = '$AUTH';
const keys = [
  process.env.CREDENTIALS_MASTER_KEY,
  process.env.ENCRYPTION_KEY,
];

let token = null;
for (const key of keys) {
  if (!key || key.length < 10) continue;
  try {
    const parsed = JSON.parse(Buffer.from(enc, 'base64').toString('utf8'));
    const keyBuf = Buffer.from(key, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(parsed.iv, 'utf8'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    token = JSON.parse(decipher.update(parsed.ciphertext, 'base64', 'utf8') + decipher.final('utf8')).token;
    console.log('Decrypted OK, token length:', token.length);
    break;
  } catch(e) { console.log('Key failed:', e.message); }
}

if (!token) { console.log('FAILED to decrypt'); process.exit(1); }

const BASE = 'https://m.connectcomunications.com';

(async () => {
  // Test 1: no filters
  console.log('\n=== Test 1: No date filter ===');
  let r = await fetch(BASE+'/api/v2/cdr?limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  let j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);
  if (j?.data?.result?.[0]) console.log('Sample keys:', Object.keys(j.data.result[0]));

  // Test 2: YYYY-MM-DD date
  console.log('\n=== Test 2: start_date=2026-03-10 ===');
  r = await fetch(BASE+'/api/v2/cdr?start_date=2026-03-10&limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);

  // Test 3: Unix timestamp
  console.log('\n=== Test 3: start_date=1773100800 (unix) ===');
  r = await fetch(BASE+'/api/v2/cdr?start_date=1773100800&limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);

  // Test 4: tenant_id in query
  console.log('\n=== Test 4: tenant_id=1 in query ===');
  r = await fetch(BASE+'/api/v2/cdr?tenant_id=1&limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);
  if (j?.data?.result?.[0]) console.log('Sample keys:', Object.keys(j.data.result[0]));
  if (j?.data?.result?.[0]) console.log('Sample:', JSON.stringify(j.data.result[0]).substring(0,300));

  // Test 5: list tenants
  console.log('\n=== Test 5: List tenants ===');
  r = await fetch(BASE+'/api/v2/tenants', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status);
  if (j?.data?.result) {
    for (const t of j.data.result.slice(0,5)) {
      console.log('  Tenant:', t.tenant_id || t.id, '-', t.name || t.description);
    }
  } else {
    console.log('Response keys:', Object.keys(j));
    console.log('Data:', JSON.stringify(j).substring(0,300));
  }
})();
" 2>&1
