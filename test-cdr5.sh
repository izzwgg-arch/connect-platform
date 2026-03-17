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
const BASE = 'https://m.connectcomunications.com';
(async () => {
  // Try different CDR endpoint paths
  const paths = [
    '/api/v2/cdr?limit=3',
    '/api/v2/cdr/1?limit=3',
    '/api/v2/1/cdr?limit=3',
    '/api/v2/tenants/1/cdr?limit=3',
    '/api/v2/reports/cdr?limit=3',
    '/api/cdr?limit=3',
  ];
  for (const path of paths) {
    try {
      const r = await fetch(BASE + path, {headers:{'app-key':token}});
      const text = await r.text();
      let rows = '?';
      try { const j = JSON.parse(text); rows = j?.data?.rows ?? j?.rows ?? 'N/A'; } catch {}
      console.log(r.status, path, '-> rows:', rows, text.length > 200 ? '(len:'+text.length+')' : text.substring(0,200));
    } catch(e) { console.log('ERR', path, e.message); }
  }

  // Also check: what API permissions does this key have?
  console.log('\n=== Check API endpoints ===');
  const checks = [
    '/api/v2/extensions?limit=2',
    '/api/v2/trunks?limit=2',
    '/api/v2/pjsip/contacts?limit=2',
    '/api/v2/system/info',
    '/api/v2/dashboard',
    '/api/v2/dashboard/calls',
  ];
  for (const path of checks) {
    try {
      const r = await fetch(BASE + path, {headers:{'app-key':token}});
      const text = await r.text();
      const snippet = text.substring(0,150).replace(/\\n/g,' ');
      console.log(r.status, path, '->', snippet);
    } catch(e) { console.log('ERR', path, e.message); }
  }
})();
" -- "$AUTH" 2>&1
