# Connect Communications Platform

Monorepo scaffold for portal, API, realtime services, and shared packages.

- Runtime env reference: `/opt/connectcomms/env/.env.platform`
- Do not run installs in parallel.

## Safe Deploy Queue

- All deployments go through the deploy queue — never run `docker compose`, `pnpm build`, `prisma migrate`, or `deploy-tag.sh` manually on the server.
- Agents must not deploy directly. The full rulebook is in [`AGENTS.md`](AGENTS.md).
- Enqueue: `POST /ops/deploy/enqueue` (body: `service`, `branch`, optional `commitHash`, `requestedBy`, `reason`, optional `dryRun`).
- Check: `GET /ops/deploy/jobs` and `GET /ops/deploy/jobs/:id`.
- Logs: `/var/log/connect-deploys/` on the server, or `GET /ops/deploy/jobs/:id/log?lines=200`.
- Targets: `api`, `portal`, `telephony`, `realtime`, `worker`, `full-stack` (wraps `deploy-tag.sh`). Global serialization — one job at a time.
- Full HTTP reference, examples, and emergency-override policy: [`docs/safe-deploy-queue.md`](docs/safe-deploy-queue.md).

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

