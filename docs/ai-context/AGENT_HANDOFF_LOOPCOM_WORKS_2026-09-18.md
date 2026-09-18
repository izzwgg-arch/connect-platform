# AGENT HANDOFF — LoopCom Works: inventory, architecture, mockups, and the build plan (2026-09-18)

Summary line: `docs/ai-context/claude-md-sections/2026-09-18-loopcom-works-audit-architecture-mockups.md`.
Index line: `CLAUDE.md` → HANDOFF INDEX. Memory: `loopcom-works-project`.

**Status at the end of this task:** inventory DONE (eight audit reports under
`docs/ai-context/loopcom-works-audit/`), architecture DECIDED (below, with the
three decisions that are Izzy's to confirm), mockups PUBLISHED and awaiting Izzy's
review, repo layout DONE. ⛔ **Nothing in the product is changed yet.** The Works
folder is a verbatim copy of `trim pro 2` @ `loopcom` `d380533` (only the legacy
TrimPro DB password was scrubbed from six deploy/diag scripts, and a `.gitattributes`
+ `.gitignore` were added). Izzy asked for mockups before any UI conversion; the
implementation phases start on his word.

---

## 0. What Izzy asked for, in one paragraph

Take TrimPro (six months in production for its original customer, kept running
untouched on its own server) and turn the copy at `Loopcom works/` into **LoopCom
Works**: same layouts and workflows, Loopcom's real look and logo, everything
customer-facing renamed, served at `https://works.loopcom.net` on its **own server**,
with (a) SSO from Loopcom with no second password, (b) standalone sign-in for
companies that don't use Loopcom phones, (c) the **same Loopcom AI assistant** inside
Works for both kinds of users, (d) click-to-call, screen pop, SMS and a communications
timeline through Loopcom's API for entitled companies, (e) a full security + tenant
isolation pass, (f) the mobile app rebranded, (g) production deployment with backups
and monitoring, and (h) 20× repeated E2E proof of every critical flow. Mockups first,
then implementation. Commits go to the **Connect repo** (Izzy, mid-task). Sonnet
subagents may be used for audits; the mockups are the lead's own work.

## 1. Where things are now (repo layout — DONE)

| Thing | Where | Notes |
|---|---|---|
| Works source | `Loopcom works/` in connect-platform (926 files, 11 MB) | Copy of `C:\dev\projects\trim pro 2` branch `loopcom` @ `d380533`. ⛔ Folder name has a space — every script must quote it. Renaming to `loopcom-works` is recommended but was not done (Izzy named it; the desktop session was cwd'd into it). |
| The copy's nested `.git` (3.8 GB) | **moved** to `C:\dev\projects\_backups\loopcom-works-nested-git-2026-09-18\.git` | Git refuses to track a nested repo. Full history also on GitHub `izzwgg-arch/Trimpro` and in `trim pro 2`. Reversible with one `mv`. |
| Ignored junk that must never be committed | `Loopcom works/.gitignore` (appended block, 2026-09-18) | 5 APKs (580 MB), 9 deploy tarballs (2.5 GB), 170 MB logcat/kbd dumps, `.env`, `apps/mobile/credentials.json` (plaintext keystore password — on disk, never tracked). |
| Connect build contexts | `.easignore`, `.dockerignore` | `Loopcom works/` excluded so Connect's EAS uploads and api/portal images don't swallow a second product. |
| Branch | `works/loopcom-works`, worktree `C:\dev\projects\c2-works` | Cut from `origin/feat/ivr-migration-takeover` @ `8fad6359` (the deploy trunk). The shared `Connect 2` tree is 60 ahead / 152 behind origin with other sessions' in-flight work, so Works commits go through the private worktree and are pushed as this branch — a fast-forward onto the trunk when Izzy or the deploy flow merges it. |
| Sync from the dev copy to the worktree | `robocopy "Connect 2\Loopcom works" "c2-works\Loopcom works" /MIR /XD node_modules .next .git .cursor .claude .turbo dist .expo credentials /XF *.tgz *.tar *.tar.gz *.apk *.log .env credentials.json tsconfig.tsbuildinfo kbd-*.txt kbd-*.png mobile-*logcat*.txt trimpro-gap.png tmp-login.html` | Then `git add "Loopcom works"` **in the worktree only** (it is private; the never-`add -A` rule is about the shared tree). |
| Original TrimPro production | `154.12.235.86` (`vmi3019265`), PM2 `trimpro`, branch `restore/pluto-final` | **Untouched. Out of scope.** Its DB, its customer, its GitHub remote stay as they are. Works starts with a fresh database (see §7). |
| Legacy password scrub | `deploy-final.ps1`, `deploy-simple.sh`, `DEPLOYMENT-COMPLETE.md`, `scripts/diag-clients.sh`, `scripts/diag-clients2.sh`, `server-setup.ps1` | The TrimPro prod DB password was in all six; replaced with `<REDACTED-legacy-trimpro-db-password-2026-09-18>` in both copies. ⛔ It is still in the Trimpro GitHub history and on the TrimPro box — rotate it there when convenient (not this project's box). |

## 2. What the audits found (the eight reports, verbatim, are the appendix)

`docs/ai-context/loopcom-works-audit/A1-branding.md` … `A8-deploy.md`. Every claim
there carries a `path:line`. The lead re-read A1–A8 in full; the numbers below are
theirs.

- **A1 Branding** — 787 matching lines in 211 files; ~230 customer-facing. The
  dangerous ones are not the obvious ones: the PDF fallback logo is an SVG **string**
  with the text "TrimPro" burned in (`lib/branding/pdf.ts:43`); `favicon-tp.svg` is a
  literal "TP" monogram; `lib/services/qbo-sync.ts` writes "Trim Pro Service" /
  "Trim Pro Purchase Order" **into customers' QuickBooks**; three different domains
  are hardcoded (`trimprony.com`, `trimpro.app`, `trimpro.com`) in ~55 places
  bypassing `lib/public-url.ts`; `middleware.ts:19` rewrites hosts to
  `app.trimprony.com` in production (functional, not cosmetic); the Terms/Privacy pages
  name TrimPro as the legal party; `credit-memo.ts`/`statement.ts` email templates
  never read tenant branding at all (callers pass the literal string).
- **A2 UI inventory** — 96 pages, 278 API routes, shadcn-style `components/ui/*` on
  Radix. **3,990 hard-coded colour occurrences in 153 files**, `dark:` used **0**
  times, `next-themes` installed but never wired. `--brand-*` CSS vars exist and
  `BrandingProvider` writes them at runtime — the reskin rides that layer. Five files
  fix most pages: `components/ui/select.tsx`, `dropdown-styles.ts`,
  `ViewModeSelector.tsx` (all hardcode `#2E4A59`), `dialog.tsx`, `tabs.tsx`.
- **A3 Mobile** — the real app is `Loopcom works/apps/mobile/` (Expo SDK 54, RN 0.81,
  managed, no native folders; `mobile-app/` at the root is a dead scaffold). 33 screens
  in 5 tabs. `https://app.trimprony.com` is hardcoded in 3 files; deep-link schemes
  `trimpro://`/`trimprofield://` in 7+; bundle id `com.trimpro.field` is welded to
  Firebase project `trimpro-83596` (`google-services.json`, tracked); ~300 inline hex
  colours in screens. A runtime `BrandingContext` already pulls name/colours/logos
  from the backend.
- **A4 Security** — **13 CRITICAL, 7 HIGH, 15 MEDIUM, 11 LOW** across all 277
  routes (none sampled). Criticals: `auth/set-password` has **no auth** (any
  `userId` + password overwrites it); `bootstrap/admin` is unauthenticated and
  ungated; custom roles can grant any permission and a user can self-promote to
  ADMIN; the **Sola payment webhook has no signature check** (anyone can mark an
  invoice paid); `webhooks/sola` fails open; two QuickBooks OAuth callbacks have no
  auth and unvalidated `state`; and **six cross-tenant write paths** (calls,
  schedules, messages/send, invoices, estimates, purchase-orders) accept a foreign
  `clientId/jobId/leadId/conversationId` and leak or corrupt the other tenant's rows.
  Highs: `next.config.js` `env:` block inlines `JWT_SECRET`/`DATABASE_URL`/`REDIS_URL`
  into the bundle config; zero rate limiting on `/api/auth/*`; `app/uploads/[...path]`
  serves every upload with no auth; image optimizer `remotePatterns: '**'` (SSRF);
  VoIP.ms webhook unverified; `next@14.0.4` with known CVEs; no CSP/HSTS/X-Frame.
- **A5 Connect design system** — the tokens are in
  `apps/portal/app/globals.css` (`:root` = dark @ 3410, light @ 12223, console/dash
  @ 13749). Shell: 56px fixed topbar (`auto 1fr auto`), sidebar 280/72px, breakpoint
  1080px, nav link 36px/10px radius/3px accent left rail, icon well 30px. Winning
  component rules: `.btn` 9px radius 7×10px 12px; `.table` 12px with 11px uppercase
  headers; `.chip` 11px pill; `.panel` 11px radius **no shadow**; `.modal` 520px
  14px. Login: 392px card, 18px radius, 2px gradient top line, 44px inputs, 46px
  gradient button. Logo: `loopcom-wordmark-560.png`, one file for both themes
  (Izzy's decision); square mark `loopcom-icon-64.png`. Assistant: 58px FAB
  bottom-right 22/22, panel 372×560 at bottom 92. ⛔ Two portal bugs not to copy:
  `--crm-*` is dark-only globally, and "Inter" is declared but never loaded.
- **A6 Connect agent** — Fastify on 3920, shared Connect Postgres via `@connect/db`,
  no streaming (one long request per turn), JSON-schema `ToolSpec`s with a
  server-verified `ToolContext{tenantId, role, clientUserId}` (the model can never
  name a tenant), three role axes (owner/customer mode; platform staff = SUPER_ADMIN
  only; tool tier customer/internal/staff). **There is already a server-to-server
  identity door**: `resolveIdentity()` in `conversation/routes.ts:28-41` accepts
  `x-agent-internal-secret` + an asserted `body.identity`. `AgentConversation.tenantId`
  is a **plain string, no FK**.
- **A7 Connect telephony/messaging** — api JWT has **no `exp` and no session table**;
  disable is not re-checked per request. One flat internal secret per subsystem
  (`checkInternalSecret`, fail-closed). **No server-side click-to-call exists**
  (`/crm/calls/originate` is advisory; `AriActions.originate` in `apps/telephony` is
  real but has zero callers). Live calls stream on `/ws/telephony` as `LiveCall`
  (already carries CRM match, caller, callee, tenant). **No outbound webhook model
  exists anywhere.** SMS send = `POST /chat/threads` + `/messages` via
  `apps/worker/src/messagingDispatch.ts`. Call history `GET /calls/history`, voicemail
  `GET /voice/voicemail` (with AI transcript). Entitlement = named columns on
  `Tenant` + `ProviderCredential` rows + `PORTAL_PERMISSION_KEYS`.
- **A8 Deploy** — Connect: `scripts/deploy-direct.sh` / deploy queue, blue/green
  (api 3001↔3004, portal 3000↔3005), `.build-commit` verified in-container. Works
  today: `prisma db push --accept-data-loss` in prod, single PM2 fork, uploads at
  `process.cwd()/public/uploads` with no env override, **only 8 of 25 migration.sql
  files are tracked** (`prisma/migrations/*/migration.sql` is gitignored!), schema
  drifted via `db push` since April. 74 env var names in use. TLS = certbot on the
  origin, DNS-only A record (what Connect does).

## 3. Architecture decisions (the master plan — one plan, no forks)

### 3.1 Identity model — immutable ids, never email joins

| Works side (new columns/tables) | Connect side (new) |
|---|---|
| `Tenant.loopcomTenantId String? @unique` — set when linked | `WorksIntegration { id, tenantId @unique, worksOrgId @unique, enabled, linkedAt, linkedBy, revokedAt, createdAt }` |
| `User.loopcomUserId String? @unique` — set on first SSO | nothing on `User` |
| `Tenant.loopcomEntitlements Json` — cached `{ telephony, messaging, ai, lastCheckedAt }` | `Tenant.worksEnabled` is **not** a column; the row above is the switch |
| `User.loopcomExtension String?` (cached from `/user-extensions`) | — |
| `WorksAgentTenantKey` = `loopcomTenantId ?? "works:" + worksOrgId` (derived, not stored) | agent accepts either shape |

- A Works **organization** = TrimPro's existing `Tenant` model (it already exists and
  61/87 models carry `tenantId`). Standalone orgs have `loopcomTenantId = null`.
- A **standalone** Works org that later buys Loopcom phone service is linked by the
  Loopcom admin from `/admin/works` (new page, with its toggles — Fourth Rule): the
  Connect tenant's `WorksIntegration` row is created pointing at the existing
  `worksOrgId`; Works flips `loopcomTenantId` on the next entitlement check. The
  agent's conversation history moves with it? **No** — `works:<orgId>` history stays
  under the old key; the desk shows both. Documented limitation, not a bug.

### 3.2 SSO — authorization-code exchange, server-to-server (no tokens in URLs)

1. Portal nav gets **Works** under Workspace (nav id `workspace.works`, permission
   key `can_view_workspace_works`, in **no** default bucket — same pattern as Loopcom
   Mobile; both toggle editors get their rows per the Fourth Rule).
2. Click → portal `POST /works/sso/start` (ordinary JWT) → api checks
   `WorksIntegration.enabled` for the caller's tenant + the permission key + user
   `status === ACTIVE` → mints a **60-second, single-use** handoff code (the
   `googleLogin.ts` `HandoffRegistry` pattern, `mintGoogleLoginHandoff`, made
   Postgres-backed so it survives an api restart and a second api container) → returns
   `{ url: "https://works.loopcom.net/sso/loopcom?code=…" }` → browser navigates.
3. Works page `/sso/loopcom` (client) posts the code to its own
   `POST /api/auth/sso/loopcom` → Works server calls Connect
   `POST /api/v1/works/sso/exchange { code }` signed as a service (§3.4) → Connect
   burns the code (claim-once) and returns `{ loopcomTenantId, loopcomUserId, email,
   displayName, role, portalPermissionSet, entitlements: {telephony, messaging, ai},
   extension? }`.
4. Works upserts the org link (`Tenant.loopcomTenantId`) — if no Works org is linked
   yet for that tenant, it **creates** one (name from Connect) and makes this user its
   first Admin; otherwise it upserts the user (`User.loopcomUserId`, status ACTIVE,
   role mapped: Connect `TENANT_ADMIN|SUPER_ADMIN` → Works ADMIN, else Works USER —
   Works roles/permissions remain Works-managed after creation, never overwritten on
   later SSOs) — then issues the **existing** Works access/refresh tokens via
   `completeLoginResponse` (`lib/auth/complete-login.ts`) with `clientType: 'web'`
   and the audit action `LOGIN` gets `via: 'loopcom-sso'`.
5. Revocation: every Works refresh-token rotation for a user with `loopcomUserId`
   (≤ every 15 min in practice) calls Connect `POST /api/v1/works/users/validate` (batched, cached 5 min);
   `disabled`/`unentitled` → Works revokes the refresh token and the next request is
   a 401 → sign-in page. Plus Connect pushes `user.disabled`, `user.deleted`,
   `works.entitlement.revoked` events (§3.5) for immediate effect. This is stronger
   than Connect's own sessions (which never expire — A7) and is deliberate.
6. Replay: code is single-claim (DB row, `claimedAt`), 60 s TTL, bound to
   `tenantId + userId`, logged on both sides with the request id.
7. Mobile SSO: the Works phone app offers "Scan a code from Loopcom" — the portal's
   existing `/auth/mobile-qr-exchange` pattern, re-implemented as
   `POST /works/sso/mobile-code` → same exchange door, `clientType: 'mobile'`.
   Standalone mobile login = existing email/password (unchanged).

### 3.3 Works inside Loopcom — seamless navigation, not an iframe

Decision: **top-level navigation with SSO** (option "seamless navigation"), because
(a) Works is a full Next.js app with its own routing, PDF rendering, socket.io
dispatch and uploads — an iframe would break deep links, downloads, `window.open`
pay pages and the back button; (b) a microfrontend would mean two React roots and
two auth contexts on one page for no user-visible gain; (c) SSO already makes the hop
invisible. The portal keeps a "Works" entry in the sidebar and a "Loopcom" entry in
Works' account menu (mockup board 04) so the round trip is one click each way.
Cookies are never shared across origins; nothing is.

### 3.4 The Loopcom ↔ Works API — `/api/v1/works/*` on Connect, `/api/v1/loopcom/*` on Works

**Auth**: one **platform service credential** (Works is first-party, run by us, like
the agent), not a per-customer API key: `WORKS_SERVICE_KEY_ID` + `WORKS_SERVICE_SECRET`
in both `.env`s, two keys may be active at once for rotation. Every call carries
`X-Works-Key`, `X-Works-Timestamp` (±300 s), `X-Works-Nonce` (10-min replay cache in
Redis on both sides), `X-Works-Signature: v1=HMAC-SHA256(secret, ts + "\n" + method +
"\n" + path + "\n" + sha256(body) + "\n" + nonce)`, `X-Request-Id`. Verification
reuses `apps/api/src/internalSecret.ts`'s constant-time compare and the
`urlSigningSecret.ts` HMAC primitive; the route prefix is added to
`jwtPublicRouteBypass.ts` (the footgun A7 §1.2 names). Tenant scoping is by payload
`tenantId`, verified against `WorksIntegration` **on every call** (enabled, not
revoked). Rate limit: 600 req/min per key (Redis).

**Connect exposes (v1):**
| Route | Purpose |
|---|---|
| `POST /api/v1/works/sso/exchange` | code → identity (§3.2) |
| `POST /api/v1/works/users/validate` | `[{loopcomUserId, tenantId}]` → status/entitlement |
| `GET /api/v1/works/tenants/:tenantId/entitlements` | `{telephony, messaging, ai, extensions:[{userId, ext}], smsNumbers:[…]}` |
| `POST /api/v1/works/calls/originate` | `{tenantId, loopcomUserId, to}` → Works user's extension rings first, then the destination (**new** route in `apps/telephony` wrapping the unused `AriActions.originate`; api proxies it). Idempotency-Key required. |
| `GET /api/v1/works/calls/history` | wraps `GET /calls/history` filters (tenant-scoped) |
| `GET /api/v1/works/voicemails` | wraps `GET /voice/voicemail` incl. transcript |
| `POST /api/v1/works/messages/send` | wraps `POST /chat/threads` + `/messages` (SMS/MMS; WhatsApp when the tenant has it). Idempotency-Key required; never retried blindly. |
| `GET /api/v1/works/messages/threads?phone=` | history for a number |
| `POST /api/v1/works/events/subscribe` | registers Works' single event URL + which event types (platform config, one row) |

**Works exposes (v1, called by Connect and by the agent):**
| Route | Purpose |
|---|---|
| `POST /api/v1/loopcom/events` | signed webhook receiver: `call.ringing`, `call.answered`, `call.ended`, `message.received`, `message.status`, `voicemail.new`, `user.disabled`, `user.deleted`, `works.entitlement.changed`. Dedup by `eventId` (table `LoopcomEvent`), 200 fast, process in the existing job runner. |
| `POST /api/v1/loopcom/lookup/phone` | `{tenantId(loopcom), phone}` → client/contact/job match (for screen pop enrichment on the Connect side if wanted) |
| `POST /api/v1/agent/tools/:tool` | the agent's tool door (§3.6) |

Response schema: `{ ok, data }` / `{ ok:false, error:{code, message, requestId} }`,
pagination `{ items, nextCursor }`, every response echoes `X-Request-Id`. OpenAPI
3.1 file committed at `Loopcom works/docs/api/loopcom-works-v1.yaml`, generated
from zod schemas so it cannot drift.

### 3.5 Events — an outbound signed-webhook dispatcher in Connect (new primitive)

`apps/worker/src/webhookDispatch.ts` (sibling of `messagingDispatch.ts`) +
`WebhookSubscription { id, target: WORKS, url, eventTypes[], secretRef, enabled }`
and `WebhookDelivery { id, subscriptionId, eventId, type, payload, attempts, status,
nextAttemptAt, lastError }`. Producers: the telephony service's in-memory call store
(the same feed `TelephonySocketServer` broadcasts — subscribe internally, emit
`call.*` only for tenants with an enabled `WorksIntegration`), the chat ingest
(`message.*`), voicemail create (`voicemail.new`), user admin routes (`user.*`).
Delivery: POST with `X-Loopcom-Signature`, `X-Loopcom-Timestamp`, `X-Loopcom-Event-Id`,
exponential retry 1 min → 24 h, dead-letter after 12 attempts, visible on
`/admin/works` (platform staff). Screen pop = Works receives `call.ringing` with
`{tenantId, callId, direction, from, to, calleeExtension, calleeLoopcomUserId}`,
matches the number to a Client/Contact, and pushes the card over Works' existing
socket.io dispatch channel to the signed-in user whose `loopcomUserId` matches
(mockup board 32). No polling.

### 3.6 The Loopcom AI in Works — one engine, a third identity branch, a Works tool set

- **Caller**: the Works **server** calls the agent (docker-internal `http://agent:3920`
  if Works is reachable on the Connect docker network — it is not, it is another box —
  so: via nginx `location /works-agent/` on the Connect host, mTLS or the same HMAC
  scheme as §3.4, plus a dedicated `WORKS_AGENT_SECRET`). The browser never talks to
  the agent directly; Works proxies `/api/ai/*` → agent, streaming the reply back
  with the same "one long request" semantics the portal has (no streaming exists in
  the agent; do not fake it).
- **Identity**: third branch in `resolveIdentity()` (`apps/agent/src/conversation/routes.ts:28-41`):
  header `x-works-agent-secret` + `body.identity = { source:"works", tenantKey,
  worksOrgId, worksUserId, loopcomUserId?, role:"owner"|"customer", worksRole,
  worksPermissions[] }` (zod). `tenantKey` = `loopcomTenantId` for linked orgs,
  `works:<orgId>` for standalone (no `Tenant` row is created in Connect — verified:
  `AgentConversation.tenantId` has no FK). `clientUserId` = `loopcomUserId ?? "works:"+worksUserId`.
  A Works identity can **never** satisfy `isPlatformStaff`, never sees `staff` tools,
  never reaches `/agent/admin/*`, never gets the Coworker desktop tools.
- **Persona**: `SYSTEM_PROMPT_WORKS` — same voice as the customer prompt, introduces
  itself as "Loopcom AI" (never a model/vendor name — portal rule), knows it is inside
  LoopCom Works, receives `context.page/path` + `context.works: { entity, id }` as
  data, not authority.
- **Tools** (`apps/agent/src/tools/worksTools.ts`, factory pattern, `minRole: customer`,
  every `run()` calls Works `POST /api/v1/agent/tools/:tool` with the verified
  identity in the body — Works re-checks the user's Works permissions server-side and
  answers from its normal services, never raw DB): read — `works_search`,
  `works_get_client`, `works_list_jobs`, `works_get_job`, `works_list_estimates`,
  `works_get_estimate`, `works_list_invoices` (incl. "unpaid"/"not yet invoiced"),
  `works_get_invoice`, `works_list_purchase_orders`, `works_get_vendor`,
  `works_list_tasks`, `works_customer_summary`, `works_schedule` ; write (each drafts
  an `AgentAction` PENDING_APPROVAL that the Works UI renders as a confirm card —
  mockup board 31 — and executes only after the user's click, params-hash-bound) —
  `works_create_estimate_draft`, `works_create_task`, `works_send_invoice`,
  `works_send_message` (via §3.4, only when `entitlements.messaging`),
  `works_call` (click-to-call, only when `entitlements.telephony`),
  `works_create_purchase_order_draft`. Tool audit rows carry
  `{actor, tenantKey, worksUserId, tool, target, result, failureReason}` — never tokens.
- **Entitlement**: `ai` is on for every Works org by default (Izzy: standalone users
  must get the AI); it is a per-org switch in Works settings (mockup board 14) and a
  platform kill switch in Connect (`AGENT_KILL_SWITCH` already exists).
- **UI**: `components/ai/LoopcomAssistant.tsx` in Works = the portal's
  `FloatingAssistant` ported (58px FAB, 372×560 panel, same tokens, opening rows,
  attachments through the agent's chunked upload, mic optional), plus the context
  strip. Mounted in `DashboardLayout` for every signed-in page.

### 3.7 Communications entitlement in the UI — no dead buttons

`Tenant.loopcomEntitlements` (cached, refreshed hourly and on every `works.entitlement.changed`
event) drives: phone numbers render as `tel:` links (today's behaviour) when
`telephony` is off, and as "Call via Loopcom" when on; "Text" buttons and the
communications timeline card exist only when `messaging`/`telephony` are on; the
Settings › Loopcom page explains the state either way (mockup board 14). Failure
handling per Izzy: "Calling is temporarily unavailable" banner, page stays usable
(board 23); message sends carry an Idempotency-Key and are never auto-retried.

### 3.8 Security hardening — every A4 CRITICAL/HIGH fixed before the first deploy

Order of work (each a small, traceable commit with a regression test):
1. `auth/set-password` → requires a valid single-use token bound to the user
   (reuse `generatePasswordResetToken` but **embed `userId` + purpose** and store a
   hash with expiry in `RefreshToken`-style table `PasswordToken`); `forgot/reset`
   the same; temp-password flow keeps working via the same token.
2. `bootstrap/admin` → only when `NODE_ENV !== 'production'` **and** `BOOTSTRAP_TOKEN`
   header matches; removed from the production image's route list.
3. Roles: `roles.*` routes verify role ownership by tenant, a user cannot edit their
   own role/permissions, only `ADMIN` can grant `roles.create|users.edit`; `users/[id]`
   PUT strips `role/tenantId/permissions` unless caller is ADMIN and not self.
4. Sola webhooks: verify the signature (Cardknox/Sola HMAC per their docs, secret in
   env), fail **closed**, reject replays by event id; same for VoIP.ms (shared token
   in URL + IP allowlist) and QuickBooks (`intuit-signature` HMAC is already
   documented by Intuit).
5. QuickBooks OAuth: HMAC-signed `state` carrying `tenantId + userId + nonce`,
   verified on callback; callback requires the same signed-in user.
6. The six IDOR write paths: a shared `assertTenantOwns(model, id, tenantId)` helper
   (`lib/security/tenant-ownership.ts`) applied to every foreign id in
   calls/schedules/messages/invoices/estimates/purchase-orders (+ the MEDIUMs A4
   lists); a Vitest suite that creates two tenants and tries every cross-tenant id
   on every route (the "tenant isolation matrix").
7. `next.config.js`: delete the `env:` block (server code reads `process.env`
   directly; nothing client-side needs those); `remotePatterns` restricted to the
   Works origin + S3/upload host; `images.domains` removed.
8. Rate limiting (Redis, `lib/security/rate-limit.ts`): login 10/15 min per IP +
   5/15 min per email, forgot/reset 5/h, invite accept 10/h, generic API 600/min per
   user; lockout after 10 failed logins (15 min), audit `LOGIN_FAILED`.
9. `app/uploads/[...path]`: auth required, tenant check on the `Attachment` row,
   path normalised and confined to the upload root, `Content-Disposition` set,
   MIME allowlist + 25 MB cap on upload, SVG served as download only.
10. Headers via `middleware.ts` + `next.config.js headers()`: CSP (self + fonts +
    Google Maps + Sola pay domain, `frame-ancestors 'none'`, nonces for the two
    inline scripts), HSTS 1 y preload, `X-Content-Type-Options`, `Referrer-Policy`,
    `Permissions-Policy`, `X-Frame-Options: DENY` (public pay/approve pages get
    their own relaxed CSP).
11. `next` 14.0.4 → latest 14.2.x (not 15 — TrimPro's app router code and
    `puppeteer` PDF path are proven on 14; 15 is a different migration). `xlsx`
    replaced by `exceljs` for import/export (0.18.5 has unfixed advisories);
    `jsonwebtoken` pinned ≥ 9.0.2; `npm audit` gate in CI.
12. Tokens: access stays 15 min; refresh stays 30 d but **HttpOnly cookie for web**
    (`SameSite=Lax`, `Secure`, path `/api/auth`) with the access token still in
    memory/localStorage for the Bearer API — the smallest change that removes the
    refresh token from JS reach without rewriting 278 routes or the mobile app
    (which keeps Bearer + SecureStore). CSRF on the refresh route via the
    double-submit pattern. Audit log gets `SSO_LOGIN`, `LOGIN_FAILED`, `ROLE_CHANGED`,
    `PERMISSION_CHANGED`, `USER_DISABLED`, `INTEGRATION_CHANGED`, `SETTING_CHANGED`.
13. Structured logging (`pino`, request id from `X-Request-Id` or generated, user +
    tenant on every line, never bodies of auth routes) and a `/api/health` that
    checks DB, Redis and disk.

### 3.9 Branding — data-driven where it already is, mechanical where it is not

- `lib/branding/pdf.ts` `DEFAULT_BUSINESS_NAME`, the fallback-logo SVG string,
  `lib/documents/pdf-templates.ts` alt/body text, every email template default,
  `lib/email/shell.ts`, `staff-notification.ts` (5 unparameterised strings),
  `credit-memo.ts` + `statement.ts` callers wired to `getEmailBranding()`, the
  QuickBooks item/private-note strings (`lib/services/qbo-sync.ts` — ⛔ these are
  written into customers' QuickBooks: change the **default** only; existing QBO items
  keep their names).
- `app/layout.tsx` metadata, `manifest.webmanifest`, favicon set from
  `docs/brand/loopcom/favicon/*` + `apple-touch-icon` from `app-icons/ios-light-180.png`,
  OG image from `derived/loopcom-wordmark-h80@2x.png` on a Works plate.
- `components/branding/TrimProLogo.tsx`/`TrimProMark.tsx` → `LoopcomWorksLogo.tsx`
  (the wordmark PNG + "Works" tag lockup from the mockups; component names change
  because they are only imported in 8 places — traced).
- Domains: `lib/public-url.ts` becomes the **only** source; the ~55 literals become
  calls; `middleware.ts` rewrites to `works.loopcom.net`; `NEXT_PUBLIC_APP_URL`
  set in prod. Support address `support@loopcom.net`; sender `noreply@loopcom.net`
  (⛔ Izzy confirms both — §5).
- Terms/Privacy: replace "TrimPro" with "Loopcom LLC" (⛔ legal text — Izzy confirms).
- Mobile: `app.json` name "LoopCom Works", slug `loopcom-works`, scheme
  `loopcomworks://` (+ keep `trimprofield://` accepted for one release so old push
  payloads open), icon/splash from the Signal Core kit, `EXPO_PUBLIC_API_URL`
  centralised (3 files), all strings, `BrandingContext` defaults. **Bundle ids stay
  `com.trimpro.field`** unless Izzy wants a clean identity (§5 — changing them means
  a new Firebase project + every user reinstalls).
- Reskin: `app/globals.css` gets the portal token blocks (`:root` light, `.dark`
  dark, mapped onto the existing `--brand-*` names so `BrandingProvider` keeps
  working), Inter via `next/font` (self-hosted), `components/ui/*` rewritten to
  tokens (the five files first), then a sweep of the 153 files replacing hard-coded
  Tailwind colours with token classes (`bg-panel`, `text-dim`, `border-line`,
  `text-accent`, `bg-accent-soft` — added to `tailwind.config.ts`), `next-themes`
  wired with `class` strategy + the account-menu toggle (board 04), dark tested on
  every page by the E2E screenshot run. Layout stays.

## 4. Deployment plan — the Works server (⏳ box does not exist yet)

Copied from A8 with the lead's decisions:
- **Docker Compose**, modelled on `infra/community/` (the Loopcom Community
  precedent — lighter than Connect's blue/green): `nginx` + `certbot` on the host,
  `works` (Next.js standalone image with `.build-commit` baked in, `puppeteer`'s
  Chrome installed in the image), `postgres:16` (volume, not exposed), `redis:7`
  (not exposed), `works-jobs` (same image, runs the QBO sync worker and the
  reminders that today are hit by external cron — `qbo/worker`, `issues/reminders`,
  `tasks/reminders`, `measuring-requests/reminders`, on an in-container scheduler),
  `backup` sidecar (nightly `pg_dump` + uploads tar → off-box copy to the Connect
  box's `/opt/backups/works/` over SSH, 30-day retention, weekly restore drill script).
- **Migrations**: baseline once (`prisma migrate diff --from-empty --to-schema-datamodel`
  → `0000_baseline`), un-ignore `prisma/migrations/**/migration.sql`, `prisma migrate
  deploy` in the deploy step, **`db push` banned in prod** (the deploy script refuses
  if `DATABASE_URL` host is not localhost and the command contains `db push`).
- **Deploy**: `Loopcom works/scripts/deploy.sh <sha>` — fetch, build image tagged
  `<sha>`, `migrate deploy`, start the new container on the free port (3010/3011
  pair, reserved via `ip_local_reserved_ports` — the Connect lesson), health-gate
  (`/api/health` 200 + `.build-commit` == sha), nginx upstream flip with `backup`
  member (the 09-16 nginx lesson), old container kept for instant rollback
  (`deploy.sh --rollback`). All deploys through this script; agents never
  `docker compose up` by hand (AGENTS.md rule carried over).
- **Ops**: ufw (22 from admin IPs only, 80/443), fail2ban on sshd, unattended
  security upgrades, `logrotate` on container logs, node-exporter + a Connect-side
  uptime probe of `https://works.loopcom.net/api/health` (the existing support
  watcher texts Izzy the way the TURN watch does), disk/mem/CPU alerts at 80 %.
- **Environments**: local (`.env`, `localhost:5432/trimpro`), **staging**
  (`works-staging.loopcom.net`, same compose, separate DB, `ROBOTS: noindex`), prod.
  Staging is where the 20× E2E runs live; prod gets the smoke set.
- **Env var names** (74, from A8 §3.7) go into `Loopcom works/.env.example` with
  comments; secrets in `/opt/loopcom-works/env/.env.production` (mode 600), never in
  the repo.
- **TLS**: DNS-only A record `works.loopcom.net` → new box, `certbot --nginx`, HSTS
  after the first green load.

## 5. Decisions that are Izzy's (answer these and the build proceeds without re-asking)

1. **Mockups** — approve the look at https://claude.ai/artifact/LZvf79qD8f5aF3nfQ55nDy
   (repo copy `docs/mockups/loopcom-works/mockups-v1.html`), or say what changes.
   Specific sub-questions: (a) the "Works" tag next to the LOOPCOM wordmark vs a
   re-rendered "LOOPCOM WORKS" lockup from the kit's author; (b) the sidebar grouped
   into portal-style sections (order unchanged) vs TrimPro's flat list.
2. **Mobile bundle ids** — keep `com.trimpro.field` (push keeps working, store
   listing continues) or new ids `net.loopcom.works` (clean identity, new Firebase
   project, every installed phone must reinstall). Recommendation: keep for v1.
3. **Legal/contact text** — the contracting entity on Terms/Privacy ("Loopcom LLC"?),
   support address (`support@loopcom.net`?), sender (`noreply@loopcom.net`?), and
   whether `sms@loopcom.net`'s mailbox rules apply to Works mail.
4. **Server** — provision the Works box (Contabo like the others? size: 4 vCPU /
   8 GB / 160 GB is enough for Next + Postgres + Chrome-for-PDF) and hand over root
   + a key; DNS for `works.loopcom.net` and `works-staging.loopcom.net`.
5. **Folder name** — OK to rename `Loopcom works/` → `loopcom-works/` (no code
   references it yet; scripts and Docker contexts hate the space)?
6. **Cardknox/Sola** — Works' pay page uses `secure.cardknox.com/trimprony` (the
   merchant path is TrimPro's account). Works customers need their own merchant
   account(s) — this is a business decision, not code.

## 6. Build order (phases; each ends committed, pushed, tested, documented)

| # | Phase | Proof |
|---|---|---|
| 0 | Repo layout, audits, architecture, mockups (**this task**) | this handoff, artifact |
| 1 | Security criticals + highs (§3.8 1–13) on the unbranded app | tenant-isolation matrix test (2 tenants × every route), auth tests, 20× login/logout/reset via Playwright on staging |
| 2 | Branding + reskin per approved mockups; microcopy pass; a11y pass | Playwright screenshot run of all 96 pages × light/dark × 8 viewports; zero `trimpro` in customer-facing grep |
| 3 | Works server + staging + prod deploy tooling + backups + monitoring | deploy → health → restore drill executed and logged |
| 4 | Connect side: `WorksIntegration`, `/api/v1/works/*`, SSO, `/admin/works` with toggles, webhook dispatcher, originate route | 20× SSO E2E (portal → Works), revocation E2E, webhook replay/dedup tests |
| 5 | Works side: SSO landing, entitlements, click-to-call, screen pop, messaging, timeline | real call/text on a Loopcom test tenant, observed by a human |
| 6 | Agent: Works identity branch + tool set + Works proxy + assistant UI | E2E: standalone user and SSO user each run read + confirm-gated write tools; cross-tenant attempt refused |
| 7 | Mobile: rebrand, API URL, SSO-by-code, EAS preview builds (internal only — Izzy said not the stores) | APK/IPA smoke on emulator + a real device |
| 8 | 20× stress: every critical workflow, concurrency (duplicate invoice/PO numbers), multi-user, multi-tenant, browsers | the FEATURE/TEST/RESULT/ITERATIONS/EVIDENCE matrix + screenshots |

## 7. Things a future session must not get wrong

- ⛔ TrimPro's live server and DB are **not** Works. Never point a Works deploy at
  `154.12.235.86`; never import its data without Izzy's explicit instruction (the
  schema is identical, so a one-off `pg_dump | psql` is possible later if he wants
  a customer moved).
- ⛔ `prisma/migrations/*/migration.sql` is **gitignored** in the Works copy
  (`.gitignore:44`). Until phase 3 removes that line and baselines, a fresh clone
  cannot `migrate deploy`. Do not "fix" it by `db push` on any shared DB.
- ⛔ The nested `.git` backup at `C:\dev\projects\_backups\…` is the only local copy
  of the pre-import history; GitHub `izzwgg-arch/Trimpro` is the other. Never push
  Loopcom work there.
- ⛔ Browser 1 (the office Chrome that is signed in to the portal) froze its
  renderer on `/dashboard` twice today ("Application error: a client-side
  exception") — a portal issue, out of scope, noted for whoever owns the dashboard.
- ⛔ The mockup review canvas at 1280 px is scaled with CSS `transform`; the phone
  boards are 390 px real. Every value in it traces to `A5-connect-design-system.md`;
  if the portal's tokens change, regenerate from `part1..4.html` in the session
  scratchpad (not preserved) — or edit `mockups-v1.html` directly.
