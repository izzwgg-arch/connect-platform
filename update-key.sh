#!/bin/bash
TOKEN="7f462d370c305c446e66f2f3177fa32a"
BASE="https://m.connectcomunications.com"

echo "=== Test 1: CDR with new key (1 request) ==="
docker exec app-api-1 node -e "
const TOKEN='$TOKEN';
const BASE='$BASE';
(async () => {
  const r = await fetch(BASE+'/api/v2/cdr?limit=3&sort_by=date&sort_order=desc', {headers:{'app-key':TOKEN}});
  const j = await r.json();
  console.log('Status:', r.status, 'rows:', j?.data?.rows, 'result_len:', j?.data?.result?.length);
  if (j?.data?.result?.[0]) {
    console.log('Sample keys:', Object.keys(j.data.result[0]));
    console.log('Sample:', JSON.stringify(j.data.result[0]).substring(0,400));
  }
  if (j?.data?.rows === 0) console.log('Full resp:', JSON.stringify(j).substring(0,300));
})();
" 2>&1

echo ""
echo "=== Test 2: Encrypt new key and update DB ==="
docker exec app-api-1 node -e "
const crypto = require('crypto');
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'hex');
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const value = JSON.stringify({token: '$TOKEN'});
const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const envelope = {
  iv: iv.toString('base64'),
  tag: tag.toString('base64'),
  ciphertext: ciphertext.toString('base64'),
  keyId: 'v1'
};
const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64');
console.log('ENCRYPTED=' + encoded);
" 2>&1
