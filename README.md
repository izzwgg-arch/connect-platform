# Connect Communications Platform

Monorepo scaffold for portal, API, realtime services, and shared packages.

- Runtime env reference: `/opt/connectcomms/env/.env.platform`
- Do not run installs in parallel.

## Safe deploy queue (multi-agent)

Production uses **Docker Compose** for app services. A small **localhost-only** queue (`ops/deploy-queue`, PM2 name `connect-deploy-worker`) serializes **all** routine deploys. Targets: `api`, `portal`, `telephony`, `realtime`, `worker`, `full-stack` (wraps `deploy-tag.sh`). Use `GET /ops/deploy/status`, `GET /ops/deploy/jobs/:id/log`, and optional `dryRun: true` on enqueue.

- **Full documentation:** [docs/safe-deploy-queue.md](docs/safe-deploy-queue.md)
- **Policy:** agents and humans enqueue only; direct `deploy-tag.sh` / `docker compose` rebuilds are **emergency-only** (warnings print unless `DEPLOY_QUEUE_ACK=1`).

## PBX Smoke Runner

Run on the Linux server (not PowerShell):

```bash
cd /opt/connectcomms/app
./scripts/smoke-v1.1.0.sh
# or
pnpm smoke:pbx
```

Notes:
- Default `BASE_URL` is `https://app.connectcomunications.com/api`.
- The script assumes server-local Docker + Postgres access.
- Uses PBX simulation mode for smoke validation.

## PBX Inbound Event Webhook (v1.3.2)

Webhook URL:

`
https://app.connectcomunications.com/api/webhooks/pbx
`

Required API env vars:

- PBX_WEBHOOK_VERIFY_MODE=token|hmac|ip_allowlist
- PBX_WEBHOOK_TOKEN=
- PBX_WEBHOOK_SIGNATURE_SECRET=
- PBX_WEBHOOK_ALLOWED_IPS=

Optional PBX capability/path overrides:

- PBX_WEBHOOK_REGISTER_PATH=
- PBX_WEBHOOK_LIST_PATH=
- PBX_WEBHOOK_DELETE_PATH=
- PBX_ACTIVE_CALLS_PATH=
- PBX_SUPPORTS_WEBHOOKS=
- PBX_SUPPORTS_ACTIVE_CALL_POLLING=
- PBX_WEBHOOK_EVENT_TYPES=call.ringing,call.answered,call.hangup

Nginx ops note:

- Route /api/webhooks/pbx to API (existing HTTPS only).
- Exclude /api/webhooks/pbx from auto-ban scoring the same way as other webhook paths.
- Keep a moderate rate-limit for this endpoint, not auth-level strict limits.

