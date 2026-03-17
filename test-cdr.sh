#!/bin/bash
set -e
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"

INST_ID="cmmi7huxy0000qq3igj493o5q"
AUTH_ENC=$($DB -c "SELECT \"apiAuthEncrypted\" FROM \"PbxInstance\" WHERE id = '$INST_ID'")
echo "Auth encrypted length: ${#AUTH_ENC}"

CRYPT_KEY=$(docker exec app-api-1 printenv CREDENTIAL_ENCRYPTION_KEY 2>/dev/null || echo "")
echo "Crypt key length: ${#CRYPT_KEY}"

echo ""
echo "=== Test 1: YYYY-MM-DD format (1 request) ==="
docker exec app-api-1 node -e "
const crypto = require('crypto');
const enc = '$AUTH_ENC';
const key = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
let token = '';
try {
  const parsed = JSON.parse(Buffer.from(enc, 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(parsed.iv, 'utf8'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  token = decipher.update(parsed.ciphertext, 'base64', 'utf8') + decipher.final('utf8');
  const obj = JSON.parse(token);
  token = obj.token || '';
} catch(e) { console.log('Decrypt error:', e.message); }

if (!token) { console.log('NO TOKEN'); process.exit(1); }
console.log('Token first 8 chars:', token.substring(0,8) + '...');

const today = new Date().toISOString().split('T')[0];
const urls = [
  'https://m.connectcomunications.com/api/v2/cdr?start_date=' + today + '&limit=3&sort_by=date&sort_order=desc',
  'https://m.connectcomunications.com/api/v2/cdr?limit=3&sort_by=date&sort_order=desc',
];

(async () => {
  for (const url of urls) {
    console.log('\n--- Trying:', url);
    try {
      const r = await fetch(url, { headers: { 'app-key': token } });
      const j = await r.json();
      console.log('Status:', r.status);
      console.log('Top keys:', Object.keys(j));
      if (j.data) {
        console.log('Data keys:', Object.keys(j.data));
        if (j.data.rows !== undefined) console.log('Rows count:', j.data.rows);
        if (Array.isArray(j.data.result)) {
          console.log('Result length:', j.data.result.length);
          if (j.data.result[0]) console.log('Sample keys:', Object.keys(j.data.result[0]).slice(0,10));
        }
      }
    } catch(e) { console.log('Error:', e.message); }
  }
})();
" 2>&1
