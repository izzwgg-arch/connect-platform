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

**Commit `d4184c26` on `feat/ivr-migration-takeover`. nginx LIVE and verified from
outside; api DEPLOYED and container-verified (`/app/.build-commit` =
`d4184c26a828`).** ⛔ The deploy log's final line reads `done 49b617e4` — another
session pushed portal/docs commits mid-build; the `verify:` line and
`.build-commit` are the authority and both read `d4184c26a828`.

Proven in the running container with production env (deployed module driven
directly): the heavy chat path mints **and** verifies, the key is **not** the repo
literal, it **is** the `JWT_SECRET`-derived value, and a forged unkeyed chat-db URL
is **rejected**.

| § | Finding | Status |
|---|---|---|
| **§1** | `/internal/*` unauthenticated + publicly reachable | ✅ **FULLY CLOSED 2026-08-18** — nginx deny (kept, defence in depth) **and** the code now fails closed (`6ab8c74b`), with the secret distributed to api, telephony and worker. See §0b |
| **§1a** | `inbound-crm-match` takes role from body | ✅ **CLOSED 2026-08-18** — the role now comes from the `User` row, never the body. See §0c |
| **§2** | VoIP.ms SMS webhook unauthenticated | ✅ **FIXED, fails closed** (`apps/api/src/voipMsWebhookAuth.ts`) |
| **§3a** | chat-db URLs signed with unkeyed `createHash` | ✅ **FIXED — keyed HMAC** |
| **§3b** | signing secret falls back to `"dev-signing-secret"` | ✅ **CLOSED 2026-08-18** — the other four helpers now share one resolver that throws rather than use a literal. See §0c |
| **§4** | `TENANT_ADMIN` reaches `/admin/*` | ✅ **CLOSED 2026-08-18** — two routes scoped, four moved to SUPER_ADMIN, one permission-map hole filled. See §0c |
| **§5** | Anonymous tenant creation via the `NODE_ENV` gate | ✅ **CLOSED 2026-08-18** — the gate defaults closed and the `NODE_ENV` dependency is gone. See §0c |
| **§6a–§6g** | Medium / low tenant scoping | ✅ **CLOSED 2026-08-18** — all seven scoped, plus a second §6c path the audit missed (role DUPLICATE). See §0d |
| **§6k** | `/admin/dev/generate-observe-token` | ✅ **CLOSED 2026-08-18** — the route is DELETED, not re-gated. See CLAUDE.md |
| §6h–§6j, §6l | Medium / low | ⏳ **OPEN**, untouched |

⛔⛔ **CORRECTION TO THIS AUDIT, established live 2026-08-18: §6a and §6b are
LATENT, not live.** Both routes gate on `connectChatRoutes.ts`'s own
`isTenantAdmin()`, which admits **only `SUPER_ADMIN` and `ADMIN`** — and there
are **ZERO `ADMIN`-role users** on this platform (live count: 9 TENANT_ADMIN,
1 SUPER_ADMIN, 75 USER, 1 EXTENSION_USER). The audit's "any tenant admin can
walk E.164 ranges" was read off that helper's **name**, not its contents. The
only account that can reach either route today is `izzywgg@gmail.com`, the
SUPER_ADMIN, for whom the behaviour is intended. ⛔ **Creating one `ADMIN`-role
user arms both** — exactly the shape §6h already records for the raw-PBX-id
routes. The fixes shipped anyway, because that is one `POST /admin/users` away.

### ✅ §0d — §6a–§6g ARE CLOSED (2026-08-18)

**One api commit on `feat/ivr-migration-takeover`. No migration, no PBX write,
no nginx change, no env change, no DNS change, no tenant row and no user role
touched.** apps/api typecheck **75 errors — the exact baseline**, none in an
edited file. 17 new tests; **12 of 12 source guards fail when replayed against
the pre-change blobs from `HEAD`.**

- **§6a — `routing-preview`.** A number owned by another tenant now answers
  **byte-identically to a number that does not exist** (`{found:false}`), rather
  than returning its owner and the staff member it rings. The route takes an
  arbitrary E.164, so anything less makes it a walkable directory of the
  platform's DIDs.
- **§6b — `PATCH /admin/apps/voip-ms/numbers/:id`.** The guard was
  `if (row.tenantId && row.tenantId !== effTenant)` — it **skipped itself on an
  unassigned row**, so a caller could claim a spare platform DID (57 live) or
  one a port-in was landing for another customer, and route its inbound SMS to
  themselves. Now strict equality, so `null` is refused. ✅ Safe to tighten: the
  numbers LIST route already filters `{ tenantId }` for non-supers, so a
  non-super is never shown a null-tenant row and no portal flow claims a spare.
- ⛔⛔ **§6c — the audit found ONE path and there were TWO.** Assignment
  (`PUT /admin/users/:userId/custom-roles`) validated only that the role ids
  belonged to the actor's tenant and never looked at the role's `permissions` —
  but **`POST /admin/custom-roles/:id/duplicate` copies `source.permissions`
  verbatim with no grantability check either**, and the update route validates
  permissions only when the body carries them, so the copy could then simply be
  activated. Both now run `ungrantablePermissionsFor()`. ⛔ **The rule this
  earns: re-check grantability wherever a role's permissions REACH a user, not
  only where they are typed in.** Bounded as the audit says — this grants portal
  permission *keys*, never the JWT `role`, so everything gated on `isSuper()`
  stays closed.
- ✅ **The stale header comment is corrected.** `customRoleRoutes.ts` still said
  *"Permissions are additive only … No deny/override"*, wrong since custom roles
  became **authoritative** — and that exact misreading is what makes someone
  build a role as "just the extras" and delete the rest of a person's portal.
- **§6d — unattributed recordings.** `if (rec.tenantId)` skipped the whole
  tenant check when the CDR had no tenant, and the owner carve-out below **also**
  passes when `rec.extension` is null — which it is for every inbound call,
  because `toNumber` is a 10-digit DID and the regex is `/^\d{2,6}$/`. Now fails
  closed. ✅ **Costs no customer anything, sized live:** 4,316 of 126,052 CDRs
  are unattributed and exactly **SIX** still advertise a recording — and an
  unattributed row appears in no tenant's history, so nothing in the product
  ever offered it.
- **§6e — `/crm/voicemail-drops/:id/stream`.** The only route in its file with
  no `requireCrmAccess` and no `tenantId` filter, resting entirely on an HMAC
  bound to **neither tenant nor user** — so a signed URL issued to one company
  was replayable by any authenticated user of any other. Now the dual gate its
  neighbour `docImportRoutes.ts` already uses: authenticate, scope the row to
  the caller's tenant, **then** check the signature. ✅ **Safe for `<audio>`:**
  the route is not JWT-bypassed and the global preHandler copies `?token=` into
  Authorization — which all three portal consumers already send
  (`withToken` ×2, `tokenized`), and there is no mobile caller. Anyone holding a
  stream URL passed `requireCrmAccess` to get it.
- **§6f — `retry-payment`.** `paymentMethod.findUnique({ id })` → `findFirst`
  scoped to `invoice.tenantId` + `active: true`, matching the admin-charge
  sibling three routes above. Not exploitable (the id is server-derived), but
  one stale `paymentMethodId` would have charged **another company's vaulted
  card** and read as a gateway anomaly rather than a bug.
- **§6g — delivery `createDriver`.** Both caller-supplied ids are now validated
  against the tenant, and a cross-tenant id answers **400 with a reason** rather
  than an unhandled 500. `driverNameMap` also gained `tenantId` on its user
  lookup, so any pre-existing profile pointing at a foreign user renders as an
  id stub instead of that person's name and email.
- ⛔ **A guard that guarded nothing, caught by the replay and worth recording.**
  The §6e "no bare-id fetch" assertion was first written as
  `findFirst({ where: { id } })` and **passed against `HEAD`** — the real
  pre-change line is `findFirst({ where: { id }, select: … )`, so the regex
  matched nothing in either version. **The replay against `HEAD` is what
  exposed it; running the guards only against the fixed tree would have shipped
  a decorative test.**
- ⏳ **NOT PROVEN: none of this has been exercised by a human.** Proven as 17
  tests, the 12-of-12 `HEAD` replay, a typecheck at its exact baseline, and the
  live sizing above. **Acceptance after deploy, and the negatives matter most:**
  a CRM user can still play a voicemail drop from their own tenant; an admin
  retry-payment still charges; `POST /delivery/drivers` still creates a driver
  for an own-tenant user; and `routing-preview` for a number the caller does not
  own reads `found: false` rather than 403 (a 403 would still be an oracle).


### ✅ §0c — THE REMAINING FOUR CRITICALS ARE CLOSED (2026-08-18)

**One api commit. No migration, no PBX write, no nginx change, no env change, no
DNS change, and no tenant row or user role was touched.** Tests: **2328 pass /
8 fail**, and all 8 are pre-existing — 7 × `syncPbxTenantDirectoryFromRows`, plus
`userDisplayName.callsites` which fails on any **Windows** checkout because it
slices source on a literal `"\n}\n"` (proven by replaying that slice against
unmodified `HEAD` re-encoded to CRLF: it fails identically, with zero of this
work applied). Typecheck: **75 errors, the exact pre-existing baseline, none in
any edited file.**

> **2026-08-18 follow-up — the Windows failure is FIXED.** `userDisplayName.callsites.test.ts`,
> `supportReport.test.ts` and `apps/portal/lib/voicemailPreloadBound.test.ts` now normalise
> CRLF→LF at the point they read source (`.replace(/\r\n/g, "\n")`); the production
> `displayNameForUser` was never wrong. Expected `npm test` baseline in `apps/api` is now the
> **7 × `syncPbxTenantDirectoryFromRows`** failures only. (A CPU-loaded full run can also flake
> `elevenLabsRoutes.stress` "10-wide concurrent burst" — passes in isolation, not a regression.)
> Rule for new source-reading guard tests: see CLAUDE.md "source-reading tests must normalise CRLF".

#### §1a — the CRM oracle now reads the role from the database

`crm/inboundCallerMatch.ts` gains the pure `decideTrustedViewerRole()`;
`resolveInboundCrmCallerForViewer` looks the viewer up with
`db.user.findUnique({ where: { id: viewer.userId } })` and passes **that** role
into `userHasCrmAccess` and `userCanAccessCrmContact`. The route now forwards
**`{ userId }` only**.

- ⛔ **The body still ACCEPTS `viewer.role`, deliberately.** `apps/telephony`'s
  `CrmInboundCallerEnricher` still sends it, and tightening the schema would 400
  a running telephony container mid-deploy. It is parsed and dropped.
- **An admin's bypass is now pinned to their own tenant.** `isAdminRole(role)`
  short-circuits both CRM checks, so a TENANT_ADMIN of tenant A asking about
  tenant B used to get an answer; that is now `tenant_mismatch` → no match, no
  field leakage. ⛔ **SUPER_ADMIN keeps cross-tenant reach on purpose** — the
  platform admin's telephony feed genuinely carries other tenants' calls, so
  scoping them would silently drop enrichment they legitimately see today.
- ⛔ **Ordinary users were already safe and are unchanged:**
  `crmUserAccess.findUnique({ tenantId_userId })` is already tenant-scoped. The
  admin bypass was the entire hole.
- The status gate matches the **login** gate (`server.ts:5734`): only `DISABLED`
  is refused. Anything stricter could refuse a legitimate live WebSocket viewer.
- Cost: one indexed `User` lookup per enrichment cache miss (telephony caches
  60 s per tenant|user|phone).
- Guard: `crm/inboundCrmMatchViewerRole.test.ts`, 16 cases. ⛔ Half of them read
  the **source of both call sites** — the defect was a caller, so a test of the
  pure function passes straight through it. Proven real: all five source
  assertions fail against the pre-change files.

#### §5 — lazy tenant creation defaults closed

`onboarding/publicRoutes.ts`: `canLazyCreate()` no longer reads `NODE_ENV` at
all. It returns true only for an explicit `ONBOARDING_ALLOW_LAZY_CREATE` of
`1` / `true` / `yes` / `on`; everything else — unset, `""`, junk — is closed. A
refusal on the write path logs a warning naming the route and the token prefix,
so a legitimate need is greppable rather than presenting to a customer as "the
link stopped working".

- ⛔ **Checked before closing, not assumed: nothing legitimate uses it.** All
  **21** `OnboardingSubmission` rows in production carry a `CREATED` event reading
  either "Admin-created link" or "Spawned from reusable test link" — **0 carry
  "Submission created (lazy)"**. Every real link is minted by an authenticated
  admin (`provisioningRoutes.ts:30`) or spawned from an existing template
  (`publicRoutes.ts:154`), so the row always exists before a customer opens it.
- ⛔ **Not fixed by setting `NODE_ENV=production`** on the container — that flips
  several unrelated dead gates at once. CLAUDE.md's standing instruction, followed.
- Guard: `onboarding/lazyCreateGate.test.ts`, 9 cases, including an explicit
  sweep asserting the gate stays closed for `NODE_ENV` of unset / `""` /
  `development` / `test` / `staging` / `production` — **the old gate returned
  true for every one of those.**

#### §3b — one resolver, no literal, and the key had already moved once

New module **`apps/api/src/urlSigningSecret.ts`**. All four helpers
(`promptStorage`, `mohStorage`, `crmVoicemailDropStorage`,
`crm/docImportStorage`) now call `resolveUrlSigningKey(scheme)`: the scheme's own
variable, else a key **derived from `JWT_SECRET`** under a per-scheme label, else
**throw**.

- ⛔⛔ **THE KEY HAD ALREADY ROTATED SILENTLY, hours before this fix.** The old
  chain ended `… || CDR_INGEST_SECRET || "dev-signing-secret"`, and populating
  `CDR_INGEST_SECRET` to close §1 turned that third rung into a real 64-char
  value. Verified live: all four schemes in `app-api-1` were resolving to the CDR
  secret (`sha256[0:12] = 994ecc32aee9`), **not** the literal — so anything minted
  before that deploy was already unverifiable. That is precisely why a chain of
  unrelated fallbacks is the wrong shape: a change made for one reason rotates
  keys for four others, with no log line.
- ⛔ **`CDR_INGEST_SECRET` is deliberately removed from the chain.** It is an
  *authentication* credential whose rotation CLAUDE.md now documents as a
  four-step, multi-service operation; borrowing it as a signing key means every
  such rotation silently invalidates every outstanding signed URL.
- ⛔ **Per-scheme labels are load-bearing, not decoration.** `promptStorage` and
  `mohStorage` sign the byte-identical payload `${storageKey}:${exp}`, so while
  they shared one key a valid MOH signature was **also** a valid PROMPT signature
  for the same storage key. Domain separation ends that for free.
- **Blast radius, measured not assumed — essentially nil.** All four mint **and**
  verify inside `apps/api` (one process; blue/green shares one env), the TTLs are
  300–900 s, and 14 days of nginx logs hold: prompt download **0**, MOH download
  **2** (both from the PBX on 2026-08-10, fetched within seconds of minting), CRM
  voicemail-drop stream **0**, CRM doc open **0**. ⛔ The 20 apparent
  `/crm/voicemail-drops/` hits are Next.js JS chunk fetches for the portal page,
  not the signed route — count the signed path, not the substring.
- ⛔ **`JWT_SECRET` is verified present and byte-identical** across api, telephony
  and worker (64 chars, `a0ecb5fb982e`) and comes from `env_file` with **no
  `environment:` override**, so the throw path cannot fire in production and
  `api_candidate` necessarily agrees with `api`.
- ⛔ **Noted and deliberately NOT changed:** api and api_candidate carry
  `MOH_URL_SIGNING_SECRET: ${MOH_URL_SIGNING_SECRET:-}` in `environment:`, which
  overrides the 43-char `.env.platform` value with `""` — the same trap that left
  `CDR_INGEST_SECRET` empty for the life of the platform. It is left in place
  because nothing outside `apps/api` mints or verifies a MOH URL, so api deriving
  from `JWT_SECRET` is deterministic and correct. Both compose blocks now carry a
  comment saying that deleting the line would hand api the 43-char file value and
  rotate every outstanding MOH URL.
- Two existing suites (`crm/docImportRoutes.test.ts`,
  `crmVoicemailDropStorage.test.ts`) now pin a test key at the top. They exercise
  signature mechanics, and key resolution has its own suite. ⛔ **They were
  silently exercising the repo literal before** — which is itself the proof the
  literal was reachable.
- Guard: `urlSigningSecret.test.ts`, 28 cases. All 16 source assertions fail
  against the pre-change modules.

#### §4 — scoped where a per-tenant answer exists, restricted where it does not

⛔ **Investigated before restricting, because these are 8 real customer
administrators.** What the evidence showed:

- The live `PlatformRolePermissionSnapshot(id="default")` v2 gives TENANT_ADMIN
  92 keys including `can_view_admin_tenants` — but **NOT `can_view_section_admin`**
  and **NOT `can_switch_tenants`**. `navConfig.ts` gates every admin item on
  `sectionPermission: "can_view_section_admin"`, so **the whole Admin section is
  already hidden from a tenant admin's sidebar.**
- `useAppContext.tsx:408` forces `adminScope` to `"TENANT"` for anyone who is not
  SUPER_ADMIN, and every `platformData.ts` call to `/admin/tenants` sits inside
  `if (scope === "GLOBAL")` — structurally unreachable for a tenant admin.
- The paired `/admin/tenants` + `/admin/pbx/tenants` fetch comes from
  `loadTenantOptions()`, gated on `can_switch_tenants`, which TENANT_ADMIN does
  not hold. The logs agree: of **363** `GET /admin/tenants` calls in 14 days,
  **335 came from two of the SUPER_ADMIN's own IPs**, and every remaining IP shows
  the same 1:1 pairing — the tenant-switcher boot, not deliberate browsing.
- **`PATCH /admin/tenants/:id`, `/admin/wake-health`, `GET /admin/sms/campaigns`
  and both campaign approve/reject routes had ZERO calls in 14 days**, and
  `SmsCampaign` holds 0 rows platform-wide.
- The two remaining `?light=1` callers (`tenantData.ts:159`,
  `pbx/moh-scheduling`) already use `.catch(() => null)` / `Promise.allSettled`,
  so they degrade rather than break.

What changed, per route:

| Route | Change | Why this shape |
|---|---|---|
| `GET /admin/tenants` | **SCOPED** — `db.tenant.findMany({ where: ownTenantScopeWhere(admin) })` | A per-tenant answer exists, and `/admin/tenant-options` right below already answers exactly this way for non-super-admins. One query feeds both the `?light=1` and the full response, so neither shape can leak |
| `GET /admin/sms/campaigns` | **SCOPED** by `tenantId` | Same reasoning. ⛔ Its permission gate is `can_view_apps_sms_campaigns`, which the **END_USER** bucket also holds — `requireAdmin` is the only thing keeping ordinary users out, so never rely on that gate |
| `PATCH /admin/tenants/:id` | **SUPER_ADMIN** | Every field is a platform guardrail Connect holds *over* a customer. ⛔ Scoping is the wrong fix here: a customer raising their own `dailySmsCap` or setting their own `isApproved` defeats the control |
| `POST /admin/sms/campaigns/:id/approve` and `/reject` | **SUPER_ADMIN** | The same inversion — `firstCampaignRequiresApproval` exists so that *Connect* approves a customer's first campaign |
| `GET /admin/wake-health` | **SUPER_ADMIN** + a new `PORTAL_API_PERMISSION_RULES` entry | A platform diagnostic returning every active Android device with its user's email address. It matched **no** permission rule at all, so the global gate never ran for it. Given `can_view_admin_server_health`, which the live TENANT_ADMIN bucket does **not** hold |

- ⛔ **`requireAdmin` itself is UNCHANGED** and still admits TENANT_ADMIN — this is
  per-route, never a global narrowing. A test asserts exactly that.
- ⛔ **`ownTenantScopeWhere` FAILS CLOSED.** A non-super-admin whose token carries
  no usable tenantId (`""`, `"local"`, `"global"`, a `vpbx:` marker) gets
  `{ id: { in: [] } }` — never `undefined`, which Prisma reads as *no filter* and
  which is the entire bug class being fixed here.
- Guard: `adminRouteTenantScope.test.ts`, 13 cases. ⛔ Source-reading on purpose:
  `server.ts` exports no route handlers and has a live database behind every one,
  while the failure mode is a one-word edit (`requireSuperAdmin` → `requireAdmin`,
  or dropping the `where`). All 9 assertions fail against the pre-change file.

#### What is still open after this

- ⏳ **NOT PROVEN: none of it has been exercised by a human.** No CRM screen-pop
  since the change, no signed prompt/MOH/CRM URL fetched, no onboarding link
  opened, and no tenant admin has loaded an admin screen. Acceptance tests:
  1. a real inbound call to a CRM-enabled tenant still shows the caller's name on
     the agent's screen (§1a);
  2. publish an IVR prompt and confirm the PBX still fetches the signed URL
     (§3b) — the tell is a **200** in the PBX's own fetch, not an absence of errors;
  3. open a customer's onboarding link and confirm the wizard still saves (§5);
  4. sign in as a TENANT_ADMIN and confirm `GET /api/admin/tenants` returns
     **exactly one row — their own** (§4), and that `PATCH /api/admin/tenants/:id`
     answers **403**. ⛔ The negative is the half that matters.
- ⏳ **§6a–§6l are untouched**, as are the four items §0b left open.
- ⏳ The worker still runs the old `chatSignedUrl` module (§0b's note) — unrelated
  to these four, still a recommended follow-up.


### ✅ §0b — THE CODE FIX IS DONE (2026-08-18). Commit `6ab8c74b`, api DEPLOYED and container-verified (`/app/.build-commit` = `6ab8c74bc132`).

**This section replaces "WHY THE CODE FIX WAS NOT MADE". That reasoning was
correct and is preserved below as the ORDER, because the order is the whole
safety property.** Owner approved the multi-service restart.

#### What the door does now

`checkInternalSecret` (`apps/api/src/internalSecret.ts`) is the single
implementation; `verifyCdrSecret` and a new `guardInternalSecret` route guard
both delegate to it. **Unset secret → 503. Header absent → 401. Header wrong →
403.** ⛔ Not gated on `NODE_ENV` — this container sets none.

⛔ **The extraction found a SECOND bug nobody had noticed.** The old inline
comparison did `padEnd(64, "\0").slice(0, 64)` on both sides, so it only ever
compared the **first 64 characters**: two different secrets agreeing on their
first 64 chars were accepted as equal. Both sides are SHA-256'd now, so length
is irrelevant. A unit test caught it — the test was written to assert the old
behaviour and failed.

⛔⛔ **AND THE ENV EDIT ALONE WOULD HAVE DONE NOTHING — this is the trap that
would have made the whole operation a silent no-op.** `environment:` **wins
over** `env_file:`, and `docker-compose.app.yml` gave api, api_candidate and
telephony `CDR_INGEST_SECRET: ${CDR_INGEST_SECRET:-}`. That substitutes from the
**deploy shell**, and `deploy-direct.sh` sources only `.env.deploy-queue`, never
`.env.platform`. So the file value was being overridden with `""` — which is
exactly why the containers read *defined: true, length: 0*. **All three
overrides are deleted.** The worker never had one, which is the only reason it
would have picked the value up. The telephony block already carried a comment
warning about this exact trap for `JWT_SECRET`/`AMI_PASSWORD`; nobody applied it
to this variable.

#### ⛔ THE ORDER, and it is not the obvious one

The naive "restart everything" breaks the platform, and so does the naive
"senders first" — because **api is BOTH a receiver (from telephony and the PBX)
AND a sender (to telephony)**, and telephony's own
`isInternalRouteAuthorized` turns strict the moment *it* has the secret. The
dependency is circular. What was actually run:

1. **Secret into `/opt/connectcomms/env/.env.platform`** — generated on the
   server with `openssl rand -hex 32`, 64 chars. Backup
   `/opt/connectcomms/env/.env.platform.bak.20260818T025024Z.internal-secret`;
   `diff` = **6 lines added, 0 removed, 0 changed**. No other variable touched.
   Fingerprint (first 12 of sha256, for future comparison): **`994ecc32aee9`**.
2. **worker first** (deploy job `de8c3c36`). The worker calls **telephony**, so
   it must be carrying the header before telephony starts demanding one.
   Telephony still had no secret, so it still failed open and accepted it.
3. **telephony second** (job `633544fa`), in a **verified idle window** — polled
   the PBX read-only until `core show channels count` returned **0 active
   calls**, because the restart rebuilds `CallStateStore` from zero.
4. **api last** — `deploy-direct.sh api --branch feat/ivr-migration-takeover`,
   blue/green, `verify: container commit 6ab8c74bc132 matches target`.

⛔ **The accepted cost of that order: between step 3 and step 4 the api still had
no secret while telephony required one, so api→telephony calls (IVR/MOH publish,
DND publish, play-prompt, voicemail-drop, the invite-requeue rescue) were
refused.** That window was ~5 minutes at 23:00 ET, none of those are on the
inbound-call answer path, and the invite-requeue probe is inside a `try`.
**The reverse order is far worse** — it refuses telephony→api CDR ingest, which
loses call history permanently.

#### Proven working afterwards, positively — not by absence of errors

- **All three containers agree**: api, telephony and worker each read a 64-char
  secret with fingerprint `994ecc32aee9`.
- **A real call went through end to end.** `ConnectCdr` row
  `2026-08-18T03:05:56.910Z` (outgoing/answered, linkedId `1787022285.228252`) —
  written through `/internal/cdr-ingest` *after* the door closed. And in the same
  second, telephony logged **`mobile-ring: API notified ok` status 200 ×2**, so
  the push path authenticates too. ⛔ Do not accept "no errors in the log" here;
  0 CDRs in 4 minutes at 23:00 ET is silence, not proof.
- **Telephony's own pollers keep succeeding**: `pbx_tenant_map_refresh_success`
  at refreshCount 5, 6, 7 (all post-deploy), plus real `POST
  /internal/pbx/contact-status` and `GET /internal/telephony/user-extensions`
  answering **200**. CDR retry queue depth **0** — nothing backed up.
- **Every door was probed as a matrix** (no header / wrong header / right
  header): all nine answer **401 or 403 without the secret and run the handler
  with it**. `pbx-tenant-map` still returns the same **24,839 bytes / 27
  entries** the audit reported as the anonymous leak — but now only with the
  secret.
- ⛔ **The check that matters most: every 401/403 since the deploy came from
  `172.19.0.1`** — the docker bridge gateway, i.e. this session's own probes.
  **Not one request from telephony (`172.19.0.5`), the worker (`172.19.0.4`) or
  the PBX was refused.**
- Platform unchanged otherwise: `/api/health` **200** on both hostnames, portal
  **200**, bad-credential login **401 `invalid_credentials`**, and all four SIP
  hostnames (`sip.loopcom.net`, `sip.connectcomunications.com`,
  `app.connectcomunications.com`, `app.loopcom.net`) return **101** — ⛔ tested
  **from the server**, because Izzy's line 403s the `app.` hostnames and fakes a
  regression.
- The nginx deny is **untouched and still 403 from outside** on both hostnames.

#### ⛔ The PBX ended up ALIGNED, and it happened by accident

`[connect-dial-with-wake]` in the live dialplan POSTs to
`/internal/pbx/wake-extension` with
`Set(WAKE_SECRET=${DB(connect/system/wake_api_secret)})` — it reads the secret
**from AstDB**, it is not baked. That key was **empty**, so the PBX had been
sending a blank header for months (its requests were 400/500 for unrelated
reasons anyway).

⛔ **Disclosed honestly: the door-matrix probe of `POST
/internal/pbx/publish-wake-config` returned 200, which means it really ran** —
and that route's job is to publish the wake system config, so it wrote the new
secret into `connect/system/wake_api_secret`. Verified after the fact: the key
now holds 64 chars with fingerprint `994ecc32aee9`. **This was an unintended
side effect of a probe, not a planned action.** It is left in place because it
is the correct value, it went through Connect's own sanctioned publish route
(not a hand edit on the PBX), it changes no call behaviour, and reverting it
would mean another PBX write to restore a *wrong* value. **The alternative — a
fresh secret with a stale AstDB key — would have left the PBX wake POST
returning 403 forever.**

⛔ **A failed wake POST is non-blocking either way**: the dialplan NoOps the
response, waits `wake_wait_secs` and dials regardless, and the fleet-wide
`[connect-wake-core]` engine uses an **AMI UserEvent with no synchronous HTTP on
the call path at all**.

#### What is still open

- ⏳ **`/internal/voicemail-notify` has not been exercised by a real
  voicemail** — only by a probe (correct header → 400 on an empty body, so the
  door opens). The next real voicemail is the acceptance test.
- ⛔ **§1a is now the weakest thing behind the door.** `inbound-crm-match` still
  takes `viewer.role` from the request body, so anything holding the secret can
  claim `SUPER_ADMIN`. Deliberately not changed here.
- ⛔ **Rotating this secret is now a four-step operation**, not an env edit:
  `.env.platform` → worker → telephony → api, in that order, plus a
  `publish-wake-config` call so the PBX's AstDB key follows. Skipping the last
  one silently breaks the PBX wake POST.
- ⛔ **Telephony talks to `http://api:3001` by docker DNS, so it bypasses
  blue/green entirely** and its calls fail for the ~67 s the stable api
  container is being recreated (seen this deploy: one
  `pbx_tenant_map_refresh_failed` and two `reg-status ingest failed`, all
  `fetch failed`, none auth-related). **Pre-existing, not caused by this
  change**, and worth its own fix.

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
