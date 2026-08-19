# Tests Run

Newest entries first.

---

## SignalWire test bench — the carrier being evaluated to replace VoIP.ms (2026-08-18, evening)

Branch `feat/ivr-migration-takeover`, commit `50f9fa69`. api + portal. Handoff
`AGENT_HANDOFF_SIGNALWIRE_PIVOT_2026-08-18.md`.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/signalwire/signalWire.test.ts
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/publicReadyJwtBypass.test.ts src/deployReadinessJwtBypass.test.ts src/adminRouteTenantScope.test.ts src/internalSecret.test.ts src/nodeEnvGates.test.ts src/dependencyHygiene.test.ts
cd apps/portal && npx tsx --test navigation/navAuthoritativeWiring.test.ts
```

**Result:** 18/18 new (glob `src/signalwire/*.test.ts` registered in `apps/api/package.json`);
neighbours 55/55; portal nav wiring 3/3. Pure: space-URL normalisation, credential shape
refusals, the Twilio reference signature vector (`0/KCTR6DLpKmkAf8muzZqo1nDgQ=`),
fail-closed webhook auth (no key / no header / tampered body / wrong-then-right URL),
public-URL rebuild from `X-Forwarded-*`. Fake-fetch client: per-family URLs, error
classification, search query + capability mapping, Compatibility SMS form body,
**purchase sends exactly one request on timeout**, SIP endpoint Fabric→legacy fallback only
on 404 (403 must not), connection check GET-only. Source guards: both webhook paths bypass
JWT and no admin path does; `server.ts` import + registration with `requireSuperAdmin` +
the `/admin/apps/signalwire` permission rule; every admin route opens with `requireOwner`;
the module never touches VoIP.ms/TenantSmsNumber/onboarding/integrations and never
`console.log`s; no audit call carries a password/token/signing key; nav item exists and is
SUPER_ADMIN-forced. **Non-vacuous:** server.ts / bypass / nav guards read 0 against `HEAD`.
Typecheck: api 75 (= baseline), portal 0. ⛔ Nothing exercised against a real SignalWire
account — no credentials exist yet.

**Trunk build, same evening (`8d3dfd04`):** 19/19 (new guard: the registrar comes from
`/sip_profile`, never `<space>.sip.signalwire.com` — reads 2 hits against the pre-fix routes).
Live proof on the PBX, not a test: `pjsip show registrations` → `loopcom-pbx … Registered`;
`pjsip set logger` captured SignalWire's `INVITE sip:s@…;line=…` and the PBX's `484 Address
Incomplete` before the `exten => s` handler existed; after it, `channel originate
PJSIP/+12053513327@loopcom-pbx` traced `s@trk-132-in → default-trunk → T102_incoming-calls
INBOUND_ROUTE: SignalWire 2053513327 → Dial(PJSIP/T102_101&…)` ringing ext 101; doorway
counts T2 1/0, T35 1/0, T105 2/0 unchanged across three applies (re-bake 0 lines each).

**Outbound route swap (later):** panel edit of route 123 (trklist 127→132) + apply + re-bake
(0 lines); `channel originate Local/2053513327@T102_cos-all` traced `Outbound Route: Loopcom
Demo → OUTBOUND_CID "Loopcom Demo" <3479780090> → trk-132 → Dial(PJSIP/2053513327@loopcom-pbx)`
→ hairpin → ext 101 ringing; far-end CID observed `+12053513327` (SignalWire `send_as`
substitution — 347-978-0090 is not on the account).

---

## Rate limiter armed for the first time, JWT fail-closed, §6h/§6j/§6l, login oracle, SSH keys-only, both-host parity (2026-08-19, early)

Branch `feat/ivr-migration-takeover`, `eeec0002`. api only + live nginx/sshd/env
changes on loopcom. Handoffs: tenant audit §0e, security audit §10.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/globalRateLimit.test.ts src/securityHardeningRound2.test.ts
```

**Result:** 28/28. `globalRateLimit.test.ts` (11): a REAL Fastify app whose routes
are declared BEFORE `app.register(rateLimit)` — server.ts's shape — gets 200,200,200,
429,429 with `x-ratelimit-limit: 3` under the new wiring; the OLD registration shape
(`global:true`, routes first) is shown NOT limiting and carrying no header; buckets
are per last-XFF entry (a spoofed first entry does not mint a bucket); header-less
callers and `/internal/*` exempt; 429 body + `Retry-After`; pure key/max/exempt rules;
ceiling ≥ 400; source guards on the `global:false` registration + `after()` hook and
the JWT boot guard / no `"change-me"`. `securityHardeningRound2.test.ts` (17): pay-multi
bypass ×4 shapes + still-gated sibling; `/chat/a/` anchored (substring routes stay
gated); ownership rules (id-shaped fields, super-only resources, list failure =
refusal, foreign = 404); BOTH write routes call `decideVitalWriteForCaller`;
remote-support `findFirst` scoped; scan + session scoping; campaign assignee on add AND
patch; schedule profile scope; announcement promptRef + server.ts wiring; MOH scope;
constant-time compares; `requireCrmAdmin` effective tenant; bcrypt precedes the
DISABLED check; ZodError → 400 with path/code/message only.

### Proven non-vacuous

Pre-change blobs (`git show HEAD:…`) into a scratch tree, tests re-pointed. **16 of 16
source/behaviour guards FAIL on `HEAD`** (14/17 in round2 — the 3 passing are pure
unit tests of the new module + a still-gated-route check that must pass on both; 2/11
in the rate-limit file — the 9 passing exercise the new module directly). ⛔ Three
guards first FAILED on the FIXED tree: they matched the old code quoted in my own doc
comments. Comments stripped before negative matches; `assert.ok(re.test())` instead of
`assert.match` on the 1.8 MB file.

### Full suite + typecheck

**2544 tests, 2510 pass, 31 fail, 3 skipped.** 7 = the documented
`syncPbxTenantDirectoryFromRows`; **24 = `setupOrchestrator.test.ts`, introduced by
another session's `c2d9fdd9`** (its `@connect/integrations` mock lacks
`resolvePbxRouteHelperConfig`) — pre-existing at HEAD, not from this change. Typecheck
**75 = baseline, identical error set** (compared with line numbers stripped).

### Live (measured, both hostnames)

Before: peak 357 req/min, 0 global 429s, no `x-ratelimit-*` header on any route
(`/health`, `/me`, `/admin/tenants`, `/voice/me/extension` all probed); legit per-IP
peak 167/min over 4 days. After deploy: boot log `GLOBAL_RATE_LIMIT_ARMED
maxPerMinute=480`; `x-ratelimit-limit: 480` on `app.connectcomunications.com` and
`app.loopcom.net`; `127.0.0.1:3001/health` carries none (exempt); bad login 401;
`pay-multi/PROBE` → **410 invoice_token_invalid** (handler reached; was the hook's 401);
telephony `pbx_tenant_map_refresh_success` ×4 after cutover; 0 api error lines.
SSH: `sshd -T` → `permitrootlogin without-password`, `passwordauthentication no`; fresh
key login OK; password attempt → `Permission denied (publickey)`. nginx: `Server: nginx`
(no version) both hosts; HSTS `max-age=86400` on `/login` and `/api/health` both hosts;
`/brand/` immutable header now on both. Env: `.env.platform` + 24 backups `600`.
Parity: vhost diff empty after hostname normalisation; 11 path classes, 5 headers +
HSTS + cache rule, TLS matrix, certs — identical.

---

## Tenant-isolation §6a–§6g scoping fixes (2026-08-18, night)

Branch `feat/ivr-migration-takeover`. api only. Handoff
`AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0d.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/tenantScopeHardening.test.ts
```

**Result:** 17/17. Five pure-function cases on the new `smsNumberAdminScope`
(unassigned row not modifiable; own tenant only; SUPER_ADMIN keeps the platform
inventory; a falsy actor tenant is refused rather than matched against null).
Twelve SOURCE guards, all CRLF-normalised: routing-preview consults
`canReadSmsNumberRow` and answers `found:false`; the numbers PATCH no longer
carries `row.tenantId && row.tenantId !== effTenant`; role assignment selects
`permissions` and calls `ungrantablePermissionsFor`; role DUPLICATE does too;
the "additive only" header sentence is gone; the recording block has an `else`
that 403s; the voicemail-drop stream calls `requireCrmAccess` and scopes by
`tenantId: user.tenantId` while keeping the signature check; no route in that
file fetches a drop by bare id; retry-payment uses `tenantId: invoice.tenantId`
+ `active: true` and no longer `findUnique({ id: methodId })`; `createDriver`
validates user and stores; the route maps `DeliveryValidationError` → 400;
`driverNameMap` filters users by tenant.

### Proven non-vacuous

The pre-change blobs were materialised with `git show HEAD:apps/api/src/<f>` into
a scratch tree and the same test re-pointed at it. **12 of 12 source guards
FAIL against `HEAD`**; the 5 unit tests pass there (they import the new module
directly, as intended). ⛔ The first version of the §6e bare-id assertion PASSED
on `HEAD` — it was written `{ where: { id } }` while the real line reads
`{ where: { id }, select: …`, so it guarded nothing. Fixed and re-proven. **Only
the replay could have caught that.**

### Full suite + typecheck

```bash
cd apps/api && npm test
cd apps/api && npx tsc --noEmit
```

**Result:** **2492 tests, 2482 pass, 7 fail, 3 skipped** — all 7 failures are the
documented pre-existing `syncPbxTenantDirectoryFromRows` ones. Typecheck **75
errors = the exact baseline**; the one error in an edited file
(`delivery/dispatchService.ts:144`, an unrelated `provider: "delivery"` enum
complaint) is byte-identical to `HEAD` and sits 134 lines above the first hunk.

### Deploy (2026-08-18, container-verified)

Rode another session's api deploy — container `.build-commit` **`058002d0`**, with
`git merge-base --is-ancestor d19c9c00 058002d0` confirming this work is inside it.
⛔ A separate `deploy-direct.sh api` run printed **`success`** while logging
**`skip=unrelated_paths`** ("commit changed 058002d0..5873dd6c but no api-relevant
paths changed") — correct, since the clone was already built at 058002d0 and the
newer commit was docs-only. **Never read the exit line as proof.** Verified in the
container: `canReadSmsNumberRow` 2, `canModifySmsNumberRow` 2, old short-circuit
**0**, `ungrantablePermissionsFor` 3, "additive only" **0**, unattributed-CDR
else-branch 1, voicemail-drop DUAL GATE 1, retry-payment tenant scope 2,
`driver_user_not_in_tenant` 1. Health 200 × 2 hostnames, portal 200, bad login
401 `invalid_credentials`, 0 restarts, no level:50/60 lines in 20 min.

### Live sizing (read-only, `app-api-1`)

Role census **9 TENANT_ADMIN / 1 SUPER_ADMIN / 75 USER / 1 EXTENSION_USER /
0 ADMIN** — which is what proves §6a and §6b were latent, not live. Spare
`TenantSmsNumber` rows **57**. CDRs **126,052 total, 4,316 unattributed, 6 of
those still advertising a recording**.

---

## Voicemail/email guardrails + self-healing (2026-08-18, evening)

Branch `feat/ivr-migration-takeover`, `9ae26e04`. api only. Handoff
`AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18.md` §7.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/voicemail/voicemailEmailGuardrails.test.ts src/voicemail/voicemailEmailRuntime.test.ts
```

**Result:** 21/21 (15 new + 6 runtime). Thresholds pinned: heartbeat staleness
(fresh process not judged; very-old heartbeat still counts; mature + none = dead;
sweep 10 min, watchdog 45 min), recipient-coverage drop (55→0 yes, 55→53 no, 10→7 yes,
100→97 no), preserve value→blank (lowercased) vs change, outbox stall/failure, requeue
cap/age/proof-of-recovery. Fake-db runners: escalation de-dupe, third-failure escalation
+ reset, preserve writes the recipient row, outbox queries all carry
`type: {not: ADMIN_ALERT}`, requeue capped at 2, liveness mature vs fresh. SOURCE guards
(CRLF-normalised): runtime records both heartbeats + escalates in its catch; watchdog
processes stranded + re-queues; sync calls `preserveBlankedPbxEmail` BEFORE the upsert;
server.ts calls `startEmailGuardrails`. Runtime: the 2-day-old never_processed voicemail
is now RESCUED (job queued, stamped, not a gap); an empty sweep still heartbeats.

### Voicemail + extension-sync suites

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/voicemail/*.test.ts" src/pbxExtensionSync.backfillReconcile.test.ts src/pbxExtensionSync.webrtcLiveDetection.test.ts
```

**Result:** 87/87. apps/api typecheck **75 = baseline**, 0 in `src/voicemail/`.

### Live (acceptance)

Container `9ae26e04`; within 5 min of boot: sweep heartbeats once a minute, the first
`recipient_coverage` row (55 of 103 covered, no drop), zero escalations, 12 voicemail
emails SENT since 17:30Z. No guardrail has fired for real yet.

---

## Voicemail email: sweep unblocked, watchdog runs, recipients restored (2026-08-18)

Branch `feat/ivr-migration-takeover`, `6961ea9e` + `47c3ff45`. api only. Full record:
`AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18.md` §6.

### New suite

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/voicemail/voicemailEmailRuntime.test.ts
```

**Result:** 5/5. A faked `@connect/db` that behaves like Prisma (throws on an unknown
`select` key), 60 old excluded-tenant rows + 1 unresolved + 1 customer row → the customer
row is queued and stamped, the excluded ones never stamped, `where.tenantId` is
`{not: null, notIn: [...]}`; the watchdog completes, selects no `tenant` relation, looks
names up in one `tenant.findMany`, and reports the two-day-old gap by tenant name. Two
SOURCE guards (CRLF-normalised) on the sweep's `where:` and the watchdog's `select`.

### Proven non-vacuous

Replayed against the pre-change runtime (`git show HEAD:…voicemailEmailRuntime.ts` copied
over the module, restored after): **5 of 5 fail.**

### Whole voicemail suite

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/voicemail/*.test.ts"
```

**Result:** 61/61 (includes the two watchdog-grace cases in `voicemailEmailSender.test.ts`:
an unprocessed voicemail older than `NEVER_PROCESSED_GRACE_MS` is `never_processed`; one 30 s
old is not a gap; one with no `receivedAt` still is).

### apps/api typecheck

76 errors — 75 baseline + 1 in `server.ts` from another session's uncommitted MFA work;
**0 in `src/voicemail/`.**

### Live (not a test, but the acceptance)

Container `0b28b348` (⊇ `6961ea9e`). First sweep 17:38:38Z: 5 queued → 5 SENT in 15 s.
After clearing 9 post-cutover `no_recipient` stamps: 4 more SENT, 5 re-stamped (mailboxes
with no address on the PBX either). **9 SENT / 0 failed** since 17:30Z.

---

## Login: a malformed body is 401 invalid_credentials, never 500 (2026-08-18)

Branch `feat/ivr-migration-takeover`. api only. New `apps/api/src/loginRequest.ts` +
`loginRequest.test.ts`; `server.ts` `/auth/login` now goes through `parseLoginRequest`.
Security audit doc §1b has the reasoning (401 not 400; not counted by the throttle).

### New suite + the throttle suite

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/loginRequest.test.ts src/loginThrottle.test.ts
```

**Result:** 31/31 (11 new + 20 throttle). Covers 23 garbage bodies (never throws, all
refused, incl. the live repro `password:"x"`), the boundary at 8 chars, extra fields
tolerated, per-field log reasons, no NODE_ENV — and four source guards on the handler
(CRLF-normalised, comment lines stripped): no throwing `.parse(req.body)`,
`parseLoginRequest` used, guard answers `status(401)` + `invalid_credentials` (no 400/500),
guard sits before `evaluateLoginAttempt` and never calls `recordLoginFailure`, metric label
`malformed`.

### Source guards proven non-vacuous

Replayed against the pre-change `server.ts` (`git show HEAD:apps/api/src/server.ts` into a
scratch mirror beside the module, mirror deleted after): **4 of the 4 handler guards fail**,
7 parser tests pass — as they should.

### Portal contract guard on the api's 401 body

```bash
cd apps/portal && npx tsx --test lib/sessionExpiry.test.ts   # 23/23
```

### API typecheck

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit | grep -c "error TS"   # 75 before, 75 after
```

Pre-existing errors only (shared-module resolution, Timeout typing, billing/onboarding);
none in `loginRequest*.ts` or the login handler.

### API full suite

```bash
cd apps/api && npm test
```

**Result:** 2398 tests, 2387 pass, 8 fail — the 7 pre-existing
`syncPbxTenantDirectoryFromRows` failures plus the known
`voice/elevenLabsRoutes.stress.test.ts` "10-wide concurrent burst" load flake. Baseline
unchanged (2369 → 2398 = the 11 new tests + others landed since the last recorded run).

### Deploy — api DEPLOYED and container-verified (2026-08-18)

Pre-checks on loopcom: no stale `enqueue`/`commitHash` waiters, queue idle, container at
`5e73ddd4`, `git diff --name-only 5e73ddd4..tip -- packages/db/prisma/` empty (no surprise
migration), api-relevant diff = the three files of this fix only. Enqueued
`{"service":"api","branch":"feat/ivr-migration-takeover"}` → job `4bcde036` → `success`
(~11 min: long build, then blue/green restart). Log: `verify: container commit e9a79c57b221
matches target`; `docker exec app-api-1 cat /app/.build-commit` = `e9a79c57…`;
`parseLoginRequest` present in the container's `server.ts`, `loginRequest.ts` present;
`app-api-1 Up (healthy)`.

### Live proof over public HTTPS (4 requests, well under the nginx 401 ban counter)

```
{"email":"x@y.com","password":"x"}                       → 401 {"error":"invalid_credentials"}   (was 500 this morning)
{"email":"probe-nobody-2026@example.invalid","password":"definitely-wrong-password"}
                                                          → 401 {"error":"invalid_credentials"}   (control, unchanged)
{}                                                        → 401 {"error":"invalid_credentials"}
this is not json                                          → 400 {"error":"Unexpected token…"}     (Fastify's JSON parser, before the handler — pre-existing, not a 500)
```

`docker logs --since 5m app-api-1 | grep -c request_failed` → **0** during the probes.

---

## Portal survives a 401 — global dead-session handler + pollers stop (2026-08-18)

Branch `feat/ivr-migration-takeover`, commits `93fb96d1` + `f183ee3d`. Portal only;
**portal DEPLOYED and container-verified** (`/app/.build-commit` = `f183ee3d`).

### New suite

```bash
cd apps/portal && npx tsx --test lib/sessionExpiry.test.ts
```

**Result:** 23/23. Classifier matrix (401 unauthorized+token = dead; 403 forbidden,
`invalid_credentials`, `bad_signature`, no-token, non-JSON = not), once-per-token
idempotence (20 calls → 1 clear, 1 redirect), public paths and desktop passive windows
never redirected, the local short-circuit (dead/empty token refused on authenticated paths,
never on public paths, re-armed by a fresh token), source guards on every call site, and
an api-contract guard that reads `apps/api/src/server.ts`.

### Source guards proven non-vacuous

Replayed against the pre-change files from `HEAD` in a scratch mirror (`git show HEAD:…`):
**4 of the 4 call-site guards fail** (apiClient wiring, AuthGate listener, telephony WS
1008 handling, the poller gates); the api-contract guard passes on both, as it should.

### Portal suite + typecheck

```bash
cd apps/portal && npm test          # 158 tests, 156 pass, 2 fail — the pre-existing
                                    # webrtcSdpDiagnostics + campaignsIndexLayout failures
cd apps/portal && npx tsc -p tsconfig.json --noEmit    # 0 errors
```

### Live browser check on the deployed build (no sign-in, no real credentials)

`https://app.connectcomunications.com/login`: form renders, only `/version → 200`, **zero
`/api/*` requests** (the one stray `/api/me/outbound-routes → 401` from before `f183ee3d` is
gone), no CSP/CORS console messages. `/p/PROBE000`: URL unchanged (no redirect), page reads
"This payment link is invalid or no longer available", `404 / 404` on the two pay-link
calls, no CSP/CORS messages. `/api/health` 200 on both hostnames.

### Not run, honestly

The dead-session path end to end (a real session whose token the api then refuses) — nothing
expires today and no real credentials were used. Human recipe in the security audit §8.7.

---

## Source-reading tests normalise CRLF — Windows-only failure closed (2026-08-18)

Branch `feat/ivr-migration-takeover`. Test-only + docs; no production code touched.

### The failure reproduced, then proven gone (CRLF mirror in scratch, real tree untouched)

```bash
# scratch mirror: server.ts et al. re-encoded to CRLF, tests copied alongside
node --import tsx --test src/orig.callsites.test.ts       # ORIGINAL test → ✖ actual: 'fu'
node --import tsx --test src/userDisplayName.callsites.test.ts src/supportReport.test.ts   # fixed → 17/17
node --import tsx --test lib/voicemailPreloadBound.test.ts  # portal, fixed → 6/6
```

**Result:** original test fails on CRLF exactly as reported (`actual: 'fu'`); the three
fixed tests pass on the CRLF mirror and on the real (LF) checkout.

### API full suite

```bash
cd apps/api && npm test
```

**Result (run twice):** 2369 tests, 2358 pass, 8 fail — the 7 pre-existing
`syncPbxTenantDirectoryFromRows` failures, plus `voice/elevenLabsRoutes.stress.test.ts`
"a 10-wide concurrent burst" (`expected 1-4 successes, got 10`). The latter is untouched,
passes 3/3 in isolation, and only fails under full-suite CPU load (the burst serialises);
recorded as a load flake, not a regression. Expected steady baseline is therefore **7**.

---

## CRM page rollout and backend support (2026-06-06)

### Portal typecheck

```bash
pnpm --filter @connect/portal typecheck
```

**Result:** passed after `ChecklistWorkspace` stale `viewMode` prop type was removed.

### Focused CRM/API tests

```bash
node --experimental-test-module-mocks --import tsx --test \
  "apps/api/src/crmFormService.test.ts" \
  "apps/api/src/crm/bulkEmail.test.ts" \
  "apps/api/src/crm/crmPermissionAudit.test.ts" \
  "apps/api/src/smsSharedInbox.test.ts"
```

**Result:** 37/37 passed.

### API full suite

```bash
pnpm --filter @connect/api test
```

**Result:** failed with two remaining `cdrDirection.test.ts` assertions:

- `7-digit 'to': ambiguous local PSTN, not counted as external -> keep stored`
- `9-digit 'to': not in external range -> keep stored`

The earlier `smsSharedInbox.test.ts` failure was fixed by adding a `crmTenantSettings`
mock for the CRM SMS decoration lookup.

### API typecheck

```bash
pnpm --filter @connect/api typecheck
```

**Result:** failed on pre-existing WebRTC/shared module-resolution issues and related
implicit-any test parameters outside the CRM rollout files.

---

# Tests run — VoIP.ms sms_toolong fix (2026-06-02)

## Shared SMS text unit tests

```bash
cd packages/shared
pnpm exec tsx --test src/smsText.test.ts
```

**Result:** 13/13 passed

```
✔ plain visible GSM text under 160 chars passes VoIP.ms validation
✔ 159 GSM chars passes single VoIP.ms sendSMS payload
✔ exactly 160 GSM chars passes single VoIP.ms sendSMS payload
✔ 161 GSM chars splits into two VoIP.ms API payloads but remains sendable
✔ 140 visible chars with 95 pipe symbols splits due to GSM septets, not blocked
✔ smart apostrophes normalize to GSM so short text stays one VoIP.ms part
✔ hidden characters are stripped and do not falsely block normal short text
✔ over VoIP.ms total cap blocks with precise error
✔ line breaks count as one GSM septet each after normalization
✔ counter shows encoding, bytes, and VoIP.ms part count
✔ Connect Chat does not append STOP or campaign footer during normalization
✔ 161-char payload fails single-part VoIP.ms validation with useful detail
✔ emojis remain Unicode and show byte/char counts honestly
```

## Portal typecheck

```bash
cd apps/portal
pnpm typecheck
```

**Result:** passed

## Workspace install (integrations → shared)

```bash
pnpm install --filter @connect/integrations...
```

**Result:** passed

## Not run

- Full `apps/api` typecheck — pre-existing unrelated errors in billing/onboarding/crm files
- Production deploy — not requested in this task

---

# 2026-08-18 — onboarding: empty number search, required sign-up details, duplicate tenant names

Commit `7ab03778` on `feat/ivr-migration-takeover`. api deployed inside
`0b28b348`; portal deployed inside `441efd24`.

## New tests

```bash
cd apps/portal && npx tsx --test lib/numberSearchMessage.test.ts
```

**Result:** 15 pass / 0 fail

```bash
cd apps/api && npx tsx --test src/onboarding/requiredSignupDetails.test.ts
```

**Result:** 17 pass / 0 fail

## Non-vacuity replay (the guards fail against the pre-change files)

Portal guards replayed against `git show HEAD:` copies of the wizard,
`publicRoutes.ts` and `packages/integrations/src/index.ts`:

**Result:** 10 pass / **5 fail** — every source guard fails, as required
(renders the empty message; keeps found-nothing apart from search-broke; retry
copy not re-inlined; api reports a failed search; `unavailable_info` treated as
empty).

API guards replayed against the pre-change blobs:

**Result:** all 4 fail — submit route runs the gate; both tenant-creation paths
number a duplicate; e911 rejects a bogus parsed state.

`buildE911Address` before vs after, same input `30 Robert Pitt Dr` with a blank
`addressState`:

```
BEFORE: ok=true   state="DR"  street="30 Robert Pitt"
AFTER : ok=false  state=""    street="30 Robert Pitt Dr"
```

## Suites

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/onboarding/*.test.ts
```

**Result:** 280 pass / 0 fail

⛔ Without `--experimental-test-module-mocks` five files die with
`mock.module is not a function` and read as a mass regression.

```bash
cd apps/portal && npm test
```

**Result:** 171 pass / 2 fail — both pre-existing and unrelated
(`campaignsIndexLayout`, `webrtcSdpDiagnostics`).

## Typechecks

```bash
cd apps/portal && npx tsc --noEmit
```

**Result:** 0 errors

```bash
cd apps/api && npx tsc --noEmit
```

**Result:** 76 errors total, **0 in any file this change touched**.

## Live provider probe (read-only)

`searchDIDsUSA` against the real VoIP.ms account from inside `app-api-1` — no
purchase, no write. 305 / 212 / 786 / 555 / 999 / 311 answer `unavailable_info`
with 0 rows; 845 answers `success` with 5000 rows in the same minute.

## Post-deploy container verification

- api `0b28b348`: `requiredSignupDetails.ts` and `uniqueTenantName.ts` present;
  `requiredSignupDetailsProblem` ×2 in `publicRoutes.ts`; `isUsStateCode` ×3 in
  `e911Address.ts`; `uniqueTenantName` in **both** creation paths;
  `unavailable_info` ×2 in the integrations bundle; `number_search_failed` ×2.
- portal `441efd24`: the onboarding page chunk carries "is not available right
  now", "Area code " (×6) and `ob-num-empty` (×3).

## Not run

- **Nobody has opened the sign-up wizard in a browser since the deploy.** The
  empty-state message is proven by unit test and by grepping the shipped bundle,
  not by a human seeing it.
- No sign-up has been submitted, so the required-details refusal has never been
  shown to a person.
- No duplicate-named tenant has been created since the deploy.
