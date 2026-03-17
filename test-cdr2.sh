#!/bin/bash
echo "=== All env vars with ENCRYPT or KEY or CRYPT ==="
docker exec app-api-1 env | grep -iE 'encrypt|crypt|key' | grep -v npm | head -20

echo ""
echo "=== Test CDR with different params from inside API container ==="
docker exec app-api-1 node -e "
(async () => {
  // Import the decrypt function the API uses
  const crypto = require('crypto');
  
  // Find the encryption key
  const envKeys = Object.entries(process.env).filter(([k]) => /encrypt|crypt|key/i.test(k) && !/npm|node|path/i.test(k));
  console.log('Crypto env vars:', envKeys.map(([k,v]) => k + '=' + v.substring(0,8) + '...'));
  
  // Try to get the token from the database via the API's own Prisma client
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) { console.log('No enabled instance'); return; }
  console.log('Instance:', inst.id, inst.baseUrl);
  console.log('Auth encrypted (first 40):', inst.apiAuthEncrypted.substring(0,40));
  
  // Try to decrypt using each possible key
  for (const [envName, envVal] of envKeys) {
    try {
      const parsed = JSON.parse(Buffer.from(inst.apiAuthEncrypted, 'base64').toString('utf8'));
      const keyBuf = Buffer.from(envVal, 'hex');
      if (keyBuf.length !== 32) continue;
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(parsed.iv, 'utf8'));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const decrypted = decipher.update(parsed.ciphertext, 'base64', 'utf8') + decipher.final('utf8');
      const obj = JSON.parse(decrypted);
      const token = obj.token;
      console.log('Decrypted with', envName, '- token length:', token.length);
      
      // Test 1: No date filter, no tenant
      const url1 = inst.baseUrl + '/api/v2/cdr?limit=3&sort_by=date&sort_order=desc';
      console.log('\n--- Test 1: No date filter ---');
      const r1 = await fetch(url1, { headers: { 'app-key': token } });
      const j1 = await r1.json();
      console.log('Status:', r1.status, 'result_len:', j1?.data?.result?.length, 'rows:', j1?.data?.rows);
      if (j1?.data?.result?.[0]) console.log('Sample:', JSON.stringify(j1.data.result[0]).substring(0,200));
      
      // Test 2: With YYYY-MM-DD start_date
      const today = new Date().toISOString().split('T')[0];
      const url2 = inst.baseUrl + '/api/v2/cdr?start_date=' + today + '&limit=3&sort_by=date&sort_order=desc';
      console.log('\n--- Test 2: start_date=' + today + ' ---');
      const r2 = await fetch(url2, { headers: { 'app-key': token } });
      const j2 = await r2.json();
      console.log('Status:', r2.status, 'result_len:', j2?.data?.result?.length, 'rows:', j2?.data?.rows);
      
      // Test 3: With tenant_id header
      const url3 = inst.baseUrl + '/api/v2/cdr?limit=3&sort_by=date&sort_order=desc';
      console.log('\n--- Test 3: With X-Tenant-ID: 1 header ---');
      const r3 = await fetch(url3, { headers: { 'app-key': token, 'X-Tenant-ID': '1' } });
      const j3 = await r3.json();
      console.log('Status:', r3.status, 'result_len:', j3?.data?.result?.length, 'rows:', j3?.data?.rows);
      if (j3?.data?.result?.[0]) console.log('Sample:', JSON.stringify(j3.data.result[0]).substring(0,200));
      
      break;
    } catch(e) { /* try next key */ }
  }
  
  await db.\$disconnect();
})();
" 2>&1
