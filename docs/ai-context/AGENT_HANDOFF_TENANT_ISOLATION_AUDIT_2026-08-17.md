# AGENT HANDOFF — tenant isolation audit (Phase 19), 2026-08-17

**Read-only audit. No code changed, nothing deployed, no migration, no PBX
interaction, and no cross-tenant request was ever sent to production.** Every
finding is reasoned from source, from nginx config, and from *read-only* SQL and
`docker exec` env probes on loopcom. Sizing figures are real.

Scope: the whole HTTP surface of `apps/api` — **1,016 route registrations**
across 62 files (483 in `server.ts` alone), plus the JWT bypass list, the
permission resolver, every signed-URL scheme and the storage/streaming paths.

---

## 0a. ⛔ REMEDIATION STATUS — updated 2026-08-18 (read this before acting on anything below)

| § | Finding | Status |
|---|---|---|
| **§1** | `/internal/*` unauthenticated + publicly reachable | ✅ **CLOSED AT NGINX** on both vhosts, verified externally. ⛔ **The code still fails open** — see below, it CANNOT be changed without setting the secret first |
| **§1a** | `inbound-crm-match` takes role from body | ✅ Unreachable from the internet (same nginx rule). Code unchanged |
| **§2** | VoIP.ms SMS webhook unauthenticated | ✅ **FIXED, fails closed** (`apps/api/src/voipMsWebhookAuth.ts`) |
| **§3a** | chat-db URLs signed with unkeyed `createHash` | ✅ **FIXED — keyed HMAC** |
| **§3b** | signing secret falls back to `"dev-signing-secret"` | ✅ **FIXED for chat** (derives from `JWT_SECRET`, never a literal). ⛔ The other four helpers (prompt / MOH / CRM doc / CRM voicemail-drop) are **UNCHANGED** and still resolve to the literal |
| **§4** | `TENANT_ADMIN` reaches `/admin/*` | ⏳ **OPEN — deliberately out of scope**, needs permission-model scoping |
| **§5** | Anonymous tenant creation via the `NODE_ENV` gate | ⏳ **OPEN — deliberately out of scope** |
| §6a–§6l | Medium / low | ⏳ **OPEN**, untouched |

### ⛔⛔ §1: WHY THE CODE FIX WAS NOT MADE — it would have been a platform-wide outage

The intended change ("make `verifyCdrSecret` fail closed when the secret is
unset") was **investigated and deliberately NOT applied.** `CDR_INGEST_SECRET`
is empty in **api, telephony AND worker**, and every caller omits the header
when the secret is empty:

```ts
...(secret ? { "x-cdr-secret": secret } : {})   // CdrNotifier, MobilePushNotifier,
                                                 // ConnectWakeConsumer, PbxTenantMapCache, …
```

So failing closed today rejects **every legitimate internal caller**: CDR ingest
(calls vanish from history — the exact 2026-08-04 wound), mobile ring/wake pushes
(phones stop ringing), voicemail-notify, user-extensions, PBX event ingest and
`/voice/ivr/events`.

⛔ **The fix is therefore a SEQUENCE, and the order is the whole safety property:**
1. Set `CDR_INGEST_SECRET` to one shared value in `/opt/connectcomms/env/.env.platform`.
2. Restart **api + telephony + worker** so all three carry it (they must agree; a
   partial rollout is the same outage).
3. *Only then* make `verifyCdrSecret` (`server.ts:18351`) and the 8 inline sites
   fail closed, with a test.

That is an env edit plus a coordinated three-service restart (telephony rebuilds
live queue state from zero), which is why it was not done unattended. **The nginx
rule already removes the internet-facing exposure**, so what remains is
defence-in-depth against a caller that can already reach the docker bridge.

### The nginx mitigation, as applied

Live file is **`/etc/nginx/sites-enabled/connectcomms`** (a REAL FILE) and
**`/etc/nginx/sites-available/connectcomms-loopcom`** (symlinked).
⛔ **This audit cited `sites-available/connectcomms:79` — that file is STALE
(4,780 bytes vs the live 8,864, still on `127.0.0.1:3001` instead of the
`connect_api_active` blue/green upstream). Editing it would have done nothing.**

A `location /api/internal/` block now allows only `127.0.0.1`, `::1`,
`172.16.0.0/12`, `10.0.0.0/8` and the PBX `209.145.60.79`, then `deny all`.

- **Legitimate callers were checked first, not assumed.** 14 days of nginx logs
  hold exactly **18** `/api/internal/*` requests: 17 from the PBX to
  `/internal/pbx/wake-extension`, **all 400** (already failing, last on Aug 14),
  and one scanner 404. Telephony/worker never appear because they use
  `CDR_INGEST_URL=http://api:3001/internal/cdr-ingest` — **docker DNS, not nginx.**
- **Before:** `GET /api/internal/telephony/pbx-tenant-map` → **200, 24,839 bytes**
  anonymously from the public internet, on both hostnames.
  **After:** **403** (nginx's own, `Server: nginx/1.24.0`), both hostnames, while
  the same request from loopback and from the PBX still returns 200.
- Bypasses tested and closed: `//internal`, `%69nternal`, `/x/../internal`,
  `/api/internal` (301→403). `/api/INTERNAL/` returns **401** (the JWT hook — path
  matching is case-sensitive), so no data escapes that way either.
- Backups: `/root/nginx-connectcomms-backup-20260818-015655Z-internal-deny.conf`,
  `/root/nginx-connectcomms-loopcom-backup-20260818-015655Z-internal-deny.conf`.
- ⛔ **`/internal/deploy/auto` is now genuinely blocked from outside.** AGENTS.md
  claimed it already was; that claim was false and has been corrected. Call it
  from the server, or use `POST /ops/deploy/enqueue` on loopback.

### §2 correction to this audit: the webhook DOES receive traffic, but never real data

The audit's proposed fix warned that inverting the default alone "would stop real
inbound SMS." **It does not.** All **127** webhook POSTs in 14 days came from
VoIP.ms carrying their own **unsubstituted template placeholders**
(`from={FROM}&to={TO}&message={MESSAGE}`) — the callback was never configured to
interpolate. **Zero requests carried real data, ever.** Real inbound SMS arrives
through the worker's `voipMsInboundSyncJob` poll. Failing closed was therefore
safe with no secret set, and no secret was set.

### §3 correction to this audit: api and worker ALREADY disagreed on the chat key

The audit lists `MOH_URL_SIGNING_SECRET` as EMPTY. That is true **only in
`app-api-1`** — in `app-worker-1` and `app-telephony-1` it is **43 chars**. Since
the old chain was `CHAT || MOH || CDR || "dev-signing-secret"`, api signed chat
URLs with the literal while the worker signed them with the MOH secret. **Every
worker-minted chat link was already unverifiable in production** (nginx logs: 0
fetches of `/api/chat/a/` in 14 days; 0 VoIP.ms-range IPs ever fetched an
attachment). The fix collapses the chain to `CHAT_URL_SIGNING_SECRET` else a key
**derived from `JWT_SECRET`** (verified byte-identical across all three
containers), so the processes now agree with no new configuration — and it
throws rather than ever use a constant.

⛔ **Blast radius, measured not assumed:** `buildChatSignedDownloadUrl` carries the
real traffic (12,960 fetches/14d) and is minted *and* verified by api alone, so an
api-only deploy is self-consistent; clients re-fetch a fresh URL on their next
7-second chat poll. The two worker-minted schemes have **zero** live usage
(**0** outbound messages with attachments in 14 days).
⏳ **The worker still runs the old module** — redeploying it is a recommended
follow-up that would also repair the pre-existing MMS-media drift; nothing depends
on it today.

---

## 0. The one-line summary

**Per-route tenant scoping in this codebase is genuinely good.** The
`findFirst({ id, tenantId })` discipline is applied consistently, the shared
helpers are correct, and the classic IDOR — `findUnique({ where: { id } })` and
return it — essentially does not exist on the tenant-facing surface. Billing,
CRM, voicemail, recordings, contacts, customers, IVR, MOH, DID, chat threads,
delivery, remote support and the agent confirmation gates all check out.

**The isolation failures that exist are not in the route handlers. They are in
the layers around them:**

1. **Secrets that are EMPTY in production, guarding doors that fail OPEN.**
2. **One signature scheme with no key at all** (`createHash`, not `createHmac`).
3. **A role — `TENANT_ADMIN` — that is admitted to `/admin/*` routes written as
   if only a platform admin could reach them.**
4. **A `NODE_ENV` gate that is permanently false** — the class CLAUDE.md already
   records, sitting in front of an unauthenticated write path.

⛔ **THE RULE THIS AUDIT ESTABLISHES: auditing the handler is the easy half.
Check the env the guard reads, and check which roles the gate actually admits.**
Four of the five criticals are invisible if you only read route bodies — the
code looks correct in every one of them.

⛔ **Nothing below is proven by exploitation.** It is proven from source,
config, environment and read-only queries. That was deliberate.

---

## 1. ⛔⛔ CRITICAL — `/internal/*` endpoints are UNAUTHENTICATED and PUBLICLY REACHABLE

**`CDR_INGEST_SECRET` is present but EMPTY in the running api container**, and
every door guarded by it **fails open by design**.

Proven, not inferred:

```
docker exec app-api-1 node -e 'const v=process.env.CDR_INGEST_SECRET; …'
  → defined: true   length: 0   trimmedLength: 0
```

- `docker-compose.app.yml:75, :260, :427` — `CDR_INGEST_SECRET: ${CDR_INGEST_SECRET:-}` (defaults to empty).
- `/opt/connectcomms/env/.env.platform` — **does not define it at all** (0 matches, case-insensitive).
- `app-telephony-1` and `app-worker-1` — also empty. **The platform already runs
  without it, so setting it breaks nothing; nothing is currently protected by it.**

### The fail-open code

`server.ts:33690` (identically at `:33569`, `:34192`, `:34610`, `:34873`,
`:35114`, `:35629`, `:35717`):

```ts
const secret = process.env.CDR_INGEST_SECRET?.trim();
if (!secret) {
  app.log.warn({ endpoint: "/internal/cdr-ingest" }, "CDR_INGEST_SECRET not set — internal endpoint is unauthenticated");
} else { /* …timing-safe compare, 403 on mismatch… */ }
```

and `server.ts:18267`:

```ts
function verifyCdrSecret(req: any): boolean {
  const secret = process.env.CDR_INGEST_SECRET?.trim();
  if (!secret) return true; // not configured → allow (dev mode)
```

⛔ **Contrast `agentMohSecretOk` (`agentMohOverride.ts:67`), which is
fail-CLOSED and timing-safe, and `billingPayToken.ts:8-16`, which THROWS when
its secret is missing.** The codebase already does this correctly twice. These
doors are the outliers.

### Why they are reachable from the internet

Every `/internal/*` path is in `shouldSkipJwtVerification`
(`jwtPublicRouteBypass.ts:11-33`), so no JWT is required — and nginx proxies the
whole `/api/` prefix with **no path exclusion**, on *both* hostnames:

- `/etc/nginx/sites-available/connectcomms:79` — `location /api/ { proxy_pass http://127.0.0.1:3001/; }`
- `/etc/nginx/sites-available/connectcomms-loopcom:134` — same.

So `https://app.connectcomunications.com/api/internal/...` and
`https://app.loopcom.net/api/internal/...` reach these handlers with no
credential of any kind.

### What an anonymous caller can do

| Endpoint | Where | Effect |
|---|---|---|
| `GET /internal/telephony/pbx-tenant-map` | `server.ts:35628` | Dumps the **entire tenant directory** — every tenant slug, PBX link, inbound DID and extension row, platform-wide |
| `GET /internal/telephony/user-extensions` | `server.ts:35716` | Every user→extension mapping on the platform |
| `POST /internal/cdr-ingest` | `server.ts:33689` | **Writes call records into any tenant's call history** (`tenantId` is a body field) |
| `POST /internal/telephony/inbound-crm-match` | `crm/inboundCallerMatchRoutes.ts:24` | CRM contact lookup by phone for **any tenant** — see §1a |
| `POST /internal/mobile-ring-notify` | `server.ts:34191` | Ring pushes to arbitrary extensions |
| `POST /internal/mobile-prewake` | `server.ts:34609` | Wake pushes to arbitrary devices |
| `POST /internal/pbx/wake-extension` | `server.ts:35113` | Wake enrollment writes |
| `POST /internal/pbx/publish-wake-config` | `server.ts:34872` | Dial-key publish |
| `POST /internal/pbx/contact-status` | `server.ts:33568` | Device contact-status writes |
| `POST /internal/voicemail-notify` | `server.ts:29648` | Voicemail notify pipeline (`verifyCdrSecret` → `true`) |
| `POST /internal/pbx-event-ingest` | `server.ts:34084` | PBX event ingest |

**Concrete scenario:** an unauthenticated attacker `GET`s
`/api/internal/telephony/pbx-tenant-map`, receives slugs and DIDs for all 29 live
tenants, then `POST`s `/api/internal/cdr-ingest` with `tenantId: "<victim>"` to
write fabricated calls into a competitor's history — or floods
`/api/internal/mobile-ring-notify` to ring every extension on the platform.

⛔ **This is the 2026-08-02 wound from the other side.** That incident was
Connect *trusting* a telephony-supplied tenant id; the fix made attribution
prefer unforgeable PBX markers. But the markers arrive in the same request body,
and the door itself now has no lock at all.

### §1a — `inbound-crm-match` also takes the caller's ROLE from the body

`crm/inboundCallerMatchRoutes.ts:5-12, :24-37` — the body carries `tenantId`
**and** `viewer.role`. `userHasCrmAccess` (`inboundCallerMatch.ts:151`) and
`userCanAccessCrmContact` (`crmContactAccess.ts:132`) both open with
`if (isAdminRole(role)) return true`, so `{"viewer":{"role":"SUPER_ADMIN"}}`
short-circuits the `CrmUserAccess` lookup entirely — `userId` need not exist.
With the empty secret this is an **unauthenticated CRM contact oracle for every
tenant**, queryable by phone number.

---

## 2. ⛔⛔ CRITICAL — the VoIP.ms inbound SMS webhook is completely unauthenticated

**`connectChatRoutes.ts:2230` / `:2243`**

```js
let authorized = !cfg.webhookSecretEncrypted;              // no secret stored ⇒ authorized = true
…
if (!authorized && cfg.webhookSecretEncrypted) return 401;  // the 401 is itself gated on the secret existing
```

**Confirmed against production (read-only):**

```
GlobalVoipMsConfig(id="default")  → config exists: true   webhookSecret set: FALSE
```

`webhookSecretEncrypted` is only written when `body.webhookSecret` is supplied to
`PUT /admin/apps/voip-ms/credentials` (`:1786`, `:1800`). It is null. So
`POST /webhooks/voipms/sms` — public, JWT-bypass list line 148 — is wide open.

**Concrete scenario:** the attacker needs only a customer's public phone number.
`POST /api/webhooks/voipms/sms` with `to=<their DID>&from=<any sender>&message=…`
→ tenant resolved from the DID (`:2274`) → thread created or reused →
`ConnectChatMessage` written into **that customer's SMS inbox** (`:2330`) → push
notifications fanned out to every participant (`:2385`) → `crmInboundSmsHook`
writes it onto the CRM timeline (`:2404`).

That is **arbitrary message injection into any customer's inbox, appearing to
come from any sender they trust** — a ready-made phishing channel against a
customer's own staff, plus `SmsRoutingLog` pollution and inflated counts.

⛔ Fix shape: invert the default (`let authorized = false`) and refuse when
unconfigured — **and set the secret**, since inverting it alone would stop real
inbound SMS.

---

## 3. ⛔⛔ CRITICAL — signed download URLs: one scheme has NO key, and every other falls back to a constant in this repo

### 3a. `chat-db` attachment URLs are signed with an UNKEYED hash

`packages/shared/src/chatSignedUrl.ts:37` (mint) and `:97` (verify) — **read and
confirmed directly**:

```js
crypto.createHash("sha256").update(chatDbSignedPayload(attachmentId, storageKey, sizeBytes, exp)).digest("hex")
```

`createHash`, not `createHmac`. **No secret is involved at any point.** Its three
siblings in the very same file (`buildChatSignedDownloadUrl`,
`buildChatAttachmentIdSignedDownloadUrl` and their verifiers) correctly use
`createHmac(..., signingSecret())`.

`GET /chat/attachments/download/*` (`connectChatRoutes.ts:840-848`, public via
`jwtPublicRouteBypass.ts:152`) reaches it deliberately: when the HMAC check
returns `invalid` (not `expired`) it looks the attachment up **by `storageKey`
alone, unscoped** (`:841`) and retries with the unkeyed scheme (`:846`).

**Exploitable today, precisely:** `GET /chat/threads/:id/messages` hands every
authorized caller all three inputs per attachment — `id` (`:1426`), `sizeBytes`
(`:1429`) and a `downloadUrl` containing `storageKey` (`:1431`). So any user can
mint a **permanent, self-renewing, unauthenticated** URL for any attachment and
publish it. Expiry is unenforceable against anyone who has seen one message
payload. Attachment ids are Prisma `cuid()`s (timestamp + counter + fingerprint
+ random — partially predictable) and `sizeBytes` is a small integer, so there is
no secret standing between a guessed triple and another tenant's file.

### 3b. Every other signing helper resolves to the literal `"dev-signing-secret"`

Five helpers share one fallback chain, and **every variable in it is empty or
undefined in production** (proven by `docker exec`):

```
CHAT_URL_SIGNING_SECRET                  UNDEFINED
PROMPT_URL_SIGNING_SECRET                EMPTY
MOH_URL_SIGNING_SECRET                   EMPTY
CRM_DOC_URL_SIGNING_SECRET               UNDEFINED
CRM_VOICEMAIL_DROP_URL_SIGNING_SECRET    UNDEFINED
CDR_INGEST_SECRET                        EMPTY
                                         → "dev-signing-secret"
```

⛔ **`""` is falsy in JS, so an EMPTY variable falls straight through `||` to the
next — an operator who "set" these to blank would see no error and no log line.**
⛔ `CHAT_URL_SIGNING_SECRET` appears **nowhere in `docker-compose.app.yml`** at all.

| Helper | File:line | Consumed by |
|---|---|---|
| `signingSecret()` | `chatSignedUrl.ts:8-12` | `GET /chat/a/:attachmentId` — **JWT-bypassed** (`jwtPublicRouteBypass.ts:153`) |
| `signingSecret()` | `promptStorage.ts:39-47` | `GET /voice/ivr/prompts/download/:storageKey` (`server.ts:23216`) — **JWT-bypassed** |
| `signingSecret()` | `mohStorage.ts:42-47` | `GET /voice/moh/download/...` — **JWT-bypassed** |
| `signingSecret()` | `crmVoicemailDropStorage.ts:35-42` | `GET /crm/voicemail-drops/:id/stream` |
| `signingSecret()` | `crm/docImportStorage.ts:38-47` | `GET /crm/documents/:id/open` |

The HMAC verification itself is textbook — `crypto.timingSafeEqual`, expiry
enforced, path traversal blocked (`resolvePromptStoragePath:85-94`). **It is
simply keyed on a value published in git**, so the signature provides no
authorization and `exp` is meaningless: anyone can re-sign an expired URL.

**The worst of these is `GET /chat/a/:attachmentId`** (`connectChatRoutes.ts:868-890`):
its lookup is `findUnique({ where: { id: attachmentId } })` with **no tenant
filter**, protected solely by the now-forgeable HMAC. That is unauthenticated
cross-tenant attachment read, bounded only by cuid guessability.

⛔ **The contrast that proves this is fixable, not a design:**
`billing/billingPayToken.ts:8-16` faces the identical situation and **throws**
rather than fall back. Billing pay links are consequently sound (§7).

---

## 4. ⛔ HIGH — `TENANT_ADMIN` reaches `/admin/*` routes written for a platform admin

`requireAdmin` (`server.ts:1978`) admits **`ADMIN`, `TENANT_ADMIN`,
`SUPER_ADMIN`**. Several handlers behind it query with no tenant filter, because
they were written as super-admin screens.

**This is LIVE.** Proven against production:

- **8 `TENANT_ADMIN` accounts, all `ACTIVE`, in 8 DIFFERENT real customer
  tenants** (Matamim, Landau Home, Ribit Capital, Fixup Group, Yossis Wood
  Works, Luxure Management, +2). 1 `SUPER_ADMIN`, 75 `USER`, **0 `ADMIN`**.
- The live `PlatformRolePermissionSnapshot(id="default")` grants the
  **TENANT_ADMIN** bucket (92 keys): `can_view_admin`, `can_view_admin_console`,
  `can_view_admin_users`, **`can_view_admin_tenants`**,
  `can_view_admin_pbx_instances`, `can_view_admin_pbx_events`,
  `can_view_admin_billing`, `can_view_admin_cdr_tenant_map`,
  `can_view_admin_roles`, `can_view_admin_phone_numbers`,
  `can_view_admin_onboarding`.

So the global preHandler permission gate (`server.ts:5964-5967`) **passes** for
`/admin/tenants`, `requireAdmin` passes, and the handler has no `where`.

### 4a. CONFIRMED, reachable today

| Route | server.ts | What a tenant admin gets |
|---|---|---|
| `GET /admin/tenants` | **:8653** | `db.tenant.findMany({ orderBy })` — **every tenant row on the platform** (50; 29 live): name, PBX tenant id + instance, `isApproved`, `dailySmsCap`, `perSecondRate`, `linkedSipCallVisibilityEnabled`, user count, campaign count |
| `PATCH /admin/tenants/:id` | **:8718** | `db.tenant.update({ where: { id } })` — **write** `isApproved`, `dailySmsCap`, `perSecondRate`, `firstCampaignRequiresApproval` on **any other customer** |
| `GET /admin/wake-health` | **:5326** | `computeWakeHealth()` — every active Android device platform-wide with **the user's EMAIL ADDRESS and tenant NAME** (20 devices today). ⛔ Matches **no** entry in `PORTAL_API_PERMISSION_RULES`, so it has no permission gate at all — only `requireAdmin` |
| `GET /admin/sms/campaigns` | :9360 | `db.smsCampaign.findMany` unfiltered — every campaign's name, message body, status (0 rows today) |
| `POST /admin/sms/campaigns/:id/approve` | :9367 | `findUnique({ id })` then `status: "QUEUED"` + `enqueueCampaignMessages` — **release another company's held campaign to send** |
| `POST /admin/sms/campaigns/:id/reject` | :9380 | Kill another company's campaign; mark all its queued messages FAILED |

**Concrete scenario:** the tenant admin at Luxure Management signs in, calls
`GET /api/admin/tenants` and receives the platform's full customer list
including their competitors. They then `PATCH /api/admin/tenants/<Gesheft's id>`
with `{"dailySmsCap": 0, "isApproved": false}` and silently disable another
customer's texting.

⛔ The SMS-campaign gate is `can_view_apps_sms_campaigns`, which the **END_USER**
bucket also holds — those routes are protected from ordinary users only by
`requireAdmin`'s role check, not by the permission layer.

### 4b. CONFIRMED unscoped, currently blocked by the permission gate

Defence-in-depth only — **one permission-map edit turns each into 4a**:

- `GET /admin/ten-dlc/submissions` (:8630), `GET .../:id` (:8637),
  `POST .../:id/status` (:8644) — no tenant filter; gate is
  `can_view_admin_ops_center`, which TENANT_ADMIN does **not** hold. 0 rows today.
- `GET /admin/sms/provider-health` (:8862) — cross-tenant volumes + names; same gate.

---

## 5. ⛔ HIGH — anyone can create Connect tenants and invoices, unauthenticated

`onboarding/publicRoutes.ts:60-65`:

```ts
function isProduction(): boolean { return String(process.env.NODE_ENV || "development") === "production"; }
function canLazyCreate(): boolean { return !isProduction(); }
```

**`NODE_ENV` is UNDEFINED in `app-api-1`** (re-proven this session), so
`canLazyCreate()` is permanently `true`. The whole `/onboarding/` prefix is
JWT-bypassed (`jwtPublicRouteBypass.ts:96`).

`PUT /onboarding/:token/save` (`publicRoutes.ts:319-336`) on an unknown token
**creates an `OnboardingSubmission` with the caller's token and
`answers: z.unknown()`** — arbitrary, unvalidated.

Chain, entirely unauthenticated:
1. `PUT /api/onboarding/<anything>/save` → row exists.
2. `POST /api/onboarding/<token>/submit` (`:634`) → SUBMITTED, extensions created.
3. `POST /api/onboarding/<token>/checkout` (`:543`) → `ensureTenantForSubmission`
   → **`tenant.create({ kind: "CUSTOMER", isApproved: true })`**
   (`onboardingPayment.ts:89`) + billing defaults + a `BillingInvoice` + a public
   pay token.
4. `POST /api/onboarding/<token>/upload-bill` (`:350`) → 10 MB per call to the
   `onboarding-files` volume, unbounded calls.
5. `GET /api/onboarding/<token>/numbers` (`:181`) → drives the **master VoIP.ms
   reseller account** (15–25 s per search).
6. Every first open emails the owner (`recordLinkOpened`, `:110`).

**Amplifier:** `answers` is unvalidated, so
`{"answers":{"reusableTestLink":true}}` makes the fabricated row a spawn template
(`validation.ts:72`), after which `POST /onboarding/test/:token/spawn` (`:149`)
mints unlimited further submissions.

⛔ **This is another surviving site of the `NODE_ENV` class** already recorded in
`AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §4 — CLAUDE.md **names this exact
line**. It was catalogued as dead-code cleanup; it is an unauthenticated write
path. ⛔ **Do NOT fix it by setting `NODE_ENV=production` on the container** —
that flips every other gate at once.

---

## 6. MEDIUM / LOW findings

### 6a. `/admin/apps/voip-ms/routing-preview` has no tenant scoping
`connectChatRoutes.ts:2116-2143` — gate is `isSuper(user) || isTenantAdmin(user)`,
then `tenantSmsNumber.findUnique({ where: { phoneE164 } })` with no tenant
filter, returning `tenantId`, `assignedUserId`, `assignedExtensionId` and
`isTenantDefault`. Any tenant admin can walk E.164 ranges and learn **which
Connect tenant owns each number and which internal user it routes to**.

### 6b. `PATCH /admin/apps/voip-ms/numbers/:id` skips its tenant guard on unassigned rows
`connectChatRoutes.ts:2065-2072` — `if (row.tenantId && row.tenantId !== effTenant) return 403`
is **skipped when `row.tenantId` is null**. **Confirmed: 58 unassigned
`TenantSmsNumber` rows exist** (the spare pool plus numbers mid-port). A tenant
admin who knows a row's cuid can send `{ tenantId: <their own> }` and **claim a
spare platform DID** — including one a port-in is landing for another customer —
routing its inbound SMS to themselves. The list route (`:2006`) withholds
null-tenant rows from non-supers, so there is a discovery hurdle. Fix:
`if (row.tenantId !== effTenant) return 403`.

### 6c. Role **assignment** never re-checks grantability
`customRoleRoutes.ts:420-464` — create (`:230`) and update (`:283`) both call
`getGrantablePermissions`; the assignment route validates only that the role ids
belong to `actor.tenantId` (`:442`) and never inspects the role's `permissions`.
Since `computeAuthoritativePortalPermissions` (`crm/portalCrmPermissions.ts:26`)
makes an active custom role **authoritative**, a `TENANT_ADMIN` can assign
themselves any role sitting in their tenant — including one a SUPER_ADMIN created
there carrying `PROTECTED_PLATFORM_ADMIN_PERMISSIONS` — and `/admin/custom-roles`
(`:160`) shows them each role's full permission array. **Bounded:** this grants
portal permission *keys*, not the JWT `role`, so everything gated on
`isSuper(user)` stays closed.
⛔ Also: that file's header comment (`:14`) still says *"Permissions are additive
only (union with built-in role bucket). No deny/override."* — **factually wrong**
since custom roles became authoritative. Stale comment on a security-critical file.

### 6d. Recording streaming skips the tenant check when the CDR is unattributed
`server.ts:20569` — `if (rec.tenantId) { …tenant membership check… }`. When
`ConnectCdr.tenantId` is `null` the check is skipped, and the extension fallback
(`:20601`) passes when `rec.extension` is null — which it is for every inbound
call, because `toNumber` is a 10-digit DID and the regex is `/^\d{2,6}$/`
(`:20817`). Any user holding `can_view_recordings` can then stream it.
**Sized read-only: 125,266 CDR rows, 4,310 with `tenantId: null`, of which only
6 advertise a live recording.** Also needs the `linkedId` (`<epoch>.<seq>`), so
low-impact today — but it grows with every unattributed call.

### 6e. `/crm/voicemail-drops/:id/stream` — no auth call, no tenant filter
`crm/voicemailDropRoutes.ts:516-532` — the only route in that file without
`requireCrmAccess`; `findFirst({ where: { id } })` with no `tenantId`, relying
solely on an HMAC covering `dropId:storageKey:exp` that is **not bound to tenant
or user**. Combined with §3b (the key is a public constant): any authenticated
user of any tenant can stream any tenant's voicemail-drop audio given the ids.
⛔ The correct pattern is next door — `docImportRoutes.ts:188-239` runs a dual
gate: `requireCrmAccess` **and** an HMAC bound to `docId + tenantId + userId + exp`.

### 6f. `retry-payment` resolves a payment method with no tenant constraint
`billing/routes.ts:2924-2932` — `paymentMethod.findUnique({ where: { id: methodId } })`,
and `chargeBillingInvoice` (`solaBillingPayments.ts:152`) never asserts
`method.tenantId === invoice.tenantId`. Its sibling three routes up does it right
(`:2878`). **Not exploitable today** — `methodId` is server-derived — but one
stale `paymentMethodId` would charge the wrong company's vaulted card and read as
a gateway anomaly.

### 6g. Delivery `createDriver` validates neither the user nor the stores
`delivery/dispatchService.ts:278-289` upserts `driverProfile` on a caller-supplied
`userId` and creates `DeliveryDriverStore` rows on caller-supplied `storeIds`
with no tenant check; `delivery/orderService.ts:257-262` then resolves those
users with **no `tenantId`** in the `where`. A delivery admin in tenant A who
knows a tenant-B user id gets that user's name and email back from
`GET /delivery/drivers`. Disclosure, not privilege transfer.

### 6h. `PATCH`/`DELETE /voice/pbx/resources/:resource/:id` pass a raw id to VitalPBX
`server.ts:17847`, `:17861` — the PBX instance comes from the caller's own
`tenantPbxLink`, but the resource `:id` goes straight through
`vitalUpdateByResource`/`vitalDeleteByResource` (`:16576`, `:16590`), and for
`extensions`, `ring-groups`, `ivr`, `routes`, `trunks` and **`tenants`** no
tenant scope is passed — the platform admin app-key is used.
**Not reachable today:** `TENANT_ADMIN` is absent from `VITALPBX_ROLE_PERMISSIONS`
(`:1820`) so it falls back to the `USER` set (view-only), and **zero users hold
the `ADMIN` role**. ⛔ **Creating one `ADMIN`-role user makes
`DELETE /voice/pbx/resources/tenants/<other tenant>` live.**

### 6i. The global rate limit is one bucket for the whole platform
`server.ts:343` constructs Fastify with **no `trustProxy`**; `:346` registers
`@fastify/rate-limit` with **no `keyGenerator`**, so the default key is `req.ip`
— the nginx hop, identical for every request. Same defect `loginThrottle.ts:138`
already works around. It gives §1, §2 and §5 no per-attacker throttle, and lets
one client 429 every customer.

### 6j. Combined pay links are 401-ing (fails closed — availability, not a leak)
`jwtPublicRouteBypass.ts:103-108` bypasses `/billing/platform/invoices/pay/`;
`"pay-multi/"` does not match `"pay/"`, so all three routes in
`publicPayRoutes.ts:69, :110, :132` are 401'd before the handler runs. **This is
the `401/401` on `/pay/invoices/` already recorded in CLAUDE.md's Cloudflare
section and read there as a routing quirk — it is this.**

### 6k. `POST /admin/dev/generate-observe-token` mints a `tenantId: "global"` SUPER_ADMIN JWT
`server.ts:5902` — JWT-bypassed, gated by `canIssueDevObserveJwt` (`:1795`),
which is fail-CLOSED when `DEV_OBSERVE_TOKEN_SECRET` is unset. **It IS set in
production (48 chars).** Anyone holding that value gets a 90-minute SUPER_ADMIN
token whose `tenantId` is `"global"` — and `resolveTenantIdFilterSet` (`:18288`)
returns `null` for `"global"`, i.e. **no tenant restriction anywhere**. The route
header calls itself `TEMPORARY: remove when observation is done`.

### 6l. Smaller notes
- `lanPhoneRoutes.ts:101`, `:126` — `POST /lan-phones/runs` and `/runs/:id/report`
  have **no permission check at all** (the three read routes correctly require
  `can_view_lan_phones`). Own-tenant only, but it lets any user fabricate
  phone-inventory rows a support engineer later reads as ground truth.
- `remoteSupportRoutes.ts:205-211` — target looked up unscoped, then the policy
  denies; `404 user_not_found` vs `403 cross_tenant_not_allowed` is a
  **platform-wide user-id existence oracle** for anyone with `can_remote_support`.
- `jwtPublicRouteBypass.ts:152-153` — bypass uses `path.includes("/chat/a/")`,
  a substring match on the whole path. Not exploitable today (only two wildcard
  routes exist, both signature-gated) but one new param route from going public.
  Anchor to `startsWith`.
- `delivery/{smsRoutes,voiceRoutes,routes}.ts` — five `/internal/delivery/*`
  routes take `tenantId` from a caller-supplied header/body behind
  `verifyOrderSourceSecret` alone (fail-closed, and
  `DELIVERY_ORDER_SOURCE_SECRET` is **UNDEFINED**, so they refuse today). They
  are **not** JWT-bypassed, so a valid token is also required — but no role check.
- `delivery/scanService.ts:46` — `deliveryAssignment.findUnique({ clientOpId })`
  unscoped on a client-supplied string; returns a foreign tenant's `orderId` on a
  collision. Real ids are UUIDs / 40-bit tokens, so guessing is impractical.
- `delivery/locationService.ts:20` — `startSession` never validates `runId`
  against the tenant or driver. Read side (`:93`) is tenant-filtered, so no
  cross-tenant read follows; data-integrity only.
- `campaignRoutes.ts:855-885` — `assignedToUserId` written unvalidated; the same
  file validates it at `:798-804`.
- `didSwitchSchedule.ts:231-270` — `profileId` not tenant-checked while the
  sibling `assign` route (`:215`) does check. Not a leak (menus publish under the
  per-tenant AstDB family).
- `didSwitchSchedule.ts:339-373` — `promptRef` never validated against the
  tenant's catalog, unlike the IVR publish path; PBX prompt filenames are not
  tenant-partitioned (`generatedPromptStore.ts:105`).
- `server.ts:25995` — `mohProfile.findUnique({ id: mapping.mohProfileId })`
  unscoped in the didmap publisher; MOH class names are a global PBX namespace.
- `docImportRoutes.ts:213-223` — deliberate cross-tenant existence oracle for
  audit logging. No content leaks; noted for awareness.
- `accountSetupInfoRoute.ts:129, :149`, `contactsInfoRoute.ts:80` — fail-closed
  but use a plain `!==` instead of the timing-safe `agentMohSecretOk`.
- `guard.ts:172` — `requireCrmAdmin` ignores the super-admin tenant switch, so a
  SUPER_ADMIN reads tenant B but writes to tenant A. Fails safe; still wrong.

---

## 7. CLEAN — verified correct (this bounds the problem, and it matters)

Everything here **looked** suspicious to a mechanical scan and was read to the
bottom. None of it is a finding.

- **Voicemail** — `findUnique({ id })` then `canAccessVoicemail` (`server.ts:18769`)
  → tenant-id-set membership + owned-mailbox check, deny-by-default, with a
  separate pure policy module (`voicemailAccessPolicy.ts`) and a read-state
  ownership rule. List, stream, download, patch and delete share one scope.
- **Call recordings** — `streamCallRecording` (`:20546`) resolves the caller's
  full tenant-id set (cuid + `vpbx:` forms), then the linked-SIP carve-out, the
  tenant-wide key, the owner carve-out, then separate listen/download gates. The
  deliberate cross-tenant feature (`linkedSipCallVisibilityEnabled`,
  `AGENT_HANDOFF_LINKED_SIP_CALL_VISIBILITY_2026-08-13.md`) is correctly
  implemented and correctly refuses the owner carve-out on foreign recordings.
  **Only the null-tenant edge (§6d) is wrong.**
- **`/calls/history`** (`:29938`) — non-super-admins always scoped to their own
  resolved tenant-id set; the client `tenantId` param is SUPER_ADMIN-only.
- **Contacts / customers** — every route `findFirst({ id, tenantId })`, including
  the avatar GET/POST/DELETE byte paths. `effectiveContactsTenantId` (`:31539`)
  honours a client tenant **only** for SUPER_ADMIN.
- **Billing** — all 15 tenant routes scope on `effectiveTenantId`; all ~94
  `/admin/billing/*` routes are SUPER_ADMIN (`canAccessAdminBilling`, `:1774`, is
  `SUPER_ADMIN` only — so despite TENANT_ADMIN holding `can_view_admin_billing`
  at the preHandler, the route-level check stops them). Public pay tokens are
  HMAC-signed with the **tenantId inside the signed payload and used in the DB
  `where`**; single and multi verifiers reject each other's tokens.
- **CRM** — ~40 instances of the `findFirst({id, tenantId})` → `update({id})`
  idiom, all verified guarded. Public forms key on `hashFormToken`, never an id.
  Drive OAuth callback uses HMAC state + `timingSafeEqual` + 10-min expiry.
  `emailRoutes.ts:1139` `attachmentIds` look unvalidated but the worker forces
  `where.tenantId` (`crmEmailSend.ts:121`).
- **Chat threads / messages / reactions / edit / delete** — all 12 thread-scoped
  routes resolve the participant via
  `findFirst({ threadId, userId: user.sub, leftAt: null, thread: { tenantId } })`,
  and every message lookup is `{ id, threadId, tenantId }`. The tenant-wide read
  path (`can_view_tenant_chats`) still re-checks `{ id: threadId, tenantId }`.
  **Attachment upload → message persist is sound**: the key is built server-side
  from `tenantId`+`threadId` and `assertStorageKeyForThread`
  (`chatAttachmentStorage.ts:246`) plus a size match run on every row, so a
  client cannot attach a foreign key to its own message. **The chat defect is
  purely in the signature scheme (§3), not the scoping.**
- **IVR / MOH / DID** — consistent fetch-by-id then `assertIvrTenantAccess` /
  `assertMohTenantAccess` / `loadIvrProfileForWrite` (`:21862`, `:23452`), at
  every call site checked (7 in `didSwitchSchedule.ts`, 2 each in
  `pbx/teamRoutes.ts` and `pbx/forwardRoutes.ts`).
- **The query-string tenant bug is properly fixed.**
  `resolveGeneratedPromptTenantId` (`voice/generatedPromptStore.ts:88`) opens
  with `if (!opts.isSuperAdmin) return opts.userTenantId || null;` and **both**
  generate routes use it (`elevenLabsRoutes.ts:348`, `pollyRoutes.ts:334`).
- **`/internal/agent/*` doors (all 9)** — check their secret as the first
  statement and are **fail-closed** when unset. They take `tenantId` from the
  body by design (the shared secret is the boundary), and the agent side never
  lets the model choose it (`provisioningTools.ts:80,150,242,354` use
  `ctx.tenantId` and discard model args).
- **Agent confirmation gates** — `applyConfirmedAction` (`agentConfirmations.ts:274`)
  re-derives the tenant server-side and rejects any draft whose `tenantId`
  differs; the claim is atomic; `agentFixByText.ts` adds a sender allow-list
  checked before the code lookup, a hashed single-use code, and an approver
  re-read that refuses rather than guess.
- **Remote support** — the policy module deserves its reputation.
  `decideRequest`/`decideParticipation` (`remoteSupport/policy.ts:135`, `:208`)
  check `actor.tenantId` against the session/target tenant for non-supers,
  permissions are re-read per request, `controlGranted` is written only by the
  consent route as `requested && allowed`, and the audit list is tenant-filtered.
- **Delivery dispatcher/driver/report/proof routes** — ~30 routes all derive
  tenant from `requireDeliveryDispatch`/`requireDriver`/`requireDeliveryPermission`;
  every service lookup checked is `findFirst({ id, tenantId })`.
- **Customer tracking (`/track/*`, JWT-bypassed)** — the token is 24 bytes from
  `randomBytes` over a 32-char alphabet with no modulo bias (`tokens.ts:7`),
  ~120 bits, stored **hashed** (`:16`), and `resolveTrackingView`
  (`customerTrackingService.ts:60-78`) takes `tenantId` **from the token row**
  and scopes every lookup by it. No existence leak; OTP capped at 5.
- **Admin user management** — `resolveAdminTargetUser` (`:6482`) and
  `resolveManagedTenant` (`:2345`) both collapse to the actor's own tenant for
  non-SUPER_ADMIN. `POST /admin/users/:id/sip-accounts` explicitly 403s
  `cross_tenant_not_allowed`. `admin/userCrmAccessRoutes.ts` double-guards all
  three routes.
- **`customRoleRoutes.ts` read/write of assignments** — contrary to the initial
  hypothesis, both `PUT` (`:435`) and `GET` (`:400`) `/admin/users/:userId/custom-roles`
  **do** check `targetUser.tenantId !== actor.tenantId` for non-supers. The
  by-`userId`-only lookup is in `getEffectiveCustomRolePermissions`
  (`platformRolePermissions.ts:146`) — the *resolution* path, deliberate and
  documented. Only grantability-on-assignment is missing (§6c).
- **Onboarding tokens** — `randomBytes(24).toString("base64url")` = 192 bits;
  every public route resolves the row **from the token**, never from an id, so
  one token cannot reach another submission. Uploaded bills/LOAs download only
  through a SUPER_ADMIN route that re-checks `file.submissionId === id`.
- **Storage path traversal** — `resolvePromptStoragePath` (`promptStorage.ts:85`),
  `resolveApkPath` (`server.ts:4780`), `resolveOnboardingStoragePath`
  (`onboarding/storage.ts:20`), `resolveChatStoragePath`
  (`chatAttachmentStorage.ts:38`) and the CRM equivalents all reject `..` and
  verify the resolved path stays under the root.
- **`/admin/pbx/*` mutating routes** (suspend, unsuspend, delete, sync,
  resources) — all `requireSuperAdmin`, despite TENANT_ADMIN holding
  `can_view_admin_pbx_instances` at the preHandler.
- **`ops/storageMaintenance/routes.ts`** — 13 handlers, 13 `requireSuperAdmin`.
- **The JWT bypass matcher** strips the query string before matching
  (`server.ts:5927`), so there is no `?`-suffix bypass.
- **The SUPER_ADMIN `x-tenant-context` override** (`server.ts:5957-5963`),
  `getEffectiveEmailTenantId` (`:540`) and
  `resolveEffectiveTenantBillingContext` (`billing/billingAuth.ts:28`) are all
  correctly role-gated.

---

## 8. What was NOT covered

- **`apps/telephony`, `apps/worker`, `apps/agent`** — their own HTTP surfaces and
  WebSocket auth. **`/ws/telephony` in particular broadcasts live call state and
  its tenant filtering was NOT audited here.**
- **`apps/portal`** — client-side only; presentation is not access control.
- **Whether VitalPBX itself enforces tenant ownership on a raw resource id** —
  §6h assumes it does not, because our code passes no scope. Confirming that
  needs a PBX-side test, which is out of scope (PBX is read-only).
- **Whether any live `PaymentMethod` row is mis-tenanted** (§6f) — not queried.
- **No cross-tenant HTTP request was made**, so nothing here is proven by
  exploitation.

---

## 9. Suggested order of work (for whoever scopes the fixes — NOT done here)

1. **§2** — the VoIP.ms webhook. Anyone with a customer's phone number can put
   words in their inbox today. Set the webhook secret **and** invert the
   fail-open default (inverting alone stops real inbound SMS).
2. **§1** — set `CDR_INGEST_SECRET` in `.env.platform` (and telephony/worker),
   then make both guards fail closed. Nothing depends on it today, so setting it
   is safe; the fail-closed change is the part that needs a test.
3. **§3a** — `createHash` → `createHmac(..., signingSecret())` in
   `chatSignedUrl.ts:37` and `:97`. One word, twice. ⛔ It invalidates in-flight
   MMS URLs minted by `worker/connectChatSmsJob.ts:174` (1 h TTL) — roll it in a
   quiet hour.
4. **§3b** — set the five URL-signing secrets, then delete the
   `"dev-signing-secret"` fallback so the next missing value throws (mirror
   `billingPayToken.ts`). ⛔ Rotating invalidates in-flight signed URLs; check
   the PBX media-sync cycle first.
5. **§4a** — tenant-scope the six `requireAdmin` routes, or move them to
   `requireSuperAdmin`. `GET /admin/tenants` and `PATCH /admin/tenants/:id` are
   the two that matter; `/admin/wake-health` additionally needs a
   `PORTAL_API_PERMISSION_RULES` entry.
6. **§5** — remove the `NODE_ENV` dependency from `canLazyCreate()`: one gate,
   one test, defaulting off. ⛔ Not by setting `NODE_ENV` on the container.
7. §6a, §6b, §6c, §6d, §6e, §6f, §6g — each is a one-to-three-line scoping
   addition with a test.
8. §6k — remove `/admin/dev/generate-observe-token` or unset its secret.

⛔ **Every one of these touches a data path. Scope and test them individually — a
bad fix here is worse than a known finding.** ⛔ **Several are config-only
(`.env.platform`) and therefore have NO deploy path of their own — an env change
cannot trigger an api rebuild; it must ride a real `apps/api/` commit. See
CLAUDE.md's SIP-hostname section.**
