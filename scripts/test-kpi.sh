#!/bin/bash
RAW=$(python3 /opt/connectcomms/app/scripts/remote-observe-token.py 2>/dev/null)
TOKEN=$(echo "$RAW" | tail -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
echo "=== Current cache state ==="
curl -m 15 -s -H "Authorization: Bearer ${TOKEN}" "http://localhost:3001/dashboard/call-kpis?source=pbx"
echo ""
echo "=== Last 10 min of bg refresh logs ==="
docker logs app-api-1 --since 10m 2>&1 | grep -i "pbx-kpi-bg\|refresh\|aggregateVital\|kpiTimeout\|WARN\|warn" | tail -20
echo ""
echo "=== Any hung/long requests ==="
docker logs app-api-1 --since 10m 2>&1 | grep -i "vitalpbx_debug" | tail -5
echo ""
echo "=== Check if inflight is stuck ==="
docker logs app-api-1 --since 10m 2>&1 | grep -i "pbx:global\|inflight" | tail -10
