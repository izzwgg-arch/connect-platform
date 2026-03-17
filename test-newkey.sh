#!/bin/bash
TOKEN="7f462d370c305c446e66f2f3177fa32a"
BASE="https://m.connectcomunications.com"

docker exec app-api-1 node -e "
const TOKEN='$TOKEN', BASE='$BASE';
(async () => {
  // Extensions - should show data if key has access
  console.log('=== Extensions ===');
  let r = await fetch(BASE+'/api/v2/extensions?limit=3', {headers:{'app-key':TOKEN}});
  let j = await r.json();
  console.log('Status:', r.status, 'data is array:', Array.isArray(j?.data), 'len:', Array.isArray(j?.data)?j.data.length:'N/A');
  if (j?.data?.[0]) console.log('Sample:', JSON.stringify(j.data[0]).substring(0,200));

  // CDR with no params at all
  console.log('\n=== CDR (no params) ===');
  r = await fetch(BASE+'/api/v2/cdr', {headers:{'app-key':TOKEN}});
  j = await r.json();
  console.log('rows:', j?.data?.rows);

  // CDR yesterday
  console.log('\n=== CDR yesterday ===');
  r = await fetch(BASE+'/api/v2/cdr?start_date=2026-03-09&end_date=2026-03-09&limit=3', {headers:{'app-key':TOKEN}});
  j = await r.json();
  console.log('rows:', j?.data?.rows);

  // CDR last week
  console.log('\n=== CDR last week ===');
  r = await fetch(BASE+'/api/v2/cdr?start_date=2026-03-01&limit=3', {headers:{'app-key':TOKEN}});
  j = await r.json();
  console.log('rows:', j?.data?.rows);

  // Trunks
  console.log('\n=== Trunks ===');
  r = await fetch(BASE+'/api/v2/trunks?limit=2', {headers:{'app-key':TOKEN}});
  j = await r.json();
  console.log('Status:', r.status, 'data len:', Array.isArray(j?.data)?j.data.length:'N/A');

  // CDR report 
  console.log('\n=== CDR reports ===');
  r = await fetch(BASE+'/api/v2/cdr/report?limit=3', {headers:{'app-key':TOKEN}});
  j = await r.json();
  console.log('rows:', j?.data?.rows);
})();
" 2>&1
