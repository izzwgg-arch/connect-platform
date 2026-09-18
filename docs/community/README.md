# Loopcom Community — running it

Two apps in this monorepo, their own database. **Nothing here is deployed on the
Connect server**; it runs locally now and goes to its own box later
(`infra/community/docker-compose.yml`).

## Local dev (Windows, this machine)

Prereqs already in place: Node 24, pnpm 11, Postgres 16 on 127.0.0.1:5432 with
database `loopcom_community` (+ `pg_trgm`, `unaccent`).

```bash
# once
pnpm install --filter @loopcom/community-api --filter @loopcom/community-web
cd apps/community-api && npx prisma migrate deploy --schema prisma/schema.prisma && npx prisma generate --schema prisma/schema.prisma
```

Two terminals:

```bash
pnpm --filter @loopcom/community-api dev     # http://localhost:3101  (health: /health)
```

```bash
pnpm --filter @loopcom/community-web dev     # http://localhost:3100
```

`apps/community-api/.env` (git-ignored) holds the local config; `.env.example`
documents every variable. With `COMMUNITY_MAIL_MODE=mailbox` every email/SMS
lands in the `OutboundMail` table — open **http://localhost:3100/dev/mailbox**
to read verification codes and reset links while testing. That page and the
`/dev/*` api routes exist only when `COMMUNITY_TEST_HOOKS=1` (never in
production — the api refuses to boot with it set).

## Tests

```bash
cd apps/community-api && pnpm test            # integration tests against the real local db
```

```bash
cd apps/community-api && pnpm test:tier1      # 20× every Tier-1 flow over HTTP (api must be running)
```

Rules: hand-write migrations under `prisma/migrations/<timestamp>_<slug>/migration.sql`
and apply with `prisma migrate deploy`. **Never run `prisma migrate dev`** — the
generated tsvector columns and partial indexes read as drift and it offers to
reset the database.

## Loopcom SSO (the one integration)

A person signed into the Loopcom portal/app is sent to
`https://community.loopcom.net/sso/loopcom?token=<their Loopcom JWT>`. The
Community api calls `LOOPCOM_API_URL/me` with that token; if Loopcom answers,
the person is signed in here (created on first visit, linked by `loopcomUserId`).
Nothing is minted the other way. Outsiders register at `/join`.

The Loopcom portal side (a "Community" sidebar link that opens that URL with its
token) is a later, separate change in `apps/portal` — not part of this build.

## Later: its own server

`infra/community/docker-compose.yml` runs postgres + redis + api + web; nginx
example in `infra/community/nginx.conf.example` (one host, `/api` proxied to the
api with buffering off for SSE). Fill `infra/community/.env` from the example.
