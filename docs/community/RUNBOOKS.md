# Loopcom Community — operational runbooks

All commands run on the Community server (its own box — never the Connect server) from the repo checkout, unless noted.

## Deploy / rollback (separate server)

```bash
cp infra/community/.env.example infra/community/.env   # first time: fill secrets
docker compose -f infra/community/docker-compose.yml up -d --build
docker compose -f infra/community/docker-compose.yml ps        # api healthy?
curl -s https://community.loopcom.net/api/health              # {"ok":true,...}
```
- The api container runs `prisma migrate deploy` on start; migrations are additive, so a rollback is `git checkout <previous tag>` + `up -d --build` — no down-migrations are needed (never write destructive ones).
- Rollback of a bad web build: same command on the previous tag; the api can stay.
- Feature kill switch without a deploy: `/admin/flags` → toggle `enabled` off (emergency disable); flags are read live.

## Health & what to look at first

| Symptom | Check | Fix |
|---|---|---|
| Web loads, everything 401 | api `/health`; `COMMUNITY_JWT_SECRET` changed? | restore the secret (rotating it signs everyone out); check nginx `/api/` proxy |
| Realtime badges never update | nginx `proxy_buffering off` + `proxy_read_timeout` on `/api/`; `/admin/overview` → sockets | fix nginx; SSE reconnects by itself |
| Emails not arriving | `/admin/notifications/health`; `OutboundMail` rows with channel `email-failed` | fix `SMTP_URL`; the `mail.retry` job re-sends parked rows every 2 min |
| Push not arriving | `/admin/notifications/health` pending push; `DeviceToken` rows | Expo push tokens only (`ExponentPushToken[...]`); dead tokens are pruned automatically |
| Uploads fail | api logs `file_processing`; disk/S3 permissions | `COMMUNITY_STORAGE_DIR` writable or S3 creds; rejected rows stay REJECTED |
| Feed/search slow | `/admin/overview` p95; `dbMs` in `/health` | run `EXPLAIN ANALYZE` on the feed candidate query; the trigram threshold is a db-level setting (migration `20260918160000`) |
| Loopcom SSO fails | `LOOPCOM_API_URL` reachable from the box (`curl $LOOPCOM_API_URL/health`) | the SSO route returns 401 with a human sentence; nothing else is affected |

## Backups & restore drill

```bash
COMMUNITY_DATABASE_URL=… BACKUP_DIR=/var/backups/loopcom-community BACKUP_PASSPHRASE=… scripts/community/backup.sh      # nightly cron
COMMUNITY_DATABASE_URL=… BACKUP_DIR=/var/backups/loopcom-community BACKUP_PASSPHRASE=… scripts/community/restore-drill.sh # weekly cron — MUST print "restore drill OK"
```
Backups: `pg_dump --format=custom`, AES-256 with gpg, sha256 sidecar, 30-day retention. The drill restores into a scratch database, checks migrations, orphan rows and the one-accepted-quote invariant, then drops it. Object storage (`community_storage` volume or the S3 bucket) is backed up by the host's snapshot/versioning — enable versioning on the bucket.

## Moderation on-call

- Queue: `/admin/moderation` (badge = open cases). Severity stripe: high = SCAM/PHISHING/MALWARE, medium = impersonation/fake job/fake company/mass solicitation.
- Every action needs a note (≥ 10 chars) and shows the person a plain-English message; restrictions expire on their own (`moderation.lift` job); a second outreach restriction inside 90 days doubles.
- Appeals appear in the same queue with status APPEALED.
- The anti-spam sweep raises cases automatically (never bans). Signals are explainable rows on the case.

## Security incidents

- Leaked JWT secret: rotate `COMMUNITY_JWT_SECRET` → every access token dies within 15 min; refresh tokens are unaffected (hashed rows) — to force everyone out also `UPDATE "Session" SET "revokedAt" = now()`.
- Compromised account: `/admin/users/:id` → status SUSPENDED (revokes sessions) → investigate `/admin/audit?actorId=`.
- Suspicious signups: `/admin/security` (failed-login spikes per ip/email, new-device alerts, resets).

## Data requests

- Export: the person does it from Settings → Your data (JSON). Staff can trigger the same route for them.
- Deletion: Settings → Delete → 14-day grace → `person.purge_deleted` job anonymises; content sent to others is attributed to "Deleted member".

## Local dev quick reference

See `docs/community/README.md`. Tests: `pnpm --filter @loopcom/community-api test` (232 integration tests on the real db), `test:tier1` (17 flows × 20), `test:load`, `test:chaos`, `test:controls`, `docs:generate`; web: `npx playwright test`.
