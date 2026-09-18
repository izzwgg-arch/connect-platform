# TrimPro (Loopcom Works) Security Audit — A4-security

Scope: `C:\dev\projects\Connect 2\Loopcom works\` (Next.js 14 app-router + Prisma/Postgres multi-tenant SaaS).
Method: static read-only source review. No writes, no server started, no network calls, no destructive actions.
Status: **COMPLETE** — all six parallel read-only sub-audits covering all 277 `route.ts` files under `app/api/`
(clients/estimates/invoices; jobs/purchase-orders/vendors/items/credit-memos/dispatch;
notifications/email/integrations/qbo; reports/analytics/branding/leads/misc;
schedules/tasks/issues/requests/measuring/notes/attachments/uploads/mobile; payments/users/roles/messages/sms)
have reported in, plus the lead auditor's direct, independent review of `app/api/public/**`, `app/api/webhooks/**`,
auth/session infrastructure, injection surfaces, headers/CORS, secrets, and dependencies. No route was sampled —
every file in every group was individually read and traced into any `lib/` helper it delegates to; a small
number of files are explicitly marked UNVERIFIED where noted rather than guessed.

---

## Executive summary

| Severity | Count | Findings |
|---|---|---|
| **CRITICAL** | **13** | 1. `auth/set-password` — unauthenticated full account takeover (any user, any tenant) · 2. `bootstrap/admin` — unauthenticated admin/tenant creation, no env gate · 3. Custom-role privilege escalation via `roles` (POST/PUT) + `users/[id]` (PUT) — self-promotion to full tenant ADMIN with only `users.edit`, independently confirmed by two sub-audits from opposite ends of the chain · 4. `webhooks/sola-payment` — completely unauthenticated, live production payment webhook (fake-paid invoices, real QBO sync + receipt emails) · 5. `webhooks/sola` — fail-open signature verification (same exposure when signature header/secret absent) · 6. `integrations/quickbooks/callback` — no auth, unvalidated OAuth `state` → cross-tenant QuickBooks token hijack · 7. `qbo/callback` — same OAuth CSRF pattern, worse due to a platform-wide shared client secret · 8. `calls/route.ts` POST — cross-tenant IDOR, full client/contact/job object returned in response · 9. `schedules` POST/PUT — cross-tenant IDOR, full `Lead` PII (name/email/phone/address/notes) disclosed via GET · 10. `messages/send` — cross-tenant `conversationId` accepted unchecked → message injection/spoofing visible in the victim tenant's own inbox · 11. `invoices/route.ts` POST — cross-tenant `jobId` accepted unchecked → data disclosure **and** cross-tenant financial-rollup corruption (victim's `Job.actualAmount` overwritten) · 12. `estimates/route.ts` POST — cross-tenant `clientId`/`leadId`/`jobId` accepted unchecked → full client PII disclosure · 13. `purchase-orders` POST/PUT — cross-tenant `jobId` accepted unchecked → fabricated PO persists into the **victim** tenant's own job page |
| **HIGH** | **7** | 1. `next.config.js` `env` block exposes `JWT_SECRET`/`JWT_REFRESH_SECRET`/`DATABASE_URL`/`REDIS_URL` to any client component that ever references them (none currently do, but the footgun is live) · 2. No rate limiting/brute-force/lockout protection on `auth/login`, `refresh`, `reset-password`, `set-password`, `forgot-password` (the capability exists elsewhere in the codebase and simply wasn't applied here) · 3. `app/uploads/[...path]/route.ts` — fully unauthenticated public file serving of every uploaded attachment (cross-tenant and anonymous) · 4. `next.config.js` `images.remotePatterns: [{hostname:'**'}]` — Next.js image-optimizer open SSRF, any HTTPS URL · 5. `webhooks/voipms` — zero authentication, injects attacker-controlled "inbound SMS" into a tenant's live CRM inbox + staff notifications · 6. `next@14.0.4` — multiple known framework CVE families unpatched (CVE-2025-29927 middleware bypass and others; ~2 years behind current 14.x) · 7. No security headers anywhere (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options` all absent platform-wide) |
| **MEDIUM** | **15** | webhook tenant-misattribution via "use first connection" (`webhooks/sola`, `webhooks/webwhatis`) · incomplete/fail-open WhatsApp webhook signature checks (currently low-impact only because message persistence there is unimplemented) · SVG stored-XSS via uploads (`image/svg+xml` allowlisted + served `inline`) · spoofable mobile/web permission routing via `?mobile=true` (`issues`, `tasks` routes) · view-permission (`*.view`) gating a write action on attachments (Finding A) · unverified nested FKs recurring across `estimates`/`invoices`/`items`/`bundles`/`credit-memos`/`purchase-orders` line items and `sms/send` (`sourceItemId`/`vendorId`/`categoryId`/`componentItemId`/`clientId`/`jobId` — catalog/vendor data disclosure, non-PII) · unscoped QBO sync-log existence oracle (`estimates/[id]/qbo-debug`) · email open-relay (`email/send`, `reports/email` — arbitrary recipient, authenticated) · dead `canAccessResource()` with SQL-injection-shaped `$queryRawUnsafe` (unreachable today, latent trap) · `generatePasswordResetToken()` not bound to a specific user in its own signed claims (design smell, not directly exploitable as coded) · CSV formula/injection risk on `items/export`/`vendors/export` (no leading `=/+/-/@` neutralization) · tasks/issues accept unverified `leadId`/`invoiceId`/`issueId` (Findings D/F) · JWT default-secret fallback string checked into `lib/auth.ts` (contingent on deployment env hygiene) |
| **LOW / INFO** | **11** | tokens in `localStorage`, no httpOnly-cookie option (raises the stakes of any XSS, architectural) · reset-token logged to server console on email-send failure · `generateTemporaryPassword()` uses `Math.random()` (dead code, unreferenced) · unvalidated `IssueWatcher.userId` (Finding B, no current disclosure path) · SSE token-in-query-string trade-off (`messages/stream`) · generous 1GB per-file upload ceiling with no visible per-tenant quota · `.env` present in working tree with real secret values but correctly gitignored, never committed · Firebase client key in `apps/mobile/google-services.json` (expected/non-secret by design) · `next.config.js` disables `typescript.ignoreBuildErrors`/`eslint.ignoreDuringBuilds` for production builds · `xlsx@0.18.5` known advisories present but usage in this repo is write-only (lower real exploitability) · `jsonwebtoken` `verify()` calls don't explicitly pin `algorithms: ['HS256']` (defense-in-depth hardening, not independently exploitable given this app never uses asymmetric keys) |

**Total: 46 distinct findings** across CRITICAL/HIGH/MEDIUM/LOW-INFO, from a full, non-sampled read of all
277 `route.ts` files plus the auth/session, public/webhook, injection, headers, secrets, and dependency surfaces
named in the brief.

---

## Section 1 — Tenant isolation sweep (277 `route.ts` files, excluding `app/api/public/**`, `app/api/webhooks/**`, `app/api/health`)

Methodology: six parallel read-only sub-audits, each covering a functional area, using the following ground truth
(verified directly by the lead auditor):

- `lib/middleware.ts` `authenticateRequest(request)` reads `Authorization: Bearer`, verifies the JWT, loads the user,
  checks `status === 'ACTIVE'`, and on success sets `(request as any).user = { id, tenantId, email, role }`. Callers
  must check its return value and return it on non-null.
- `lib/authorization.ts` / `lib/api-guards.ts` expose `requirePermission`/`requireAnyPermission`/`requireCrudPermission`/
  `requireMethodPermissions`/`requireMobilePermission`/`requireWebOrMobilePermission` — same "returns `NextResponse|null`,
  caller must check" pattern.
- There is **no tenant-scoping Prisma middleware or wrapper anywhere in the codebase.** Every route is individually
  responsible for adding `tenantId: user.tenantId` to every Prisma `where` clause touching a tenant-owned model.
- The root Next.js `middleware.ts` performs only an HTTPS/host redirect for stale customer links and explicitly
  excludes `/api/` from its matcher — it provides **zero** authentication or tenant enforcement.

### 1.A — Groups reported so far

#### Group: clients / estimates / invoices (43 files)

| route | auth? | permission guard? | tenant-scoped? | note |
|---|---|---|---|---|
| clients/[id]/contacts/[contactId]/route.ts, clients/[id]/contacts/route.ts | Y | Y | YES | `getTenantContact()` verifies client tenant first |
| clients/[id]/documents/route.ts, notes/route.ts, payments/route.ts, picker/route.ts, route.ts, statement/route.ts | Y | Y | YES | all client-tenant-checked before use |
| clients/picker/route.ts, clients/route.ts | Y | Y | YES | GET/POST/DELETE all scoped; bulk delete pre-loads by tenant+id |
| estimates/[id]/approvals, bundles, convert-to-invoice, convert-to-job, duplicate, groups/[groupId], groups/[groupId]/ungroup, groups/[groupId]/update-from-template, material-lines, material-lines/[lineId], pdf, send | Y | Y | YES | scoped |
| estimates/[id]/groups/[groupId]/items/route.ts | Y | Y `estimates.edit` | PARTIAL | estimate+group tenant-checked, but `sourceItemId` from body stored unverified — see evidence |
| estimates/[id]/qbo-debug/route.ts | Y | Y `system.integrations` | **NO** | sync-log lookup has no tenant filter — see evidence |
| estimates/[id]/reimport-lines/route.ts | Y | Y `estimates.edit` | YES | delegates to `reimportEstimateLines()`, which requires the sync-log match the caller's own `integrationId` — safe |
| estimates/[id]/route.ts (GET/DELETE) | Y | Y | YES | |
| estimates/[id]/route.ts (PUT) | Y | Y | PARTIAL | `clientId` verified; `vendorId`/`sourceItemId`/`sourceBundleId` per line item unverified — see evidence |
| estimates/next-number/route.ts | Y | Y | N/A | no id param, scoped to caller's own tenant |
| **estimates/route.ts (POST)** | Y | Y `estimates.create` | **NO** | **CRITICAL — `clientId`/`leadId`/`jobId` stored with zero tenant verification — see evidence** |
| invoices/[id]/bundles, duplicate, groups/[groupId], groups/[groupId]/ungroup, groups/[groupId]/update-from-template, mark-paid, pdf, portal-pay-url, qbo-ach, send | Y | Y | YES | scoped; mark-paid/bulk-manual-payments re-guard tenant inside `applyInvoicePayment` |
| invoices/[id]/groups/[groupId]/items/route.ts | Y | Y `invoices.edit` | PARTIAL | same `sourceItemId` gap as the estimates equivalent |
| invoices/[id]/route.ts (GET/DELETE) | Y | Y | YES | |
| invoices/[id]/route.ts (PUT) | Y | Y | PARTIAL | `clientId` **and** `jobId` correctly cross-checked at top level (well implemented) but `vendorId`/`sourceItemId`/`sourceBundleId` per line item unverified — see evidence |
| invoices/bulk-manual-payments/route.ts, export/route.ts | Y | Y `payments.manage`/`invoices.export` | YES | scoped |
| **invoices/route.ts (POST)** | Y | Y | **NO** | **CRITICAL — `jobId` stored + propagated into job-cost rollup with zero tenant verification — see evidence** |

**CRITICAL — `app/api/invoices/route.ts` POST — cross-tenant data disclosure AND cross-tenant financial-rollup corruption**
```ts
const { clientId, jobId, estimateId, ... } = body
const client = await prisma.client.findFirst({ where: { id: clientId, tenantId: user.tenantId } })  // clientId IS checked
if (!client) return 404
...
const baseInvoiceData = { tenantId: user.tenantId, clientId, jobId: jobId || null, ... }  // jobId is NEVER checked
invoice = await tx.invoice.create({ data: { ...baseInvoiceData, invoiceNumber }, include: { client: true, job: true } })
...
let linkedJobId: string | null = jobId || invoice.jobId || null
if (linkedJobId) { await syncJobCostFromLinkedDocuments(linkedJobId) }
```
`syncJobCostFromLinkedDocuments()` (`lib/jobs/sync-job-cost.ts:16-27`) also has no tenant check —
`db.job.findUnique({ where: { id } })`, then `db.job.update({ where: { id }, data })`, a **cross-tenant write**.
**Repro:** authenticated Company-A user who knows/guesses Company B's `jobId`:
`POST /api/invoices {"clientId":"<own client>","jobId":"<Company B job id>","title":"x","lineItems":[...]}`
→ `201` response embeds Company B's full `job` object (title, jobNumber, address, financials), **and** Company
B's `Job.estimateAmount`/`actualAmount` are silently recalculated to include the rogue invoice.

**CRITICAL — `app/api/estimates/route.ts` POST — cross-tenant client PII disclosure**
```ts
const { clientId, leadId, jobId, ... } = body
const baseEstimateData = { tenantId: user.tenantId, clientId: clientId || null, leadId: leadId || null, jobId: jobId || null, ... }
estimate = await prisma.estimate.create({ data: { ...baseEstimateData, estimateNumber }, include: { client: true, lead: true } })
```
None of `clientId`/`leadId`/`jobId` are tenant-verified (contrast with the sibling `PUT /api/estimates/[id]`,
which correctly verifies `clientId` — confirming this is an oversight in the create path specifically).
**Repro:** `POST /api/estimates {"clientId":"<Company B client id>","title":"x"}` then
`GET /api/estimates/<new id>` → response's `estimate.client` is Company B's full client record (name, email,
phone, billing address, primary contact).

**NO — `app/api/estimates/[id]/qbo-debug/route.ts:19-36`**
```ts
const syncLog = await prisma.quickBooksSyncLog.findFirst({ where: { entityId: params.id, type: 'estimate' }, ... })
// no tenantId/integrationId filter — unlike the sibling reimportEstimateLines(), which requires
// integrationId: session.integrationId (the caller's own tenant-bound QBO connection) and is safe
```
Resolves another tenant's estimate→QBO-id mapping given a foreign `estimateId`; the route also has no
try/catch around the subsequent QBO API call, so a foreign id surfaces as an uncaught 500 instead of a clean
404 — a cross-tenant existence oracle. MEDIUM (QBO internal id disclosure + oracle, not full PII).

**PARTIAL (MEDIUM) — unverified nested FKs on line items, repeated in 4 places:**
`estimates/[id]/groups/[groupId]/items/route.ts`, `invoices/[id]/groups/[groupId]/items/route.ts`,
`estimates/[id]/route.ts` PUT, `invoices/[id]/route.ts` PUT all accept `sourceItemId`/`vendorId`/`sourceBundleId`
from the request body and persist them without checking they belong to `user.tenantId`, while the GET/PDF paths
for these same documents `include` the `sourceItem`/`vendor` relations with no tenant filter — so a foreign
tenant's catalog item name/kind or vendor name can be pulled into your own tenant's document and read back.
Lower severity than the two CRITICAL findings (catalog/vendor names only, not customer PII).

#### Group: jobs / purchase-orders / vendors / items / credit-memos / dispatch (55 files)

51 of 55 fully tenant-scoped (YES). Every route in this group correctly calls `authenticateRequest` and pairs it
with a permission guard — the only defects found are the recurring "relation id from body not tenant-verified"
pattern seen elsewhere in this report, on 4 files:

| route | tenant-scoped? | note |
|---|---|---|
| `credit-memos/[id]/route.ts` (PUT) | PARTIAL | body `jobId` written unverified; response echoes `job: {id, jobNumber, title}` |
| `items/[id]/route.ts` (PUT), `items/route.ts` (POST) | PARTIAL | body `vendorId`/`categoryId` written unverified; GET echoes `vendor: {id, name, email, phone}` |
| `items/bundles/[id]/route.ts` (PUT), `items/bundles/route.ts` (POST) | PARTIAL | component `componentItemId`/`componentBundleId`/`vendorId` written unverified; `flattenBundle()` follows the FK with no tenant filter, returning full catalog fields (name/sku/description/price/cost) |
| **`purchase-orders/[id]/route.ts` (PUT), `purchase-orders/route.ts` (POST)** | **NO (CRITICAL — durable cross-tenant data injection)** | body `jobId` written unverified — see evidence below; this is the most severe finding in this group |

All other 51 files (jobs/**, dispatch/**, vendors/**, credit-memos list/apply/pdf/send/void/import,
items/duplicate/categories/export/import/picker, purchase-orders/approve/duplicate/pdf/receive/send/next-number)
correctly re-verify every nested relation id (`clientId`, `jobId`, `invoiceId`, `assigneeId`/`workerId`,
`vendorId` where checked) against `user.tenantId` before use — e.g. `dispatch/assign` and
`jobs/[id]/link-invoice` are cited by the sub-audit as the *correct* pattern the PARTIAL files above should have
followed.

**CRITICAL — `app/api/purchase-orders/route.ts` (POST) / `purchase-orders/[id]/route.ts` (PUT) — cross-tenant FK
injection that surfaces on the *victim* tenant's own job page**
```ts
// route.ts POST
jobId: jobId || null,               // never checked against user.tenantId
...
sourceItemId: item.sourceItemId || null,
sourceBundleId: item.sourceBundleId || null,
```
```ts
// [id]/route.ts PUT — identical pattern
jobId: jobId !== undefined ? (jobId || null) : existing.jobId,
```
Unlike `dispatch/assign`/`jobs/[id]/link-invoice` in the same codebase, which explicitly re-verify a foreign
`jobId` before writing, these two routes take `jobId` straight from the body. This is more severe than the
sibling PARTIAL findings because `jobs/[id]/route.ts` GET (confirmed correctly tenant-scoped **for the job
itself**) includes `purchaseOrders: { orderBy, include: { lineItems } }` **with no secondary tenant filter on
that relation** — it trusts the PO was already tenant-verified when created, which is exactly the assumption
this bug breaks. **Repro:** Company-A user, `POST /api/purchase-orders {"vendor":"Fake Vendor","jobId":"<Company
B job id>","lineItems":[{"description":"x","quantity":1,"unitPrice":1}]}` → response leaks Company B's
`job.client.name`; then when a **Company-B** user later opens their own job (`GET /api/jobs/<jobB id>` with
their own token), the response's `purchaseOrders[]` array now contains Company A's fabricated purchase order —
a durable, cross-tenant **data-injection** into the victim's own tenant view, not merely a read leak on the
attacker's side.

**Reliability note (not a security finding) — `app/api/dispatch/stream/route.ts`:** confirmed the route only
accepts `Authorization: Bearer` (no query-string token fallback anywhere in `lib/middleware.ts`), yet the only
client call site (`app/dashboard/dispatch/page.tsx`) opens it with a native `EventSource`, which cannot attach
custom headers and has no polyfill in this codebase. As wired, real browser SSE connections to this route should
receive 401 before reaching any tenant-scoped query — flagging as a likely-broken live-dispatch feed for the
team to confirm, not a tenant-isolation issue (the route's own Prisma queries, when reached, are correctly
scoped by `user.tenantId`).

#### Group: payments / users / roles / messages / sms (36 files)

| route | auth? | permission guard? | tenant-scoped? | note |
|---|---|---|---|---|
| messages/conversations/** (react, [messageId], messages, read, route, conversations list) | Y | Y | YES | internal team chat correctly membership+tenant scoped via `getConversationForMember` |
| messages/dm/route.ts, messages/job/ensure/route.ts, messages/team/ensure/route.ts | Y | Y | YES | scoped |
| **messages/send/route.ts** | Y | Y `messages.send` | **NO** | **CRITICAL — cross-tenant `conversationId` accepted unchecked — see evidence** |
| messages/stream/route.ts | Y (header or `?token=`) | Y `messages.view` | YES | membership query tenant+user scoped; token-in-URL is a standard SSE trade-off, noted |
| messages/unified/route.ts | Y | Y `messages.view` | PARTIAL | primary queries scoped, but nested `messages` include is unscoped — surfaces the injected message from the finding above |
| messages/users/route.ts | Y | Y | YES | |
| payments/[id]/receipt, payments/[id]/route.ts (PATCH/DELETE), payments/history | Y | Y | YES | amount always clamped server-side against invoice; refund idempotency via unique `idempotencyKey` |
| payments/qbo/ach/create-session, debug, status, webhook | Y or HMAC/shared-secret | Y or N/A | YES | webhook uses HMAC+timingSafeEqual, fails closed |
| payments/qbo/receipts/retry, reconcile | N (shared-secret cron) | N/A | N/A by design | `timingSafeEqual` bearer-secret check, fails closed if unset |
| payments/refund/route.ts | Y | Y `payments.refund` | YES | server-computed `refundableRemaining`, idempotent |
| payments/sola/compact-links, payments/sola/link | Y | Y `payments.manage` | YES | see minor note on unrestricted `webhookUrl` body field below |
| **roles/route.ts (POST), roles/[id]/route.ts (PUT)** | Y | Y `roles.create`/`roles.edit` | YES (row access) | **CRITICAL escalation-control gap — see evidence (confirms lead auditor's independent finding)** |
| sms/conversations/[id]/messages/route.ts, sms/route.ts | Y | Y | YES | validates `conversation.findFirst({id, tenantId})` before delegating |
| sms/conversations/route.ts (GET) | Y | Y | PARTIAL | nested `messages` include unscoped — same pattern as `messages/unified` |
| **sms/send/route.ts** | Y | Y `messages.send` | PARTIAL | `clientId`/`contactId`/`jobId`/`leadId` stored+`include`d unverified — see evidence |
| users/[id]/reinvite/route.ts, users/invite/route.ts, users/route.ts | Y | Y `users.create`/`users.view` etc. | YES | tenantId always from token, never body |
| **users/[id]/route.ts (PUT)** | Y | Y `users.edit` (only) | YES (row access) | **CRITICAL — self-promotion to ADMIN, no self-edit guard — see evidence (confirms lead auditor's independent finding)** |
| users/[id]/route.ts (DELETE) | Y | Y `users.deactivate` | YES | correctly blocks `params.id === actor.id` |
| users/me/avatar/route.ts | Y | N/A (self only) | YES | minor Host-header note below |

**CRITICAL — `app/api/messages/send/route.ts` — cross-tenant message injection/spoofing**
```ts
const { conversationId, to, from, body: messageBody, channel, media } = body
const result = await messagingService.sendMessage(user.tenantId, { to, from, body, channel, media }, conversationId)
```
`lib/messaging/service.ts:193-194`: `conversationId ? await prisma.conversation.findUnique({ where: { id: conversationId } }) : null`
— **no `tenantId` filter**. The route never validates the conversation belongs to the caller's tenant before
passing it through. The service then `create`s a `Message` row against that foreign conversation and bumps its
`lastMessageAt`/`channel`. Because `app/api/sms/conversations/route.ts` and `app/api/messages/unified/route.ts`
both `include` the nested `messages` relation **without a tenant filter on that relation**
(`messages: { orderBy: { createdAt: 'desc' }, take: 1, select: {...} }`), the victim tenant's own conversation
list surfaces the attacker's injected message as their "latest message" preview and resorts it to the top of
their inbox. **Repro:** Tenant-A user with ordinary `messages.send`,
`POST /api/messages/send {"conversationId":"<Tenant B conversation id>","to":"+1555...","body":"attacker text","channel":"SMS"}`
→ Tenant B's next `GET /api/sms/conversations` shows the injected text as the newest message. Note
`sms/conversations/[id]/messages/route.ts` is **not** vulnerable — it separately validates
`conversation.findFirst({id, tenantId})` before calling the same service function; the bug is specific to the
one route (`messages/send`) that skips that check.

**CRITICAL — privilege escalation via custom roles (independently confirmed)** — `app/api/roles/route.ts` POST
and `app/api/roles/[id]/route.ts` PUT gate only on `roles.create`/`roles.edit` and attach **any** permission key
from the full catalog to a role with no check that the actor's own effective permission set already contains
what they're granting. See the full chain (role creation → self-assignment via `users/[id]` PUT) written up in
Section 2 below — this sub-audit traced the identical bug independently, from the `roles/**` side rather than
the `users/**` side, which corroborates it.

**CRITICAL — `app/api/users/[id]/route.ts` PUT — self-promotion to ADMIN (independently confirmed, more precise
evidence)**
```ts
const permError = await requirePermission(request, 'users.edit')   // the only guard
...
const requestedRole = typeof body.role === 'string' ? body.role.trim().toUpperCase() : undefined
const role = selectedRoleRecord ? deriveBaseRole(selectedRoleRecord.name) : requestedRole
if (!role || !ALLOWED_ROLES.has(role)) { return 400 }   // ALLOWED_ROLES includes 'ADMIN'
const existingUser = await prisma.user.findFirst({ where: { id: params.id, tenantId: actor.tenantId }, ... })
// no check that params.id !== actor.id (contrast with DELETE on the same file, which DOES block self-action)
...
data: { ..., role: role as any, ..., permissions: selectedPermissionKeys }
```
Combined with `lib/authorization.ts:110-115` (*"Guarantee full admin visibility on web when user enum role is
ADMIN"* — grants every permission in the catalog once `role === 'ADMIN'`). **Repro:** a user holding only
`users.edit` — e.g. via a narrow "HR profile editor" custom role —
`PUT /api/users/<own id> {"firstName":"X","lastName":"Y","email":"me@tenant.com","status":"ACTIVE","role":"ADMIN"}`
→ `200`, and the very next request from that user resolves to full tenant-admin permissions. This requires only
the single permission `users.edit`, no `roleId`/custom-role step needed — the single most directly exploitable
finding in the whole audit alongside `auth/set-password`.

**PARTIAL (MEDIUM) — `app/api/sms/send/route.ts:16-67`** — `clientId`/`contactId`/`jobId`/`leadId` from the body
are stored on the new `SmsMessage` with no tenant check, and the response `include`s `client`/`contact`/`job` —
same shape as the `calls.ts` CRITICAL finding from another group, but scored MEDIUM here because it doesn't
persist a durable public list-view leak the way `calls`/`schedules` do (only this call's own response body
discloses the foreign relation).

**Minor notes (not separately scored):** `messages/stream` accepts `?token=` as an SSE auth fallback (logs/
Referer exposure, standard trade-off); `lib/chat/service.ts` writes attacker-supplied `notifyUserIds`/
`participantIds` into `chatConversationMember` without a tenant check (not currently exploitable for cross-tenant
read, downstream reads stay tenant-scoped); `payments/sola/link/route.ts` accepts an unrestricted `webhookUrl`
in the body (gated behind `payments.manage`, so an internal-trust concern, not unauthenticated); `users/me/avatar`
derives its public URL from the `Host`/`X-Forwarded-Host` header when no `PUBLIC_APP_URL` env is set (low
severity, self-scoped route).

#### Group: notifications / email / email-integrations / integrations / qbo (34 files)

| route | auth? | permission guard? | tenant-scoped? | note |
|---|---|---|---|---|
| app/api/email-integrations/[id]/route.ts | Y | Y `system.integrations` | YES | `findFirst({id, tenantId})`; credentials AES-256-GCM encrypted |
| app/api/email-integrations/[id]/test/route.ts | Y | Y `system.integrations` | YES | |
| app/api/email-integrations/assignments/route.ts | Y | Y `system.integrations` | YES | target user + integration re-verified tenant |
| app/api/email-integrations/route.ts | Y | Y `system.integrations` | YES | |
| app/api/email/log/route.ts | Y | Y `messages.view` | YES | |
| app/api/email/retry/[id]/route.ts | Y | Y `messaging.email` | YES | |
| app/api/email/send/route.ts | Y | Y `messaging.email`/`messages.send` | N/A | tenant-scoped for templates; **`to` is fully attacker-chosen — see open-relay note below** |
| app/api/email/templates/[id]/route.ts | Y | Y `settings.edit` | YES | |
| app/api/email/templates/route.ts | Y | Y `settings.view`/`settings.edit` | YES | |
| app/api/integrations/[provider]/regenerate-secret/route.ts | Y | Y `system.integrations` | YES | id derived from `(tenantId, provider)` unique key, never attacker-supplied |
| app/api/integrations/[provider]/route.ts | Y | Y `settings.view`/`system.integrations` | YES | |
| app/api/integrations/[provider]/test/route.ts | Y | Y `system.integrations` | YES | |
| app/api/integrations/quickbooks/callback/route.ts | **N** | **N/A — no auth** | **NO** | **CRITICAL — OAuth CSRF, see §Special focus** |
| app/api/integrations/quickbooks/connect/route.ts | Y | Y `system.integrations` | YES (this half) | generates `state` but nothing ever validates it back |
| app/api/integrations/quickbooks/health/route.ts | Y | Y `system.integrations` | YES | |
| app/api/integrations/quickbooks/sync-balances/route.ts | Y | Y `system.integrations` | PARTIAL | dedupe read unscoped, see evidence |
| app/api/integrations/route.ts | Y | Y `settings.view` | YES | |
| app/api/notifications/[id]/read/route.ts | Y | Y `dashboard.view` | YES | |
| app/api/notifications/preferences/route.ts | Y | N/A (self) | YES | |
| app/api/notifications/read-all/route.ts | Y | Y `dashboard.view` | YES | |
| app/api/notifications/route.ts | Y | Y `dashboard.view` | YES | |
| app/api/notifications/stream/route.ts | Y | Y `dashboard.view` | YES | SSE; no query-string token fallback found |
| app/api/qbo/auth/route.ts | Y | Y `system.integrations` | YES (this half) | `state = base64(tenantId:timestamp)` — unsigned, not stored |
| app/api/qbo/callback/route.ts | **N** | **N/A — no auth** | **NO** | **CRITICAL — OAuth CSRF, global client secret, see §Special focus** |
| app/api/qbo/import-credit-memo/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/import-estimate/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/import/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/status/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/sync-failures/route.ts | Y | Y `system.integrations` | PARTIAL | unscoped existence-check helper (low severity, see evidence) |
| app/api/qbo/sync/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/sync/trigger/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/update-invoice-line-items/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/update-items/route.ts | Y | Y `system.integrations` | YES | |
| app/api/qbo/worker/route.ts | N (by design) | `CRON_SECRET` timing-safe check, fails closed | N/A | correctly protected cron/worker endpoint |

**CRITICAL — `app/api/integrations/quickbooks/callback/route.ts:71-97`**
```ts
export async function GET(request: NextRequest) {
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const realmId = searchParams.get('realmId')
  const [stateToken, tenantId] = state.split(':')
  if (!tenantId) { throw new Error('Invalid state token') }
  const cfg = await getQuickBooksConfig(tenantId)
  // ...exchanges code, then writes tokens into that tenant's IntegrationConnection
```
No `authenticateRequest` anywhere in the file. `stateToken` is destructured and **never compared against anything**
— no cookie, no session, no stored nonce. `tenantId` is taken verbatim from the client-supplied `state` query
parameter and used to select which tenant's QuickBooks connection receives the freshly exchanged OAuth tokens.
**Repro:** an attacker (no login to the platform required) completes the standard Intuit OAuth consent screen using
the app's own public `client_id`, gets back `code`+`realmId` at Intuit's redirect, then calls
`GET /api/integrations/quickbooks/callback?code=<their code>&state=x:<VICTIM_TENANT_ID>&realmId=<their realmId>`
directly. The server exchanges the code and upserts the resulting tokens into the **victim tenant's**
`IntegrationConnection`/`QuickBooksIntegration` rows, silently repointing that tenant's QuickBooks sync (invoices,
payments, balances) at the attacker's own QuickBooks company. Any authenticated but unprivileged member of a
tenant (lacking `system.integrations`) can also use this to bypass that permission gate against their own tenant.

**CRITICAL — `app/api/qbo/callback/route.ts:1-36`** — same shape, and worse: `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`
(`lib/services/quickbooks.ts:4-5`) are **process-wide env vars shared by every tenant on the platform**, so the
whole OAuth app is common to all tenants. `state` here is `Buffer.from(`${user.tenantId}:${Date.now()}`).toString('base64')`
— unsigned, never persisted, trivially decodable/forgeable. No `authenticateRequest` in this file either. Confirmed
via repo-wide grep for `oauthstate|storedState|verifyState|state_token|stateToken` — no `OAuthState`/nonce table
or cookie-based CSRF check exists anywhere in the codebase for either QBO callback.

**PARTIAL — `app/api/integrations/quickbooks/sync-balances/route.ts:66-67`**
```ts
const reference = `qbo_bulksync_${invoice.qboSyncId}_${qboBalance.toFixed(2)}`
const existing = await prisma.payment.findFirst({ where: { reference } })
```
No `tenantId`. The enclosing `invoice` fetch is tenant-scoped so this can't leak data, but a `qboSyncId` collision
across two different tenants' own QuickBooks companies could cause one tenant's reconciliation to be silently
skipped as a false "duplicate." Low severity (availability, not confidentiality).

**PARTIAL — `app/api/qbo/sync-failures/route.ts:5-14`** — `localEntityExists()` does bare `findUnique({id})` with
no `tenantId`, used only as a boolean gate over ids that already originate from this tenant's own sync-log rows.
Not currently exploitable; flagged as a latent boolean-oracle pattern.

**Open-relay note — `app/api/email/send/route.ts` and `app/api/reports/email/route.ts`:** both are authenticated +
permission-gated, but neither restricts the recipient address to the tenant's own clients/contacts/users — Zod
validates only e-mail *shape*. Any authenticated user holding `messaging.email` or `reports.view` can cause the
platform's shared sending identity to email arbitrary third parties arbitrary content. MEDIUM (requires auth + a
granted permission; not a tenant-isolation break, but a trusted-sender-abuse vector). No SSRF angle found in
either route — `reports/email` only fetches a fixed internal path, not an attacker-supplied URL.

**`app/api/qbo/worker/route.ts` — correctly protected.** `CRON_SECRET` compared with `crypto.timingSafeEqual`,
fails closed when unset, accepted via `Authorization: Bearer` or `?secret=` (the latter is a mild log-exposure
note, not a bypass).

#### Group: reports / analytics / branding / leads / misc (41 files, 7 of which — auth/*, bootstrap/admin — are
covered in Section 2 instead)

| route | auth? | permission guard? | tenant-scoped? | note |
|---|---|---|---|---|
| app/api/analytics/export/route.ts | Y | Y `analytics.view` | YES | |
| app/api/analytics/jobs/route.ts | Y | Y `analytics.view` | YES | raw SQL parameterized + tenant-filtered |
| app/api/analytics/leads/route.ts | Y | Y `analytics.view` | YES | raw SQL parameterized + tenant-filtered |
| app/api/analytics/overview/route.ts | Y | Y `analytics.view` | YES | |
| app/api/analytics/revenue/route.ts | Y | Y `analytics.view` | YES | raw SQL parameterized + tenant-filtered |
| app/api/audit-logs/route.ts | Y | Y elevated (`audit_logs.view`/`access`) | YES | |
| app/api/auth/logout/route.ts | N/A by design | N/A | N/A | deletes refresh token by hashed raw-token match — correct pattern, no user context needed |
| app/api/auth/permissions/route.ts | Y | N/A (self) | YES (self) | |
| app/api/branding/invoice-preview-pdf/route.ts | Y | Y `settings.view` | N/A | static sample data only, HTML escaped |
| app/api/branding/reset-section/route.ts | Y | Y `settings.edit` | YES | |
| app/api/branding/reset/route.ts | Y | Y `settings.edit` | YES | |
| app/api/branding/route.ts | Y | Y `settings.view`/`edit` | YES | |
| app/api/calls/route.ts (GET) | Y | Y `calls.view` | YES | |
| app/api/calls/route.ts (POST) | Y | Y `calls.send` | **NO** | **CRITICAL — see evidence below** |
| app/api/dashboard/stats/route.ts | Y | Y `dashboard.view` | YES | ~20 aggregate queries all tenant-filtered |
| app/api/geocoding/batch/route.ts | Y | Y `jobs.view` | YES | explicitly re-derives ownership-checked id list |
| app/api/help/[id]/route.ts, help/route.ts | Y | Y | YES | |
| app/api/leads/[id]/convert*/route.ts, leads/[id]/route.ts, leads/route.ts | Y | Y `leads.*` | YES | nested ids always re-derived from tenant-verified source records |
| app/api/maps/data/route.ts | Y | Y `jobs.view` | YES | |
| app/api/maps/key/route.ts | Y | Y `jobs.view` | N/A | returns the browser-restricted Google Maps key (not secret) |
| app/api/me/email-sender/route.ts, /test | Y | Y `settings.edit` | YES (self) | |
| app/api/me/route.ts | Y | N/A (self) | YES | id from verified token, not input |
| app/api/production/route.ts | Y | Y `production.view` | YES | |
| app/api/reports/aging, customer-statement, job-profitability, revenue, vendor-spend | Y | Y `reports.view` | YES | revenue.ts raw SQL parameterized via `Prisma.sql`/`Prisma.join` |
| app/api/reports/email/route.ts | Y | Y `reports.view` | YES | re-invokes report route over internal loopback with caller's own Authorization header |
| app/api/search/route.ts | Y | Y `dashboard.view` | YES | every entity type tenant-scoped in `lib/search/global-search.ts` |
| app/api/time-entries/[id]/route.ts | Y | Y (inline role checks) | YES | |

**CRITICAL — `app/api/calls/route.ts` POST — cross-tenant IDOR with direct data exfiltration**, `route.ts:119-165`:
```ts
const { clientId, contactId, jobId, leadId, ... } = body
const call = await prisma.call.create({
  data: { tenantId: user.tenantId, clientId: clientId || null, contactId: contactId || null,
          jobId: jobId || null, leadId: leadId || null, ... },
  include: { client: true, contact: true, job: true },
})
```
`clientId`/`contactId`/`jobId`/`leadId` come straight from the body with no tenant check. `Call`'s FKs are plain
id-only relations (`prisma/schema.prisma:1829-1865`), so Prisma will happily attach a record belonging to a
different tenant — and the `create` call `include`s the full related objects **directly in the response**.
**Repro:** authenticate as any Tenant-A user with the ordinary `calls.send` permission;
`POST /api/calls {"direction":"INBOUND","status":"ANSWERED","fromNumber":"555","toNumber":"555","clientId":"<a Tenant-B client cuid>"}`;
the response's `call.client` is Tenant B's full client record. Every later `GET /api/calls` for Tenant A repeats
the leak. Contrast with `leads/route.ts`, which correctly `findFirst({id, tenantId})`-verifies nested ids before
accepting them — that check is simply missing here (and, with lower severity since nothing is echoed back, on the
`Task`/`Notification` creates a few lines below in the same handler).

Minor notes (not scored PARTIAL, included for completeness): `lib/reports/client-filters.ts`
`resolveClientFilterIds()` doesn't itself verify `clientId` belongs to `tenantId` — safe today only because every
call site separately ANDs `tenantId` into the same Prisma `where`; would become a real IDOR if a future caller
relied on this helper's output alone. `reports/email/route.ts` stores `clientId` on the created `Email` row
without ownership verification (not currently echoed back).

**Raw SQL inventory (this group):** all 7 raw queries found (`analytics/jobs`, `analytics/leads`,
`analytics/revenue` ×2, `reports/revenue` ×3) are genuine tagged-template `$queryRaw`/`Prisma.sql` literals —
parameterized, not string-concatenated — and every one carries an explicit `tenantId` predicate. No
`$queryRawUnsafe`/`$executeRawUnsafe` and no manual string concatenation found in this group.

#### Group: schedules / tasks / issues / requests / measuring-requests / notes / attachments / uploads / mobile (43 files)

| route | auth? | permission guard? | tenant-scoped? | note |
|---|---|---|---|---|
| app/api/attachments/[id]/route.ts (DELETE) | Y | Y (`*.view` permissions) | YES | tenant derived from parent entity; **permission-tier mismatch, see Finding A** |
| app/api/attachments/route.ts (GET/POST) | Y | Y (`*.view` permissions) | YES | same Finding A on POST |
| app/api/issues/[id]/notes/[noteId]/route.ts, notes/route.ts, [id]/route.ts, reminders/route.ts, route.ts | Y | Y `issues.*` | YES/PARTIAL | PUT/POST accept unverified `watchers[]` (Finding B) and POST accepts unverified `leadId` (Finding D); spoofable mobile routing (Finding C) |
| app/api/measuring-requests/** (7 files) | Y | Y `leads.*` | YES | POST validates lead + assignedUser against tenant |
| app/api/mobile/** (16 files) | Y | Y (mobile perms) or self-scoped | YES | `mobile/location` writes nothing to DB (dead code, not a vuln); all self-scoped routes correctly key on `user.id` from token |
| app/api/notes/[id]/route.ts | Y | Y (resolved from parent) | YES | parent job/client tenant re-verified |
| app/api/requests/[id]/attachments/route.ts, urgent/route.ts | Y | Y `leads.edit` | YES | |
| app/api/schedules/[id]/route.ts (GET) | Y | Y `schedule.view*` | YES (schedule row) but **NO (nested lead/job)** | see Finding E |
| app/api/schedules/[id]/route.ts (PUT), schedules/route.ts (POST) | Y | Y `schedule.*`/mobile | **NO** | **HIGH — Finding E, cross-tenant `jobId`/`leadId` accepted unchecked** |
| app/api/schedules/[id]/route.ts (DELETE), schedules/route.ts (GET), schedules/team/route.ts | Y | Y | YES | |
| app/api/tasks/** (5 files) | Y | Y `tasks.*`/mobile | PARTIAL | POST accepts unverified `leadId`/`invoiceId`/`issueId` (Finding F); GET/PUT/DELETE by id correctly tenant-scoped |
| app/api/uploads/route.ts, uploads/messages/route.ts | Y | Y (`*.upload_files`/`*.edit`) | YES | server-generated UUID filenames; **but see file-serving finding below** |

**HIGH — Finding E, `app/api/schedules/route.ts:312-330` (POST) and `schedules/[id]/route.ts:173-186` (PUT):**
neither validates that `jobId`/`leadId` belong to `user.tenantId` before persisting them on the schedule (the only
tenant-scoped job lookup is a separate best-effort sync of `job.scheduledStart/End` that silently no-ops on a
miss — it does not block the write). Then `schedules/[id]/route.ts:23-51` (GET) `include`s `lead: true` — **every
column of the Lead model** (name, email, phone, company, address, notes, value, source, status) with no tenant
re-check on the included relation. **Repro:** a Tenant-A user who knows/obtains a Tenant-B `Lead.id` (cuid) can
`POST /api/schedules {"title":"x","startTime":...,"endTime":...,"leadId":"<tenant-B lead id>"}`, then
`GET /api/schedules/{newId}` and receive Tenant B's full lead PII inside `schedule.lead`. Most severe finding in
this group — confirmed, concrete cross-tenant PII disclosure, not theoretical.

**Finding A (MEDIUM) — view-permission gates a write action:** `attachments/[id]/route.ts:12-13` and
`attachments/route.ts:74-75,131-132` gate DELETE/POST (create/delete an attachment) on
`requireAnyPermission(['jobs.view','leads.view','clients.view','purchase_orders.view'])` — a *view*-only custom
role can create/delete attachments including billing documents.

**Finding B (LOW) — unvalidated issue watchers:** `issues/route.ts:313-325`, `issues/[id]/route.ts:274-295` write
`IssueWatcher.userId` from body without checking it belongs to the tenant. Not currently exploitable for
disclosure (notification reads are tenant-scoped downstream) but corrupts referential integrity.

**Finding C (MEDIUM) — spoofable mobile/web permission routing:** `issues/route.ts:9-14`,
`issues/[id]/route.ts:14-19`, `tasks/route.ts:18-23` each locally redefine `isMobileRequest()` as
`/Mobile|Android|iPhone|iPad/i.test(userAgent) || searchParams.get('mobile') === 'true'` — diverging from the
canonical `lib/authorization.ts` version (`userAgent.includes('TrimProMobile')`). Because `mobile.*` and web
permissions are distinct grants in custom roles, a user granted only the mobile permission can add `?mobile=true`
to an ordinary web request and be evaluated under the more permissive mobile permission namespace. **Repro:** a
user whose custom role grants `mobile.issues.create` but not `issues.create` — `POST /api/issues?mobile=true`
succeeds where `POST /api/issues` correctly 403s.

**Finding D (LOW) — `issues/route.ts:290-311` POST accepts unverified `leadId`** (unlike `jobId`/`clientId`,
which are validated a few lines above). Not currently surfaced in any response.

**Finding F (MEDIUM) — `tasks/route.ts:339-360` POST accepts unverified `leadId`/`invoiceId`/`issueId`**
(`callId`/`smsId` are destructured but unused/dead). `tasks/[id]/route.ts` GET and `tasks/route.ts` GET both
`include` `invoice`/`issue` relations, so a Tenant-A user who supplies a Tenant-B `invoiceId`/`issueId` on create
can read back that foreign invoice number/title or issue title/status via their own task.

**HIGH — unauthenticated public file serving, `app/uploads/[...path]/route.ts` (entire file, verified directly
by lead auditor):**
```ts
export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  const segments = (params.path ?? []).map((seg) => decodeURIComponent(seg))
  for (const seg of segments) {
    if (seg.includes('..') || seg.includes('/') || seg.includes('\\')) return new NextResponse('Forbidden', { status: 403 })
  }
  const filePath = path.join(process.cwd(), 'public', 'uploads', ...segments)
  // streams the file with Content-Disposition: inline, Cache-Control: public, max-age=31536000, immutable
```
No `authenticateRequest` call, no tenant check, no ownership check of any kind — a plain, unauthenticated
static-file proxy over `public/uploads/<tenantId>/<uuid>.<ext>`. Path traversal is correctly blocked (segment
allowlist before `path.join`), but that's the only control. Every attachment/upload URL, once known (and these
URLs are returned in-band in ordinary JSON API responses such as `attachment.url`, and could be forwarded, cached
by an intermediate proxy/CDN given the `immutable, max-age=31536000` header, or leaked via a Referer header),
is downloadable by **anyone with no login at all** — not just cross-tenant, but fully anonymous. This is
security-by-obscurity (unguessable UUID filename) with no defense in depth: no signed/expiring URL, no session
check. Because uploads live under `public/`, Next.js's own static file server can also serve them directly,
bypassing this route (and its traversal guard) entirely for the same underlying risk.

**MEDIUM — SVG stored-XSS via uploads:** `lib/uploads/policy.ts` allowlists `image/svg+xml`
(`ALLOWED_IMAGE_MIME_TYPES`), and the serving route sets `Content-Disposition: inline` unconditionally — a
direct navigation to an uploaded `.svg` renders it as a full document and executes embedded `<script>`,
same-origin, with the victim's session. `isAllowedUploadMimeType()` also has an open fallback accepting anything
prefixed `audio/`/`video/`, not just the enumerated list (narrow widening, not arbitrary-type).

**LOW — 1GB per-file ceiling, no visible per-tenant quota** for video/audio/document uploads
(`MAX_VIDEO_FILE_BYTES`/`MAX_AUDIO_FILE_BYTES`/`MAX_DOCUMENT_FILE_BYTES = 1024*1024*1024`) — disk-exhaustion
consideration, not a broken control.

### 1.B — Coverage confirmation

All six groups above are now reported in full; combined with `app/api/public/**` (16 files),
`app/api/webhooks/**` (6 files), and `app/api/health/route.ts` (1 file, trivial `SELECT 1` health check, no
auth/tenant surface — reviewed directly, no issue) audited separately in Sections 2–3, all 277 `route.ts` files
named in the task are accounted for. No route was sampled; every PARTIAL/NO row above has file:line evidence.

---

## Section 2 — Auth & Session (verified directly by lead auditor)

### `lib/auth.ts` — weak/default secrets, unbound reset tokens

```ts
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-change-in-production'
```
**MEDIUM** (contingent on deployment — flagging because the fallback exists at all): if `JWT_SECRET`/
`JWT_REFRESH_SECRET` are ever unset in an environment, every access/refresh token is signed with a
publicly-known, hardcoded string checked into this very file, letting anyone forge a valid token for any
`userId`/`tenantId`/`role`. `.env` in this working tree does set both — see Section 6 — but the fallback itself
is a live footgun for any deployment/environment that misses the env var (e.g., a new staging box).

**HIGH — `generatePasswordResetToken()`, `lib/auth.ts:120-122`:**
```ts
export function generatePasswordResetToken(expiresIn: string | number = '1h'): string {
  return jwt.sign({ type: 'password-reset', timestamp: Date.now() }, JWT_SECRET, { expiresIn })
}
```
The token's own JWT claims carry **no `userId`** — it's bound to a specific user only via a side-channel: the
caller (`forgot-password`, `users/invite`) separately stores the resulting string verbatim in
`User.passwordResetToken` (`@unique` in `prisma/schema.prisma:129`) and later looks the user up by exact string
match. Two compounding issues: (1) `reset-password/route.ts` validates the token by calling
`verifyAccessToken(token)` — the *general* access-token verifier — which only checks the JWT signature, not the
`type` claim, so any structurally-valid JWT signed with `JWT_SECRET` (including an attacker's own ordinary
Bearer access token from logging in normally) passes this check; the actual protection is entirely the
subsequent `findUnique({ where: { passwordResetToken: token } })`, which only succeeds if the string happens to
match a stored value — so this specific path is not directly exploitable, but it means the "verify" step does
nothing useful and the code is one accidental refactor away from becoming exploitable (e.g., if the lookup were
ever changed to `findFirst` + a separate identity claim taken from the token itself, which doesn't exist). (2)
Because the token isn't bound to a user in its own signed payload, forensic/audit trust in "this JWT belongs to
this password reset" is entirely dependent on the DB column, not the token — a design smell in a security-critical
path. Token entropy for the *value that matters* (the 1-hour or 7-day validity window) is fine since it's
HMAC-signed and unguessable without `JWT_SECRET`.

**LOW — reset URL logged to server console on email failure**, `app/api/auth/forgot-password/route.ts:44-49`:
```ts
} catch (error) {
  console.error('Failed to send password reset email:', error)
  console.log('Password reset URL:', resetUrl) // Remove in production
}
```
If the configured email provider fails (misconfiguration, provider outage, rate limit), the full reset link
including the live token is written to stdout/server logs. Anyone with log access (ops tooling, log aggregation,
a misconfigured log-forwarding integration) during that window can take over the account. The comment itself
flags this as a known TODO.

**LOW — `generateTemporaryPassword()`, `lib/auth.ts:113-121`, uses `Math.random()`** (not
`crypto.randomBytes`) for a 12-character temp password. `Math.random()` is not cryptographically secure and its
internal state can in principle be recovered from enough output. Currently **dead code** — grep across `app/`
and `lib/` finds no callers, so this is not presently reachable, but it's a live footgun if wired into any future
invite/reset flow (which doesn't presently use it; the invite/reset flows use `generatePasswordResetToken`
instead).

### CRITICAL — `app/api/auth/set-password/route.ts` — unauthenticated full account takeover (any user, any tenant)

Full file logic (`route.ts:6-47`):
```ts
export async function POST(request: NextRequest) {
  const { userId, temporaryPassword, newPassword } = await request.json()
  if (!userId || !newPassword) { ... }
  if (newPassword.length < 8) { ... }
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) { return 404 }

  if (temporaryPassword && user.temporaryPassword) {
    // verify temp password...
  } else if (user.temporaryPassword) {
    // require temp password...
  }
  // <-- if user.temporaryPassword is NULL (the normal state for any active user not
  //     mid-way through a temp-password flow), BOTH branches above are skipped —
  //     no check of any kind runs.

  const passwordHash = await hashPassword(newPassword)
  await prisma.user.update({ where: { userId }, data: { passwordHash, ... } })
}
```
There is **no `authenticateRequest` call in this file at all**, and the confirmed root `middleware.ts` explicitly
excludes `/api/` from its matcher (see ground truth above), so nothing upstream protects this route either. The
route is reachable at `POST /api/auth/set-password` with a bare JSON body and no `Authorization` header.

`temporaryPassword` (String?, nullable) is `null` for the ordinary lifecycle state of essentially every active
user (it's only non-null transiently, immediately after an admin resets someone's password via the temp-password
flow). When it's `null`, **both** the `if (temporaryPassword && user.temporaryPassword)` and
`else if (user.temporaryPassword)` branches evaluate false, so execution falls straight through to hashing and
writing `newPassword` — **with zero verification of any kind: no current password, no temporary password, no
auth token, nothing.**

This is not a theoretical or unused code path: `app/auth/login/page.tsx` and `app/auth/set-password/page.tsx`
(confirmed via grep) actively call this endpoint as part of the platform's own temporary-password login flow, so
it is a live, intentionally-reachable, unauthenticated endpoint with this flaw.

**Repro:** for any known/observed `userId` (a CUID; visible in dozens of ordinary in-tenant API responses —
assignee ids, message sender ids, JobAssignment rows, audit logs, `/api/users` listings, etc. — to any
authenticated low-privilege user, and potentially cross-tenant via any of the IDOR findings above):
```
POST /api/auth/set-password
Content-Type: application/json

{"userId":"<target user's cuid>","newPassword":"Attacker123!"}
```
No `Authorization` header. If the target's `temporaryPassword` column is `null` (true for essentially every
normal active account, including ADMIN users), the password is silently overwritten and the attacker can
immediately log in as that user — full account takeover, including of tenant ADMIN accounts, requiring nothing
but the target's user id. This is the single most severe finding in the entire audit.

### CRITICAL — `app/api/bootstrap/admin/route.ts` — unauthenticated, no environment gate

Unlike `app/api/auth/dev-login/route.ts` (which correctly does `if (process.env.NODE_ENV === 'production') return 404`),
`bootstrap/admin/route.ts` has **no environment check and no authentication of any kind**. Its only guard is:
```ts
const existingAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } })
if (existingAdmin) { return 400 'Admin user already exists...' }
```
— a single, **platform-wide** (not tenant-scoped) check for the *existence of any ADMIN anywhere in the entire
multi-tenant database*. If that condition is ever false in production (fresh deploy before first admin is
created, a migration/data issue, or every ADMIN-role user having been demoted/deleted/deactivated at some point),
this endpoint lets an unauthenticated caller supply an arbitrary `email`/`password`/`firstName`/`lastName`,
creates a brand-new `Tenant` ("Default Tenant") if none exists, and creates a fresh ADMIN user with attacker-
chosen credentials in it. Given how "biggest gate there is" this repo's own operational rules treat production
gating (see project CLAUDE.md), a route this powerful shipping with **no** `NODE_ENV` check at all, when the
sibling `dev-login` route right next to it does have one, is a clear regression/oversight. **HIGH-to-CRITICAL**;
scored CRITICAL because the condition that makes it dangerous ("no admin currently exists") is exactly the state
a fresh or partially-migrated production deployment can be in, and the blast radius (full unauthenticated tenant+
admin creation) is total compromise.

### CRITICAL — Privilege escalation via custom roles: no ownership check on granted permissions

`app/api/roles/route.ts` POST (`route.ts:38-101`):
```ts
export async function POST(request: NextRequest) {
  const permError = await requirePermission(request, 'roles.create')
  if (permError) return permError
  const { name, description, permissions, mobilePermissions } = await request.json()
  const role = await prisma.role.create({ data: { tenantId: user.tenantId, name, ... } })
  if (permissions && Array.isArray(permissions) && permissions.length > 0) {
    const permissionRecords = await prisma.permission.findMany({ where: { key: { in: permissions } } })
    for (const permission of permissionRecords) {
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    }
  }
  ...
}
```
Any user holding only the `roles.create` permission can create a brand-new custom role carrying **any permission
key in the entire catalog** — `users.edit`, `roles.edit`, `billing.*`, `system.integrations`, everything — with
**no check that the creating user already holds those permissions themselves.** There is no "you can only grant
permissions you already have" invariant anywhere in this route (or in `roles/[id]` — role edit follows the same
pattern).

That role then needs to reach a user. `app/api/users/[id]/route.ts` PUT (verified directly, `route.ts:17-95`)
requires only `users.edit`, tenant-scopes the target user (`findFirst({id: params.id, tenantId: actor.tenantId})`)
and the selected role (`findFirst({id: roleId, tenantId: actor.tenantId, isActive: true})`) — but places **no
restriction on which of the tenant's own roles can be assigned**, and critically **places no restriction on
`params.id === actor.id`** (contrast with the sibling `DELETE` handler in the same file, which explicitly blocks
`params.id === actor.id`). So the same user can then:
```
PUT /api/users/<their own id>
{"firstName":"...","lastName":"...","email":"...","status":"ACTIVE","roleId":"<the role they just created>"}
```
and self-assign the newly created, arbitrarily-permissioned role — or, even more directly, supply
`"role":"ADMIN"` with no `roleId` at all, which `getDefaultPermissions('ADMIN')` resolves to and which
additionally trips the enum-level admin catch-all in `getUserPermissions()` (`lib/authorization.ts`: *"Guarantee
full admin visibility on web when user enum role is ADMIN"*), granting **every** permission in the catalog
regardless of what's on the role record.

**Full chain:**
1. Attacker holds a custom role granting `roles.create` + `users.edit` (a plausible bundle for, e.g., an
   "Office/HR Manager" role meant to manage staff records and team structure — neither permission is inherently
   ADMIN-only by name).
2. `POST /api/roles` with `permissions: [...every sensitive key...]` → new fully-privileged role, no ownership
   check.
3. `PUT /api/users/<own id>` with `roleId` = that new role (or simply `role: "ADMIN"`) → self-escalation.
4. Attacker now holds full tenant-admin (or platform-catalog-wide) permissions.

**Scope of verification:** the code-level vulnerability (steps 2–3, both routes read start-to-finish by the lead
auditor) is confirmed and real. Whether any of this tenant's **currently seeded default** custom roles happen to
bundle `roles.create` with `users.edit` today was **not verified** (would require live DB inspection, out of
scope for a static read-only audit) — flagging that specific sub-question as **UNVERIFIED**. The structural flaw
itself (no permission-ownership check on role creation/assignment) is verified and is a CRITICAL finding
regardless, because custom roles are an explicit, actively-used feature of this product (tenant admins are
expected to hand-build roles with bespoke permission subsets for their staff), making the exploit precondition
realistic rather than contrived.

### HIGH — No rate limiting / brute-force protection on authentication endpoints

Confirmed by direct grep: `app/api/auth/login/route.ts`, `app/api/auth/refresh/route.ts`,
`app/api/auth/reset-password/route.ts`, `app/api/auth/set-password/route.ts`, and
`app/api/auth/forgot-password/route.ts` contain **zero** calls to `rateLimitOrThrow` (the in-process IP-keyed
limiter in `lib/security/rate-limit.ts`) or any other throttling/lockout mechanism. The capability exists and is
used elsewhere in the codebase (e.g., `public/estimate-approval/[token]`, `public/invoices/[id]/qbo-ach-link`),
which makes its absence on `/api/auth/login` — the single most important place for it — a clear gap rather than
an unavailable-tooling issue. Combined with the account-takeover bug above and no visible account-lockout policy
on repeated failed logins, this allows unlimited password-guessing against any known email address.

### `app/api/users/invite/route.ts` — reviewed, no direct escalation found

Requires `users.create`; tenant is always `user.tenantId` (never taken from the body); the `role` field (when no
`roleId` is supplied) is restricted to a fixed `ALLOWED_ROLES` set (`ADMIN, MANAGER, OFFICE, FIELD, SALES,
ACCOUNTING`) and permissions are derived from the selected role or `getDefaultPermissions()` — **the request body
cannot supply an arbitrary `permissions` array directly.** Note: `role` being settable to `'ADMIN'` here means
anyone holding `users.create` (not necessarily an admin-tier permission by design/convention) can invite a new
ADMIN — worth a product-level review of which custom roles are allowed to hold `users.create`, but this is the
same class of concern as the roles/users finding above, not a separate bug in this file.

---

## Section 3 — Public + webhook surfaces (verified directly by lead auditor)

### Public routes (`app/api/public/**`, 16 files) — generally well-designed

Every public route reviewed uses one of three sound patterns: (1) an HMAC-signed link
(`public/clients/[id]/statement`: `HMAC-SHA256(clientId.sentTimestamp, ENCRYPTION_KEY)`, verified with
`crypto.timingSafeEqual`, 90-day max age); (2) a high-entropy, DB-stored bearer token
(`invoice.paymentToken`/`estimateApprovalToken.tokenHash`/`invoicePaymentIntent.returnToken` — all generated with
`crypto.randomBytes(20-32)`, i.e. 160–256 bits, via `hashApprovalToken`/direct hex, confirmed unguessable); or
(3) deriving `tenantId`/`clientId` **from the authenticating token's own DB row**, then re-verifying any
additional target id (e.g. a second invoice to pay) against that same tenant+client before touching it — this
pattern is used correctly and consistently in `public/invoices/[id]/payment-link`,
`public/payments/qbo-ach/[token]`, and `public/invoices/preview`. Rate limiting (`rateLimitOrThrow`) and
reCAPTCHA v3 (`requireRecaptchaV3`) are applied on the money-moving POST endpoints
(`payment-link`, `qbo-ach-link`). No issues found in this subset. `public/recaptcha/site-key` and
`public/branding` are intentionally-public, non-sensitive data (site key isn't secret; branding colors/logo are
meant to be fetched pre-login by the mobile app) with `Access-Control-Allow-Origin: *`, which is appropriate for
their content.

### CRITICAL — `app/api/webhooks/sola-payment/route.ts` — completely unauthenticated payment webhook, live production endpoint

This is the **actual, currently-wired** webhook URL (`webhookUrl: ${appUrl}/api/webhooks/sola-payment`, set by
both `public/invoices/[id]/payment-link/route.ts:816` and its Cardknox-fallback sibling) — not a legacy/unused
path. The entire handler (`route.ts:27-397`) has **no signature verification, no HMAC check, no shared-secret
check of any kind.** It parses the POST body (JSON or form-encoded), reads a handful of fields
(`Result`/`xResult`/`status`, `amount`/`xAmount`, `xInvoice`/`invoiceId`, `transactionId`/`xRefnum`), and if the
result looks like success:
```ts
const invoice = await prisma.invoice.findFirst({
  where: { OR: [{ id: invoiceRef }, { invoiceNumber: invoiceRef }] },
  ...
})
...
const result = await applyInvoicePayment({
  invoiceId: invoice.id, amount: requestedAmount, method: 'CARD', provider: 'sola',
  providerPaymentId: String(transactionId || ''), solaWebhookData: body, processedAt: new Date(),
  dedupeWhere: transactionId ? { solaTransactionId: transactionId } : undefined,
})
```
`invoiceNumber` is a human-facing, sequential/predictable identifier (not a secret), and this lookup is **not
even tenant-scoped** for the simple-invoice path (only the `TPINTENT:` bulk path derives tenant from a
server-stored idempotency key). **Repro:** anyone on the internet —
```
POST /api/webhooks/sola-payment
Content-Type: application/json

{"Result":"S","xInvoice":"INV-1234","amount":500,"transactionId":"fake-txn-1"}
```
— marks invoice `INV-1234` (any tenant, any customer, guessable/enumerable sequential number) as paid $500 with
no money having moved: creates a `Payment` row, reduces the invoice balance, triggers `enqueueQboSync` (pushes
the fake payment into the tenant's real QuickBooks), `sendPaymentReceiptForPayment` (emails the customer a real
receipt for a payment that never happened), and `notifyInvoicePaid`. This directly defrauds the platform's
tenant customers' accounts-receivable records and can be used to make a real unpaid invoice appear settled. This
is a payment-integrity vulnerability of the highest severity available in this audit.

### CRITICAL — `app/api/webhooks/sola/route.ts` — fail-open signature verification + wrong-tenant misattribution

```ts
const signature = request.headers.get('x-sola-signature') || ''
const solaConnections = await prisma.integrationConnection.findMany({ where: { provider: 'sola', status: 'CONNECTED' } })
const connection = solaConnections[0]   // "Use first connection (in production, match by merchant ID or tenant)"
const secrets = await getIntegrationSecrets(connection.tenantId, 'sola')
const webhookSecret = secrets?.webhookSecret
if (webhookSecret && signature) {
  const isValid = verifySolaWebhookSignature(payload, signature, webhookSecret)
  if (!isValid) return 401
}
// falls straight through to payment application if EITHER webhookSecret OR signature is missing
```
Two independent problems: (1) **fail-open** — if the attacker simply omits the `x-sola-signature` header, or if
this tenant hasn't configured a `webhookSecret`, the `if (webhookSecret && signature)` guard short-circuits false
and **no verification happens at all**, falling through to the same unauthenticated payment-application logic as
`webhooks/sola-payment` above; (2) **tenant misattribution by construction** — `solaConnections[0]` (literally
"use first connection... in production, match by merchant ID or tenant") means if more than one tenant has Sola
configured, **every** webhook delivery to this endpoint, regardless of which tenant's merchant account actually
processed the payment, gets attributed to whichever tenant happens to sort first in the query. Likely legacy/
superseded by `webhooks/sola-payment` in current usage (not referenced by the payment-link generators), but it
remains a live, routed, exploitable endpoint at its URL.

### HIGH — `app/api/webhooks/voipms/route.ts` — no authentication at all (explicit TODO)

Literal comment in the code: `// Verify webhook (in production, verify signature/IP)` — followed by no
verification code whatsoever. The handler fully parses and **persists** inbound SMS/MMS as real
`Conversation`/`Message`/`MessageMedia` rows and fans out a `Notification` to every active user in the matched
tenant. Tenant is resolved by matching the `to` field (the business's own DID) against
`IntegrationConnection` — DIDs are public phone numbers, not secrets. **Repro:** anyone who knows a tenant's
public business phone number can POST a forged inbound SMS payload and have it appear as a real customer message
inside that tenant's CRM inbox, complete with a push notification to staff (spam/social-engineering vector; no
money moves, but it's fully unauthenticated data injection into a live business inbox).

### MEDIUM — `app/api/webhooks/whatsapp/route.ts` — signature checks present but incomplete/fail-open, and currently low-impact only because the inbound-message handling itself is unimplemented

The Twilio branch (`handleTwilioWebhook`) reads `x-twilio-signature` into a variable but **never actually calls
any signature-verification function on it** — the check is dead code that only decides routing (Twilio vs Meta
vs default), not authorization. The Meta branch does compute and compare an HMAC (`x-hub-signature-256` vs
`metaAppSecret`), but only `if (signature)` — an empty header skips verification, and it resolves the tenant via
`process.env.DEFAULT_TENANT_ID` (a single hardcoded env var, not per-tenant), per its own comment *"In
production, determine tenant from phone number."* Current impact is limited because both branches' actual
message-processing/persistence logic is stubbed (`// Process message... Find tenant, client, create message
record` with no code following) — but the security control itself is broken/incomplete as shipped, and will
become exploitable the moment message persistence is wired up without also fixing the verification gaps.

### GOOD — `app/api/webhooks/webwhatis/route.ts` and `app/api/payments/qbo/webhook/route.ts` (via `app/api/webhooks/quickbooks/route.ts`) are correctly implemented

`webwhatis`: real signature verification (`webwhatisProvider.verifyWebhookSignature`) that **fails closed** (401
on invalid/missing), plus event-level idempotency via a stored `WebhookEvent` row. Same "use first connection"
tenant-misattribution pattern as `webhooks/sola` (MEDIUM, not CRITICAL here since the signature check is real).

`payments/qbo/webhook/route.ts` (delegate target of `webhooks/quickbooks`): `verifyIntuitWebhookSignature()`
**fails closed** if `QBO_WEBHOOK_VERIFIER_TOKEN` is unset or the header is missing, uses
`crypto.timingSafeEqual` for the HMAC-SHA256 comparison, and is additionally rate-limited
(`rateLimitOrThrow('qbo-webhook', 120/60s)`). This is the model the other webhooks should follow.

### File upload/download — see Section 1's schedules/tasks/.../uploads group for the full writeup
(`app/uploads/[...path]/route.ts` unauthenticated serving — HIGH; SVG stored-XSS — MEDIUM). Path traversal is
correctly blocked on both the upload and serving sides.

---

## Section 4 — Injection & output

- **No `$queryRawUnsafe`/`$executeRawUnsafe` and no string-concatenated raw SQL found in any audited route.**
  Every `$queryRaw` use found repo-wide (`analytics/jobs`, `analytics/leads`, `analytics/revenue` ×2,
  `reports/revenue` ×3, `health`, `payments/[id]` `FOR UPDATE` lock, `lib/payments/apply-payment.ts`,
  `lib/payments/remove-invoice-payment.ts`) is a genuine tagged-template literal — Prisma parameterizes these
  automatically — and every business-data query among them carries an explicit `tenantId` predicate (verified
  directly and by two sub-audits independently).
- **`lib/authorization.ts:283`, `canAccessResource()` → `own_records_only` constraint branch:**
  ```ts
  const resource = await prisma.$queryRawUnsafe(
    `SELECT "userId" FROM ${resourceType} WHERE id = $1 AND "tenantId" = $2`,
    resourceId, tenantId
  )
  ```
  `resourceType` is interpolated directly into the SQL string — genuinely SQL-injectable if `resourceType` were
  ever attacker-influenced. **However, `canAccessResource` has zero callers anywhere in `app/` or `lib/`**
  (confirmed by grep) — this is unreachable dead code today. **MEDIUM** (not LOW, because it's exactly the kind
  of latent trap that gets wired up later without anyone re-auditing it — flagging for removal or hardening
  before it's ever called).
- **`dangerouslySetInnerHTML`**: exactly one use in the entire `app/`/`components/` tree
  (`app/dashboard/maps/page.tsx:576`), and it's a hardcoded static script string with no interpolated user data
  — not exploitable. No other `dangerouslySetInnerHTML`, no `eval(`, no `new Function(`, no `child_process`
  usage found anywhere.
- **PDF rendering (`lib/pdf/render-html-to-pdf.ts`, puppeteer, launched with `--no-sandbox
  --disable-setuid-sandbox`)**: `lib/documents/pdf-templates.ts` (the invoice/estimate PDF builder, 1438 lines)
  was checked for un-escaped interpolation — all 97 dynamic value insertions go through `escapeHtml`/
  `escapeHtmlMultiline`; no bypass found by direct inspection. The public statement route
  (`public/clients/[id]/statement`) likewise escapes every interpolated field. Running Chromium without a
  sandbox is itself a real hardening gap (typical for containerized deployments, but means any future
  un-escaped-HTML regression in a PDF template would have a higher blast radius than ordinary reflected XSS,
  since the renderer process has fewer OS-level containment boundaries) — **LOW**, contingent on the escaping
  discipline above being maintained.
- **CSV export formula injection (MEDIUM-LOW)**: `app/api/items/export/route.ts:56-57` and
  `app/api/vendors/export/route.ts:81-82` quote-wrap and escape embedded quotes/commas for CSV structure, but do
  **not** neutralize a leading `=`, `+`, `-`, or `@` in a cell value — if an item/vendor name or note contains
  such a value (e.g. entered by any tenant user, or reachable via any of the unverified-nested-id IDOR paths
  above), the exported `.csv` will be interpreted as a formula by Excel/Sheets when opened
  (`=HYPERLINK(...)`-style CSV injection). Both routes are correctly tenant-scoped and authenticated
  (`authenticateRequest` + `settings.edit`), which limits this to same-tenant self-inflicted risk plus whatever
  cross-tenant data can be pulled in via the IDOR findings above.
- **`xlsx` package usage is write-only**: the sole `xlsx` import in the codebase
  (`app/api/invoices/export/route.ts`) only calls `XLSX.utils.json_to_sheet`/`XLSX.write` to *generate* an
  export from the tenant's own (already tenant-scoped) DB rows — no `XLSX.read`/`XLSX.readFile` call exists
  anywhere in the repo, confirmed by grep. This substantially limits the real-world exploitability of the known
  `xlsx@0.18.5` prototype-pollution/ReDoS advisories (see Section 7), which require parsing an attacker-supplied
  file, not writing one.
- **`app/api/items/import/route.ts` and vendor import routes use a hand-rolled CSV line parser**, not the
  `xlsx` library and not a formula-evaluating parser — no formula-injection-on-import risk found.

---

## Section 5 — Headers / CORS / cookies / CSP

Confirmed by direct grep across `app/`, `lib/`, and `next.config.js`:

- **No `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, or
  `X-Content-Type-Options` header is set anywhere in the codebase.** `next.config.js` has no top-level
  `headers()` function at all. **MEDIUM-HIGH** — this is a defense-in-depth gap platform-wide: there is no CSP
  to limit the blast radius of any future XSS (including the SVG-upload XSS finding above), no HSTS to enforce
  HTTPS on repeat visits, no clickjacking protection, and no MIME-sniffing protection.
- **`Access-Control-Allow-Origin: *`** appears in exactly one place, `app/api/public/branding/route.ts` —
  appropriate for its non-sensitive, pre-login, mobile-consumed content. No other CORS headers found anywhere
  (i.e., all other routes are same-origin-only by Next.js default, which is correct for a Bearer-token API that
  doesn't rely on cookies for auth).
- **No cookies are used for authentication anywhere** — `Set-Cookie`/`cookies().set` were not found in any
  authenticated route. Auth is entirely Bearer-token based, with tokens stored client-side in `localStorage`
  (`lib/auth/client.ts`, confirmed: `localStorage.setItem('accessToken', ...)` /
  `localStorage.getItem('accessToken')`). **MEDIUM, architectural**: this means any XSS anywhere in the app
  (and combined with the missing-CSP finding above and the SVG-upload stored-XSS finding, there is at least one
  concrete path to script execution) can read the access **and refresh** tokens directly out of `localStorage`
  and achieve full, durable session takeover — a `httpOnly` cookie would not be readable by injected JS. This is
  a defensible architectural choice for a Bearer-token API consumed by both web and mobile clients, but it
  raises the stakes of the CSP/XSS gaps noted above from "annoying" to "session-takeover-capable."
- **`next.config.js` `images.remotePatterns: [{ protocol: 'https', hostname: '**' }]`** — this permits the
  built-in Next.js Image Optimization endpoint (`/_next/image?url=...`) to fetch **any HTTPS URL on the
  internet** and proxy it back through the server. **HIGH** — this is a well-known SSRF-via-image-optimizer
  pattern: an unauthenticated (the image optimizer endpoint is not gated by this app's own auth) caller can use
  the server as an HTTP(S) fetch proxy — for internal network/port scanning, hitting internal-only services, or
  bandwidth-amplification abuse — by requesting `/_next/image?url=https://<any-host>/<any-path>&w=...&q=...`.
  Recommend scoping `remotePatterns` to the specific hostnames the app actually needs to render images from
  (S3/blob storage domain, etc.) instead of a wildcard.
- **`next.config.js` also sets `typescript: { ignoreBuildErrors: true }` and
  `eslint: { ignoreDuringBuilds: true }`** — INFO: not a vulnerability by itself, but means type errors and lint
  findings (which can include security-relevant patterns an ESLint security plugin would catch) do not block
  production builds.

---

## Section 6 — Secrets in repo

- **No hardcoded API keys/tokens matching `sk_live_`, `sk_test_`, `AKIA...`, `-----BEGIN...PRIVATE KEY-----`,
  `xoxb-`, `ghp_` were found anywhere in tracked source** (`.ts`/`.tsx`/`.js`/`.json`, excluding
  `node_modules`/`.next`/`.git`).
- **One `AIza...` (Google API key) match**: `apps/mobile/google-services.json:18`. This is a Firebase
  Android client configuration key. **INFO, not a leak** — Firebase `google-services.json` client keys are
  designed to ship inside the compiled app and are restricted by Android package name + SHA-1 signing
  certificate on the Google Cloud Console side, not by secrecy of the key string itself; this is standard/
  expected practice, not a misconfiguration, *provided* the corresponding API-restriction settings are actually
  configured on the Google Cloud project (not verifiable from this repo alone — noted as an assumption).
- **A `.env` file exists at the repo root** with real-looking values for
  `DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, NEXT_PUBLIC_APP_URL, NODE_ENV, REDIS_URL,
  PUPPETEER_EXECUTABLE_PATH, SSH_HOST, SSH_USER, SSH_KEY` (key **names** only — values were not printed or
  otherwise disclosed by this audit). **Confirmed properly gitignored** (`.gitignore:27` lists `.env`;
  `git check-ignore -v .env` confirms the match; `git log --all -- .env` returns no history) — **this is not a
  repo leak.** Flagging only as INFO because the working tree does contain live secrets on disk, including what
  appears to be an SSH private key reference (`SSH_KEY`), which is worth confirming is handled with appropriate
  file-system permissions/backup hygiene outside of git (out of scope for this static audit).
- No other `.env*` variants (`.env.local`, `.env.production`, etc.) were found in the working tree.
- `npm audit` was **not run** — see Section 7.

---

## Section 7 — Dependencies

`node_modules` is present, but `npm audit` requires a live network round-trip to the npm registry's advisory
database; per this audit's read-only/no-network constraint, it was **not run**. Flagging known advisory
families from training knowledge for the pinned versions in `package.json` instead — these should be confirmed
against the live advisory DB by someone able to run `npm audit` with network access:

- **`next: "14.0.4"` — several known CVEs fixed in later 14.x releases, all applicable to this exact pin:**
  - **CVE-2025-29927** — critical middleware authorization-bypass via the `x-middleware-subrequest` header
    (fixed 14.2.25). This app's own `middleware.ts` doesn't perform authorization (confirmed above — it's a
    host-redirect only, and explicitly excludes `/api/`), which limits *this specific app's* exposure to the
    CVE's usual worst case (bypassing middleware-enforced auth), but the vulnerable framework code is still
    present and any future use of middleware for access control would inherit the bug on this version.
  - SSRF-adjacent and cache-poisoning issues reported against the Next.js Server Actions / Pages Router
    machinery in various 14.0.x–14.1.x point releases (fixed progressively through 14.1.1 and later).
  - General guidance: **14.0.4 (released Nov 2023) is roughly 2 years behind current 14.x** as of this audit's
    date context and should be upgraded to the latest 14.2.x LTS at minimum. **HIGH** (known, network-reachable
    framework-level CVEs in a currently-deployed version).
- **`xlsx: "^0.18.5"`** — the `xlsx` (SheetJS) package has publicly known, **still-unpatched-on-npm** prototype-
  pollution and ReDoS advisories (the maintainer's fix is only distributed via their own CDN, not the npm
  registry version). **Real-world exploitability in this codebase is low**, per Section 4: the only usage found
  is write-only (`XLSX.write`/`json_to_sheet`), never parsing attacker-supplied files. **LOW-MEDIUM** as pinned
  here specifically; would be HIGH if any future code path calls `XLSX.read` on an uploaded file.
- **`jsonwebtoken: "^9.0.3"`** — recent major version, no widely-known unpatched CVE at this pin; the app's own
  usage (`jwt.sign`/`jwt.verify` with explicit `algorithms` not pinned — verify calls use default algorithm
  detection rather than an explicit `{ algorithms: ['HS256'] }` allowlist) is worth a follow-up: `jsonwebtoken`
  versions have historically shipped algorithm-confusion bugs (e.g., `alg: none` or RS256/HS256 confusion) when
  the verifier doesn't pin an explicit algorithm list. Not independently confirmed exploitable here since this
  app only ever signs with HS256 and provides a fixed secret (not a public/private keypair), which structurally
  avoids the classic RS256→HS256 confusion attack, but pinning `algorithms: ['HS256']` explicitly in
  `jwt.verify()` calls is still a recommended hardening step. **INFO/LOW**.
- **`puppeteer: "^24.37.4"`** — current major version; no specific unpatched CVE flagged. Launched with
  `--no-sandbox --disable-setuid-sandbox` (see Section 4) — a deployment hardening note, not a package-version
  issue.
- **`nodemailer: "^8.0.1"`** — current major version, no specific unpatched CVE flagged from training knowledge.
- **`socket.io: "^4.7.2"`** — several point releases behind current 4.8.x; no specific unpatched CVE
  independently confirmed for this exact pin from training knowledge, but recommend updating to latest 4.x as
  routine hygiene.
- **`bcryptjs: "^2.4.3"`, `@prisma/client`/`prisma: "^5.7.1"`, `zod: "^3.22.4"`** — no known unpatched
  advisories flagged for these pins.

**Recommendation**: run `npm audit --omit=dev` (and ideally `npm audit` including dev deps for build-tooling
supply-chain risk) from a network-enabled environment to get the authoritative, current advisory list — the
above is best-effort static/training-knowledge flagging only, explicitly caveated per the task's own
instructions.

---

## Out of scope, noticed

- **`lib/authorization.ts` `canAccessResource()`'s `own_records_only` and `team_only` constraint types** are
  partially implemented (`team_only` is a no-op stub that always returns true) and, per Section 4, the whole
  function is currently unreachable dead code — worth a product decision on whether to finish, harden, or remove
  it before it's ever wired up.
- **`ROLE_PERMISSIONS` in `lib/permissions.ts`** uses a different key format (`'users:edit'`, colon-separated)
  than the `PERMISSIONS` catalog in `lib/permissions-catalog.ts` used by `requirePermission`
  (`'users.edit'`, dot-separated) and by the seeded `Role`/`RolePermission` DB tables that actually govern
  real per-tenant custom-role permission checks. This dual-format legacy/current split was not fully reconciled
  in this audit (would require DB inspection of seeded `Permission`/`Role` rows, out of scope) — flagging as a
  code-hygiene item that made the privilege-escalation analysis above harder to fully bound with 100% certainty
  purely from static source.
- Mobile app (`apps/mobile/`) and any other workspace packages outside `Loopcom works/app/` and
  `Loopcom works/lib/` were not audited — this report covers only the Next.js app-router API surface named in
  the task.
- CI/CD pipeline, hosting/infra configuration (reverse proxy, WAF, firewall rules, container isolation),
  database access controls, and backup/secret-management practices outside the repository are out of scope for
  a static source read.
