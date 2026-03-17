#!/bin/bash
TOKEN="7f462d370c305c446e66f2f3177fa32a"
BASE="https://m.connectcomunications.com"

docker exec app-api-1 node -e "
const TOKEN='$TOKEN', BASE='$BASE';
(async () => {
  // Get all tenants
  const tr = await fetch(BASE+'/api/v2/tenants', {headers:{'app-key':TOKEN}});
  const tj = await tr.json();
  const tenants = tj.data || [];
  
  console.log('Checking CDR per tenant...');
  for (const t of tenants.slice(0, 10)) {
    // Try tenant_id query param
    const r = await fetch(BASE+'/api/v2/cdr?tenant_id='+t.tenant_id+'&limit=2', {headers:{'app-key':TOKEN}});
    const j = await r.json();
    const rows = j?.data?.rows ?? '?';
    
    // Also try extensions
    const er = await fetch(BASE+'/api/v2/extensions?tenant_id='+t.tenant_id+'&limit=2', {headers:{'app-key':TOKEN}});
    const ej = await er.json();
    const extCount = Array.isArray(ej?.data) ? ej.data.length : (ej?.data?.result?.length ?? '?');
    
    console.log('Tenant', t.tenant_id, '('+t.description+'): CDR rows='+rows+', exts='+extCount);
  }
})();
" 2>&1
