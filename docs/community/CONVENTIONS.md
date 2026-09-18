# Loopcom Community — build conventions (read fully before writing a line)

Two apps, one monorepo, their OWN database:

- `apps/community-api` — Fastify 5 + Prisma 6 (schema `prisma/schema.prisma`, client at `node_modules/.prisma/community-client`, imported via `src/db.ts`). ESM, NodeNext: **every relative import ends in `.js`** (`import { x } from "../lib/errors.js"`).
- `apps/community-web` — Next.js 14 app router, React 18, client components (`"use client"`). Path alias `@/`.
- Local dev: `pnpm --filter @loopcom/community-api dev` (port 3101) and `pnpm --filter @loopcom/community-web dev` (port 3100). Postgres on 127.0.0.1:5432, db `loopcom_community`.
- **NEVER deploy anything. NEVER touch `apps/api`, `apps/portal`, `packages/db` or any other existing app.** Community reaches Loopcom only through `src/auth/loopcomSso.ts`.

## The rules that matter most (from Izzy's brief)

1. **Every control works.** No placeholders, no "coming soon", no buttons without handlers, no hardcoded sample data in pages. If it renders, it does something real against the api. If it can't be built yet, don't render it.
2. **Human sentences.** Every api refusal is `throw badRequest("code", "sentence a person can act on")` from `src/lib/errors.ts`. Absence and refusal share `notFound()` (never reveal blocks).
3. **Policy lives in `policy.ts`**, pure functions; routes fetch rows and apply them. Never re-derive a visibility rule inline.
4. **Tests are integration tests against the real local database** using `src/testing/harness.ts` (`testApp()`, `api()`, `createUser()`, `connectUsers()`, `createOrg()`, `grantStaff()`). Every route you add gets a test: happy path, one negative, one permission case. Run `node --import tsx --test src/<domain>/*.test.ts` and paste the pass count in your report.
5. **Every mutation audits** (`audit(db, {...})` from `src/lib/audit.ts`) when it changes account, role, moderation, verification, privacy or admin state; **every user-facing event notifies** through `notify(db, {...})` from `src/lib/notify.ts` (classes are listed there; add a class if yours is missing); **every product event tracks** through `track(db, {...})` from `src/lib/analytics.ts` (event names listed there — add if missing, never log bodies/secrets).
6. **Realtime** = `publishTo(personId, type, data)` / `publishToMany` from `src/lib/realtime.ts`. The web listens with `useAuth().on(type, cb)`. Types already wired in the shell: `notification`, `message` (`{threadId, unreadDelta}`), `thread`, `typing`, `presence`, `connection`, `rfq`, `quote`.
7. **Idempotency**: mutating routes honour `Idempotency-Key` automatically (`src/lib/idempotency.ts`). The web sends `idempotencyKey: newIdempotencyKey()` for connection requests, RFQ create, quote submit/accept, invites, uploads, applications.
8. **Cursor pagination** (`src/lib/pagination.ts`): list routes return `{ items, nextCursor }` with `?cursor=&limit=`.
9. **Search text**: any model with `searchText` must have it rebuilt on every write via `buildSearchText([...])` from `src/lib/search.ts`; search uses `ftsIds()`.
10. **Verified gate**: posting, messaging, connecting, quoting, applying, creating orgs require `person.emailVerifiedAt || phoneVerifiedAt`. Use `requireVerifiedActor(req, db)` from `src/auth/guards.ts`.
11. **Org permissions**: `requireOrgPermission(db, actor, orgId, "org.post")` from `src/organizations/permissions.ts` (owner/admin have everything; preset roles map to keys; CUSTOM = explicit list).

## API shape

- Register routes in `src/domains.ts` (already listed — export exactly the named function from `src/<domain>/routes.ts`: `export function register<Domain>Routes(app: FastifyInstance, db: Db)`).
- Anonymous-readable routes live under `/public/...` (see `PUBLIC_PREFIXES` in `src/auth/actor.ts`). Everything else requires `requireActor(req)`.
- `req.actor` = `{ personId, sessionId, status, username, staffRole, loopcomTenantId }`.
- Validate every body/params/query with zod (`z.object(...).parse(req.body)`); the error handler turns ZodError into 400 `invalid_input`.
- Return plain objects. Dates as ISO strings (Prisma does this). Decimal → string.
- Response shapes for people/orgs must use the shared card builders so the web renders one component: `personCard()` from `src/profiles/cards.ts` and `orgCard()` from `src/organizations/cards.ts` (profiles/organizations agents create these; other agents import them).

## Web shape

- Pages under `app/<route>/page.tsx`, wrapped: `<RequireAuth><AppShell cols="two" title="…">…</AppShell></RequireAuth>` for signed-in pages; public pages (`/people/[username]`, `/companies/[slug]`, `/jobs/[id]`, `/events/[id]`, `/groups/[slug]`, `/rfq/[id]`, `/opportunities/[id]`, `/posts/[id]`) render for anonymous viewers too (use `useAuth().me` to decide what to show; show a "Sign in to …" button instead of a dead control).
- Data via `api<T>(path, { method, body, idempotencyKey })` from `@/lib/api`; errors are `ApiError` with `.code` and human `.message` — show them (`useToast()(msg, {kind:"err"})` or inline).
- UI primitives from `@/components/ui`: `Avatar`, `Chip`, `VChip`, `Button`, `Field`, `Switch`, `Dialog`, `Menu`, `Empty`, `Skeleton`, `Icon`, `useToast`, `timeAgo`, `fmtDate`, `fmtMoney`. Classes from `app/globals.css`: `.card .card.tight .card.hair .ct .btn .chip .in .lbl .tabs .list .li .row .grid2 .grid3 .kv .why .embed .post .bubble .cover .stat .tbl .empty`. **Do not edit `globals.css`**; domain CSS goes in `components/<domain>/<domain>.css` imported by the page.
- Match the mockups: `docs/mockups/loopcom-community/mockups-v1.html` (open it; screens are in the `S.<name>` render functions). Same tokens, same layout, both themes work automatically because everything uses the tokens.
- Every interactive control gets a `data-testid="<screen>-<control>"`. Add each to `docs/community/controls.json` (screen, component, control, action, expected, permissions, api, testId) — the control inventory the E2E suite walks.
- Client analytics: `trackEvent("post_impression", { objectType, objectId, surface, position, recommendationId })` from `@/lib/api`.
- Never `alert()`. Confirm destructive actions with `<Dialog>`; `window.confirm` only for low-stakes.

## Contracts other domains already depend on (build exactly these)

- profiles: `GET /me/profile` · `PATCH /me/profile` (firstName,lastName,headline,about,location,serviceArea[],languages[],industry,objectives[],skills[],links) · `POST/PATCH/DELETE /me/profile/experiences[/:id]` · `…/educations` · `…/services` · `…/certifications` · `…/portfolio` · `GET/PUT /me/profile/preferences` (`{prefs:{searchEngineVisible,findableByPhone,readReceipts,showOnline,messageRequests,analytics}}`, stored in `Person.preferences`) · `POST /me/onboarding/done` · `PATCH /me/username` · `POST /me/avatar` & `/me/cover` (multipart → media) · `GET /public/people/:username` (privacy-filtered view + relationship block: degree, mutual, verifications, canMessage/canCall flags) · `GET /people/:username/activity` · recommendations & endorsements routes.
- organizations: `GET /organizations?q=&limit=` (search, returns `{organizations:[orgCard]}`) · `POST /organizations` (creates + OWNER membership) · `GET /public/companies/:slug` · `PATCH /organizations/:id` · locations CRUD · `GET/POST/PATCH/DELETE /organizations/:id/members` · `POST /organizations/:id/invites` + `POST /organizations/invites/accept` · `POST/DELETE /organizations/:id/follow` · `POST /organizations/:id/claim-loopcom` (links `actor.loopcomTenantId`) · `GET /organizations/:id/audit` · catalog CRUD · verification requests (`POST /organizations/:id/verifications`), domain verification (DNS TXT check).
- graph: `POST /connections/request {personId, message?}` → 201 `{id,status}` · `POST /connections/:id/accept|ignore|withdraw` · `DELETE /connections/:id` · `GET /connections?filter=&q=&cursor=` · `GET /connections/pending` · `POST/DELETE /people/:id/follow` · `POST/DELETE /people/:id/block` · `POST/DELETE /people/:id/mute`, `/organizations/:id/mute` · `POST /reports` · relationship tags CRUD `/people/:id/relationship`, `/organizations/:id/relationship` · `GET /people/:id/mutual`.
- media: `POST /media` (multipart; images resized to thumb 160 / medium 1200 / original; sha256; MIME sniffed from bytes; `kind` image|video|document|audio) → `{asset}` · `GET /media/file/:id/:variant` (public for public assets; signed `?sig=` for private) · `DELETE /media/:id`.
- notifications: `GET /notifications?cursor=&filter=` · `POST /notifications/read` `{ids?|all}` · `GET/PUT /me/notification-prefs` · `GET /notifications/unread-count`.
- posts/feed: `POST /posts` (kinds; media ids; poll; visibility; scheduledFor) · `GET /posts/:id` · `PATCH/DELETE` · comments CRUD + replies · reactions · save · repost · hide · poll vote · `GET /feed?mode=for_you|following|latest|industry|local|opportunities|jobs&cursor=` (each item carries `recommendationId` + `why`) · `POST /posts/:id/impression`.
- messaging: `GET /threads?tab=inbox|requests|archived` · `POST /threads` `{personIds[]}` (DIRECT dedupes by pairKey; a stranger's first message = REQUESTED for the recipient, sender capped at one message until accepted) · `GET /threads/:id/messages?cursor=` · `POST /threads/:id/messages` (kind, body, assetId, replyToId) · edit/delete/react/forward · `POST /threads/:id/accept|decline|read|typing|mute|pin|archive|leave` · SSE events `message`, `thread`, `typing`.
- search: `GET /search?q=&type=all|people|organizations|posts|jobs|listings|groups|events|rfqs|opportunities&...facets` (results carry `why`), `GET /search/suggest?q=`, saved/recent searches.
- Public read: `GET /public/stats` `{people, organizations, openRfqs, jobs}` and `GET /public/rfqs?limit=` (organizations agent builds `/public/stats`; rfq agent builds `/public/rfqs`).

## Reporting back

Keep the final report under 30 lines: files created, routes added, tests run (exact pass/fail counts), anything you could not finish and why. No prose about what you would do next.
