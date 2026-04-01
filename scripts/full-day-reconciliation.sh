#!/bin/bash
# Run full-day CDR pipeline reconciliation with a 600s curl timeout.
# Usage: bash /opt/connectcomms/app/scripts/full-day-reconciliation.sh
set -e
TOKEN=$(python3 -c "
import json, re, urllib.request
secret = re.search(r'^DEV_OBSERVE_TOKEN_SECRET=(.+)$', open('/opt/connectcomms/env/.env.platform').read(), re.M).group(1).strip()
r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3001/admin/dev/generate-observe-token', json.dumps({'secret': secret}).encode(), {'Content-Type': 'application/json'}, method='POST'), timeout=10)
print(json.loads(r.read())['token'])
")
echo "Token minted"
echo "Starting full-day reconciliation (may take 8-12 minutes for chunked gesheft)..."
START=$(date +%s)
RESULT=$(curl -s -m 900 -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:3001/admin/diagnostics/cdr-pipeline-reconciliation')
END=$(date +%s)
echo "Elapsed: $((END-START))s"

python3 -c "
import json, sys
d = json.loads('''$RESULT''')
t = d.get('section1_totals', {})
w = d.get('section1_timeWindow', {})
c = d.get('counts', {})
print('=== Full-Day CDR Reconciliation ===')
print('Window:          ', d.get('section1_timeWindow', {}).get('window', {}).get('start','?'), '->', d.get('section1_timeWindow', {}).get('window', {}).get('end','?'))
print('PBX raw rows:    ', t.get('pbxRawRowsFromApi', '?'))
print('PBX unique calls:', t.get('pbxCanonicalCalls', '?'))
print('Connect rows:    ', t.get('connectCdrRows', '?'))
if t.get('pbxCanonicalCalls', 0):
    ratio = t['pbxRawRowsFromApi'] / t['pbxCanonicalCalls']
    connect = t.get('connectCdrRows', 0)
    unique = t['pbxCanonicalCalls']
    print(f'Ratio raw/unique:{ratio:.2f}x')
    print(f'Connect/PBXuniq: {connect}/{unique} = {connect/unique*100:.1f}%')
print('Tenant errors:   ', w.get('tenantFetchErrors', {}))
print('Pagination notes:', {k:v for k,v in w.get('paginationNotesByTenant', {}).items() if v})
print('missingFromConnect:', c.get('missingPbxCanonicalNotInConnect', '?'))
print('onlyInConnect:     ', c.get('connectOnlyRows', '?'))
pbx_dir = t.get('pbxByDirection', {})
conn_dir = t.get('connectByDirection', {})
print('PBX by direction:', pbx_dir)
print('Con by direction:', conn_dir)
"
