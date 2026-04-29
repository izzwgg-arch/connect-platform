#!/usr/bin/env bash
# Look at the LAST 200 TelephonyBroadcaster lines — these are the exact payloads
# the portal receives for "live calls". Compare with the PeerStatus / presence events.
set -u

echo "=== last 200 broadcaster callUpsert lines (tenantId + matchingWsClients) ==="
docker logs --tail 2000 app-telephony-1 2>&1 \
  | grep -E 'component":"TelephonyBroadcaster' \
  | tail -60 \
  | python3 -c '
import json, sys
for line in sys.stdin:
    try:
        j = json.loads(line.strip())
    except Exception:
        continue
    print("call={:<22} state={:<10} from={:<12} to={:<16} tenant={:<28} wsTotal={} wsMatching={} exts={}".format(
        j.get("callId","-"),
        j.get("state","-"),
        j.get("from","-"),
        j.get("to","-"),
        j.get("tenantId","-"),
        j.get("totalWsClients","-"),
        j.get("matchingWsClients","-"),
        j.get("extensions","-"),
    ))
'

echo
echo "=== last 40 PeerStatus / ContactStatus / ExtensionStatus lines ==="
docker logs --tail 4000 app-telephony-1 2>&1 \
  | grep -E '"event":"(PeerStatus|ContactStatus|ExtensionStatus)' \
  | tail -30 \
  | python3 -c '
import json, sys
for line in sys.stdin:
    try: j = json.loads(line.strip())
    except: continue
    ev = j.get("event","-")
    peer = j.get("peer") or j.get("channel") or j.get("exten") or "-"
    print("{:<16} peer={:<30} tenantId={:<28} status={}".format(
        ev, peer, str(j.get("tenantId","-")), j.get("channelStateDesc") or j.get("peerStatus") or j.get("contactStatus") or "-"
    ))
'

echo
echo "=== current /telephony/diag (needs telephony token) ==="
TOKEN="$(awk -F= '/^TELEPHONY_INTERNAL_TOKEN=|^TELEPHONY_DIAG_TOKEN=|^TELEPHONY_TOKEN=/{print $2; exit}' /opt/connectcomms/env/.env.platform 2>/dev/null)"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(awk -F= '/^TELEPHONY_INTERNAL_TOKEN=|^TELEPHONY_DIAG_TOKEN=|^TELEPHONY_TOKEN=/{print $2; exit}' /opt/connectcomms/env/.env.telephony 2>/dev/null || true)"
fi
if [[ -n "$TOKEN" ]]; then
  echo "(using token from env)"
  curl -sS --max-time 5 -H "x-internal-token: $TOKEN" http://127.0.0.1:3003/telephony/diag | python3 -m json.tool 2>/dev/null | head -120
else
  echo "(no telephony diag token in env files; listing matching env keys)"
  grep -E '^TELEPHONY_' /opt/connectcomms/env/*.env* 2>/dev/null | head -20 || true
fi
