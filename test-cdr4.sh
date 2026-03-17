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
const obj = JSON.parse(plain);
const token = obj.token;
console.log('Token decrypted, length:', token.length);
const BASE = 'https://m.connectcomunications.com';
(async () => {
  console.log('\n=== Test 1: No date filter ===');
  let r = await fetch(BASE+'/api/v2/cdr?limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  let j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);
  if (j?.data?.result?.[0]) console.log('Sample keys:', Object.keys(j.data.result[0]));
  if (j?.data?.result?.[0]) console.log('Sample:', JSON.stringify(j.data.result[0]).substring(0,300));

  console.log('\n=== Test 2: start_date=2026-03-10 ===');
  r = await fetch(BASE+'/api/v2/cdr?start_date=2026-03-10&limit=3', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);
  if (j?.data?.result?.[0]) console.log('Sample:', JSON.stringify(j.data.result[0]).substring(0,300));

  console.log('\n=== Test 3: Unix timestamp ===');
  r = await fetch(BASE+'/api/v2/cdr?start_date=1773100800&limit=3', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);

  console.log('\n=== Test 4: tenant_id=1 ===');
  r = await fetch(BASE+'/api/v2/cdr?tenant_id=1&limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);
  if (j?.data?.result?.[0]) console.log('Sample:', JSON.stringify(j.data.result[0]).substring(0,300));

  console.log('\n=== Test 5: List tenants ===');
  r = await fetch(BASE+'/api/v2/tenants', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status);
  if (j?.data?.result) j.data.result.slice(0,5).forEach(t => console.log('  Tenant:', t.tenant_id||t.id, '-', t.name||t.description));
  else console.log('Data:', JSON.stringify(j).substring(0,400));
})();
" -- "$AUTH" 2>&1
