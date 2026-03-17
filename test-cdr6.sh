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
  // The tenant-scoped CDR path
  console.log('=== /api/v2/tenants/1/cdr (full response) ===');
  let r = await fetch(BASE + '/api/v2/tenants/1/cdr?limit=5&sort_by=date&sort_order=desc', {headers:{'app-key':token}});
  let j = await r.json();
  console.log('Status:', r.status);
  console.log('Top keys:', Object.keys(j));
  if (j.data) {
    if (Array.isArray(j.data)) {
      console.log('Data is array, length:', j.data.length);
      if (j.data[0]) console.log('Sample keys:', Object.keys(j.data[0]));
      if (j.data[0]) console.log('Sample:', JSON.stringify(j.data[0]).substring(0,400));
    } else {
      console.log('Data keys:', Object.keys(j.data));
      console.log('rows:', j.data.rows, 'result_len:', j.data?.result?.length);
      if (j.data.result?.[0]) console.log('Sample:', JSON.stringify(j.data.result[0]).substring(0,400));
    }
  }

  // Also try tenant-scoped extensions
  console.log('\n=== /api/v2/tenants/1/extensions ===');
  r = await fetch(BASE + '/api/v2/tenants/1/extensions?limit=3', {headers:{'app-key':token}});
  j = await r.json();
  console.log('Status:', r.status);
  if (Array.isArray(j.data)) console.log('Extensions count:', j.data.length);
  else if (j.data?.result) console.log('Extensions count:', j.data.result.length);
  if (j.data?.[0]) console.log('Ext sample:', JSON.stringify(j.data[0]).substring(0,200));
  else if (j.data?.result?.[0]) console.log('Ext sample:', JSON.stringify(j.data.result[0]).substring(0,200));

  // Try listing all tenants to see if there are more
  console.log('\n=== All tenants ===');
  r = await fetch(BASE + '/api/v2/tenants', {headers:{'app-key':token}});
  j = await r.json();
  const tenants = j.data || j.data?.result || [];
  for (const t of (Array.isArray(tenants) ? tenants : [])) {
    console.log('  id:', t.tenant_id, 'name:', t.name, 'desc:', t.description, 'enabled:', t.enabled);
  }
})();
" -- "$AUTH" 2>&1
