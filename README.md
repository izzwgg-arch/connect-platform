# Connect Communications Platform

Monorepo scaffold for portal, API, realtime services, and shared packages.

- Runtime env reference: `/opt/connectcomms/env/.env.platform`
- Do not run installs in parallel.

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

