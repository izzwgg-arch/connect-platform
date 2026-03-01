# SBC Remote Rollout (v1.4.12)

## LOCAL vs REMOTE SBC

- `LOCAL`: `/sip` on the app server points to the SBC running on the same host.
- `REMOTE`: `/sip` on the app server points to an SBC running on another server.

The active mode is controlled in the portal at `/dashboard/admin/sbc/config`.

## Remote Prerequisites Checklist

- A separate Debian/Ubuntu server reachable over SSH.
- Docker Engine and Docker Compose plugin installed (deploy script can install if missing).
- DNS and TLS for remote WSS endpoint (`wss://...`) prepared as needed.
- Kamailio and RTPengine assets from this repo available for deployment.

## Network Note (Important)

Open `35000-35199/udp` on the **REMOTE SBC host** for RTP media.
Do **not** open this range on the app host for remote mode rollout.

## Rollout Steps

1. Deploy remote SBC stack:
   - `scripts/sbc-remote/deploy-remote-sbc.sh --host <remote-host>`
2. Verify remote SBC stack:
   - `scripts/sbc-remote/verify-remote-sbc.sh --host <remote-host>`
3. In portal, switch SBC mode to `REMOTE`:
   - `/dashboard/admin/sbc/config`
4. Run readiness probe and confirm remote fields:
   - `remoteWsOk`
   - `remoteTcpOk`
   - `remoteProbeLatencyMs`
   - `lastProbeAt`
5. Enable WebRTC-via-SBC for one test tenant and run media test.
6. Expand rollout tenant-by-tenant after successful validation.

## Rollback Steps

1. In `/dashboard/admin/sbc/config`, switch mode back to `LOCAL`.
2. Optionally stop and clean remote SBC files:
   - `scripts/sbc-remote/rollback-remote-sbc.sh --host <remote-host>`
3. If a full app release rollback is needed, use:
   - `scripts/release/rollback.sh`
