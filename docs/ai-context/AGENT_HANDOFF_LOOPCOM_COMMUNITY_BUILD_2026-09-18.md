# ⛔⛔ AGENT HANDOFF — Loopcom Community BUILD (2026-09-18) — READ FIRST before touching `apps/community-api`, `apps/community-web`, `infra/community/` or `docs/community/`

Izzy, 2026-09-18, after the mockups: *"Build it like this. Do not stop until you meet all my requirements … To the letter, 120%."* Then, mid-build: *"Do not deploy it, though. I'm going to put it on a separate server. Just build it, and then we're going to put it on a separate server with an API into Loopcom. People who log in through Loopcom won't need a separate login. People logging in outside Loopcom board. … start a dev server locally to test it."* And: *"You can also kick off a whole bunch of Sonnet agents if needed to help you out. You manage them."*

**Consequences that shape everything below:**
- ⛔⛔ **NOTHING in this area is deployed and nothing may be deployed to the Connect server.** No `deploy-direct.sh`, no queue, no container. The stack runs locally (`docs/community/README.md`) and later goes to its OWN box via `infra/community/docker-compose.yml`.
- ⛔ **Community is two NEW apps with their OWN database** (`loopcom_community`, `COMMUNITY_DATABASE_URL`) — not routes inside `apps/api`, not pages inside `apps/portal`, not tables in `packages/db`. The 2026-09-18 design handoff's "hosted in the portal" plan is superseded by Izzy's separate-server instruction.
- ⛔ **The ONE integration with Loopcom is `apps/community-api/src/auth/loopcomSso.ts`**: a Loopcom JWT is verified by calling `LOOPCOM_API_URL/me`; the person is created/linked by `loopcomUserId`. Nothing is minted toward Loopcom. The portal-side "Community" link that opens `/sso/loopcom?token=<jwt>` is a LATER, separate portal change (Fourth Rule applies there: nav entry + both toggle screens in one commit).
- ⛔ The Fourth Rule (toggles on `/admin/permissions` + `/admin/roles/[id]`) does NOT apply inside Community — it has its own RBAC (`src/organizations/permissions.ts`, org-level; `StaffGrant` platform-level).

## Where things are

| Piece | Path |
|---|---|
| Conventions every builder follows | `docs/community/CONVENTIONS.md` |
| Run / test instructions | `docs/community/README.md` |
| Control inventory (every `data-testid`) | `docs/community/controls.json` (checked by `pnpm --filter @loopcom/community-api test:controls`) |
| Schema (own db) | `apps/community-api/prisma/schema.prisma` + hand-written migrations (⛔ never `prisma migrate dev` — tsvector generated columns read as drift and it offers a RESET) |
| Api core | `src/app.ts` (buildApp), `src/auth/*` (identity), `src/lib/*` (audit, analytics, notify, realtime, storage, mail, idempotency, search, pagination), `src/policy/graph.ts` (degree/visibility, pure), `src/core/*` (SSE stream, analytics ingest, flags, privacy, devices, schedulers), `src/domains.ts` (registry — a domain not listed there does not exist) |
| Domains | `src/<domain>/routes.ts` + `policy.ts` + `service.ts` + `*.test.ts` |
| Web | `apps/community-web/app/**` (pages), `components/**`, `lib/api.ts` (client + refresh mutex + analytics), `lib/auth.tsx` (me + SSE), `lib/theme.tsx` (data-theme switch; never prefers-color-scheme) |
| E2E | `apps/community-web/e2e/*.spec.ts` (Playwright, real browser, 3 device projects) + `e2e/tools/shot.mjs` for screenshots |
| Tier-1 20× loop | `apps/community-api/src/testing/tier1Loop.ts` (over HTTP against the running api) |
| Server packaging | `infra/community/docker-compose.yml`, `nginx.conf.example`, both `Dockerfile`s |

## Traps found while building (so far)

- ⛔ **This machine's Bash tool cannot pass an apostrophe inside a quoted heredoc** (`cat > f <<'EOF'` … `don't` … → "unexpected EOF while looking for matching `''"`). Use the Write tool for any file containing `'` in prose.
- ⛔ **Claude-in-Chrome cannot reach localhost / 127.0.0.1 / LAN / Tailscale IPs from this profile** ("refused to connect" for a server curl reaches fine). Visual proof therefore comes from Playwright: `node e2e/tools/shot.mjs <url> <out.png> <dark|light>` then Read the PNG. `e2e/tools/console.mjs <url>` prints page errors.
- ⛔ **Next dev mode needs `'unsafe-eval'` in the CSP** (source maps) — `next.config.mjs` adds it only when `NODE_ENV !== "production"`. Without it the whole app rendered a skeleton forever with one console error.
- ⛔ `@fastify/rate-limit`'s `errorResponseBuilder` must return `statusCode: 429` or the error handler reports 500. Tests set `COMMUNITY_RATE_LIMIT_OFF=1` (allowList) — the limiter is a production control, not a test subject.
- ⛔ Bodiless POSTs with `content-type: application/json` are rejected by Fastify by default; `app.ts` installs a parser that treats an empty body as `{}`.
- ⛔ `PUBLIC_PREFIXES` in `src/auth/actor.ts` lists the exact signed-out paths. A protected path wrongly listed there returns a bare 401 `unauthorized` instead of `session_revoked`, and the web cannot tell the difference.
- ⛔ Refresh rotation keeps the previous token valid for 30 s (`ROTATION_GRACE_MS`) so racing tabs both succeed; reuse outside the window revokes the whole session (theft signal). The web serialises refreshes (`lib/api.ts`) and syncs tokens across tabs by BroadcastChannel.
- ⛔ `pnpm install` for the two new packages re-locked pre-existing drift in `pnpm-lock.yaml` (1068+/1440−). It is committed; the Dockerfiles fall back to a non-frozen install if the lock ever disagrees again.
- pgvector is NOT installed on the local Postgres 16; the search migration creates the `embedding` columns only when the extension exists (semantic search is a seam, FTS + trigram is live).

## State (end of the build day, 2026-09-18)

- ✅ **All 22 domains built and integrated** (profiles, organizations+verification, graph, media, notifications, messaging, posts+feed, search, groups, events, jobs, marketplace, rfq, opportunities, intros, crm+QR, recommendations+experiments+flags, moderation+admin+analytics, concierge) — each by one Sonnet agent on disjoint files, verified + committed by me per domain, pushed to `origin/feat/ivr-migration-takeover` (cherry-picked in a throwaway worktree; only Community paths + lockfile/.gitattributes/CI changed outside).
- ✅ **Proof**: 243/243 api integration tests on the real db; Tier-1 loop 17 flows × 20 = 340/340 over HTTP; chaos 5/5; adversarial isolation 5/5; mobile 65/65 + android bundle export; control inventory 786/786; restore drill executed locally (`scripts/community/restore-drill.sh` → OK); load test at 100 VUs found the feed at 58 s p50 → fixed to 0.2–0.5 s and RFQ create 11.5 s → 2.2 s. Playwright E2E: 17 spec files across every area + axe a11y — counts in `docs/community/COMPLETION_REPORT.md`.
- ✅ Docs: `docs/community/{README,CONVENTIONS,ARCHITECTURE,API,ERD,EVENTS,PERMISSIONS,DOMAINS,THREAT_MODEL,RUNBOOKS,parity,COMPLETION_REPORT}.md` + `controls.json`; server packaging in `infra/community/`; CI in `.github/workflows/community.yml`.
- ⏳ **Open (from the completion report):** Next 14.2 advisories → 15.x upgrade gated on E2E; mobile never run on a physical device/emulator; no malware scanner (uploads marked `not-scanned`); no OTel exporter; 1-hour soak not yet run; keys (SMTP/Google/Apple/Anthropic/EAS) unset; the Loopcom-side sidebar link is a later portal change.

## Managing the agents — what worked (for the next multi-agent build)

- One domain per agent, files disjoint by folder (`src/<domain>/`, `app/<route>/`, `components/<domain>/`), shared files append-only and named in the prompt (`lib/notify.ts` classes, `lib/analytics.ts` events, `controls.json`). Zero merge conflicts across ~15 agents.
- Contracts first: `docs/community/CONVENTIONS.md` carried the endpoint shapes other domains would call, so agents building in parallel could call each other's routes before they existed (and fall back to an Empty state, never a fake control).
- Every agent report was verified by re-running its tests myself before committing by pathspec; three agents left the shared Prisma engine dll locked or hit the migration advisory lock — stop the api before `prisma generate`, and check `_prisma_migrations` directly when a deploy hangs.
- The QA agent (E2E + inventory) found 12 real defects the domain agents' green suites missed — the brief's "a green suite is not a driven feature" rule holds: typing in the real UI is a different test.
