#!/bin/bash
TOKEN="7f462d370c305c446e66f2f3177fa32a"
BASE="https://m.connectcomunications.com"

docker exec app-api-1 node -e "
const TOKEN='$TOKEN', BASE='$BASE';
(async () => {
  // Try different auth methods
  const headers_list = [
    {'app-key': TOKEN},
    {'Authorization': 'Bearer ' + TOKEN},
    {'X-API-Key': TOKEN},
    {'api-key': TOKEN},
  ];
  
  for (const h of headers_list) {
    const hname = Object.keys(h)[0];
    const r = await fetch(BASE+'/api/v2/cdr?limit=2', {headers: h});
    const j = await r.json();
    console.log(hname + ':', r.status, 'rows:', j?.data?.rows ?? j?.message);
  }

  // Check CDR directly via VitalPBX internal paths
  console.log('\n=== Trying v1 API ===');
  let r = await fetch(BASE+'/api/v1/cdr?limit=2', {headers:{'app-key':TOKEN}});
  console.log('/api/v1/cdr:', r.status, (await r.text()).substring(0,120));

  // Check if there's a dashboard API
  console.log('\n=== Dashboard stats ===');
  for (const p of ['/api/v2/dashboard/stats', '/api/v2/stats', '/api/v2/system/stats', '/api/v2/cdr/stats', '/api/v2/dashboard/cdr']) {
    r = await fetch(BASE+p, {headers:{'app-key':TOKEN}});
    const t = await r.text();
    console.log(r.status, p, '->', t.substring(0,120));
  }
})();
" 2>&1
