# Tests Run

Newest entries first.

---

## Tenant-leak re-sweep: 8 defects closed, none live (2026-08-20)

Branch `feat/ivr-migration-takeover`, `d889407c` + `50053cf9`, deployed and
container-verified at `cbf1c672`. Handoff
`AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0f.

```bash
node --experimental-test-module-mocks --import tsx --test apps/api/src/tenantLeakSweep.test.ts
node --experimental-test-module-mocks --import tsx --test apps/api/src/pbxConsole/pbxConsole.test.ts
cd apps/portal && npx tsx --test navigation/consoleNavGuard.test.ts
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/*.test.ts"
cd apps/api && npx tsc --noEmit -p tsconfig.json   # and portal
```

**Results:** leak-sweep guards **9/9** (all 7 source assertions replayed
against `HEAD` — **all seven fail there**); console suite **24/24** with the
requireOwner check upgraded from a count to per-route (**mutation-tested**:
deleting one route's gate makes it fail); console nav guards **6/6** (fail on
HEAD for all three items); portal suite **225 tests, 223 pass, 2 fail** — the
documented pre-existing `campaignsIndexLayout` + `webrtcSdpDiagnostics` pair.
Full api `src/*.test.ts`: **1084 tests, 1074 pass, 7 fail** — the documented
pre-existing `pbxTenantDirectorySync` set, name for name. api typecheck **75 =
the exact baseline**; portal **0**.

**Proven on production, not inferred.** A real customer admin's validly-signed
token (their own sub/tenantId, signed with the live JWT_SECRET) was fired at
all 14 console doors and every suspect route: **every one 403**. Re-run after
the fixes alongside a SUPER_ADMIN probe: **customers refused everywhere, owner
200 everywhere** — the tightening locked nobody out. Containers verified by
ancestry AND by grepping the fixes inside the running api; health 200 on both
hostnames; the only error-level log line is the standing 24-hour
`cdr_unattributed_calls_present` monitor.

⛔ One process note: the guards read RAW source because comment-stripping
`server.ts` opens a fake block comment at a regex literal and swallows the
region — it cost one red test here before the rule was re-learned (4th
recorded instance).

---

## PBX Console: Trunks & Routing module + the onboarding batch apply (2026-08-20)

Branch `feat/ivr-migration-takeover`, `004c3e6c`. Handoff
`AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §22.

```bash
node --experimental-test-module-mocks --import tsx --test apps/api/src/pbxConsole/pbxConsole.test.ts
node --experimental-test-module-mocks --import tsx --test apps/api/src/onboarding/pbxTenantBuild.test.ts
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/onboarding/*.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/portal && npx tsc --noEmit -p tsconfig.json
```

**Results:** console **19/19** (6 new routing guards — routes + requireOwner,
one-implementation-per-write, reference-guarded deletes ordered BEFORE
panelDelete, setMembersEnabled reuse, the deliberate ABSENCE of a trunk edit,
editOutboundRoute's refusals; **all replayed failing against `HEAD`**).
pbxTenantBuild **40/40** — the full-build apply contract re-pinned tighter: no
apply between extension imports, ONE batch apply before the inbound route,
total 6 (was 8 with 3 people; N+4 generally). Onboarding **287 tests, 263
pass, 24 fail — the 24 are the documented pre-existing `setupOrchestrator`
set** (same names, same count as the §18 baseline run). api typecheck **75 =
the exact baseline**; portal **0**.

One pre-existing guard updated, not weakened: the "one slug rule" test matched
the byte-exact import line, which widened when createTrunk et al. joined it —
it now asserts slugify comes from pbxTenantBuild whatever else the line carries.

---

## SMS↔email bridge Part 3 (reply-to-text-back) — 31 new tests, agent suite green (2026-08-20)

Branch `feat/ivr-migration-takeover`, commit `d0d4f861`. Handoff
`AGENT_HANDOFF_SMS_EMAIL_BRIDGE_2026-08-20.md`.

- `apps/agent` new: `src/notify/smsEmailReply.test.ts` (18 — mint/verify
  round-trip incl. a pin that the shared mint is byte-identical to the
  forward job's historical inline format; tampered sig/domain refused;
  auto-reply detection; quote stripping for Gmail/Outlook/signatures/RTL;
  4 wiring source guards, **all replayed against HEAD and failing there**)
  and `src/notify/smsEmailReplyJob.test.ts` (13 — happy path proves the POST
  goes to the real chat route with a real HS256 JWT for the replying user;
  stranger/foreign-tenant silence; toggle-off/non-participant threaded
  notices; forged-signature + auto-reply + empty-body refusals; claim-ledger
  dedupe; api-refusal and api-unreachable notices with no auto-retry).
- Runner: `node --experimental-test-module-mocks --import tsx --test` (the
  agent's globbed `pnpm test` picks both up — no registration needed).
- Full agent suite: **697 tests, 695 pass, 2 fail — the same 2 pre-existing
  transcription/archive failures** (`export manifest yields (audio,text)
  pairs`, `normalizeLanguage`). Zero regressions.
- Typecheck: agent at its exact **14-error pre-existing baseline** (7 DOM-lib
  `setInterval().unref()` + 7 packages/db moduleResolution), **none in an
  edited file** — the two new intervals use a cast so they add nothing.
- Found by the tests before it shipped: the attribution-join in
  `extractSmsReplyText` originally joined across blank lines, so a reply
  whose own words START with "On " ("On my way now.") was cut to nothing and
  refused as empty. Fixed to join only consecutive non-empty lines.

---

## First live geo firewall build — LOCKED OUT THE PBX; recovered; channel disarmed (2026-08-19 evening)

Branch `feat/ivr-migration-takeover`. Handoff
`AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §17a (full
incident). Live on prod, not a unit suite.

**Setup that passed before the run:** quiet window measured (calls polled
13:49→17:26 until 0, twice-confirmed); baselines recorded (`direct.xml` mtime
2026-04-29 = truly first run, 258 direct rules, 232 blocked in DB,
`buildChannel: "unit"` through the deployed api); manual `direct.xml` backup
taken on top of the runner's automatic one. §17's acceptance premise
(`blocked='no'` country WITH an ipset) does not exist on prod — only CA/IL/US
are unblocked — so the test inverted to unblock→re-block Tuvalu.

**The run:** `POST /admin/pbx-console/geo {"unblock":["tv"]}` →
`result.json` code 0 in 19 s → **total lockout of every NEW connection,
whitelist included** (ping/SSH/MySQL dead from loopcom AND workstation).
Root cause: VitalPBX's `build_geo_firewall` deleted
`ipsets/blacklist_tv.xml` without rewriting `direct.xml` (mtime never
changed); the reload failed on `Set blacklist_tv doesn't exist`; a failed
reload/boot drops all NEW traffic ("full stock configuration" after reboot =
ssh only).

**Measured during the outage:** VoIP.ms CDR 17:26:55→18:06 = **25 inbound
calls, 25 ANSWERED, 0 failed** — established conntrack flows (desk-phone
keepalives, trunk pairs) carried calls through the lockout; only NEW
connections (mobile wakes, re-registrations, management) were dead.
All-phones-dead stretch was 17:59→18:04 only (Contabo reboot wiped conntrack;
stock fallback blocks SIP).

**Recovery + verification (18:04):** stale rule removed from `direct.xml`,
`systemctl restart firewalld` → `running`, 0 journal errors, 256 rules,
`vpbx_white_list` at `INPUT_direct` 0 ahead of `geo_firewall` 1, loopcom →
PBX ping + helper both answering, **139 endpoints re-registered ≤ 2 min**,
DB=firewall=231 blocked (tv left unblocked deliberately).

**Not run / left disarmed:** the re-block half of the acceptance was NOT run —
it needs the same broken builder. `connect-geo-build.path` is disabled; a
console geo write now refuses (`buildChannel: None`). Re-arming requirements
are in §17a.

---

## Mirror stress round 2: 20 tenants × 10 extensions, outside the licence, torn down to byte-baseline (2026-08-19 evening)

Branch `feat/ivr-migration-takeover`, `58d55f6d` → `3ec0648e` → `9068acca`.
Handoff `AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §20.

**Live on the PBX, not a unit suite:** 20 tenants `mirror_stress_21..40` built
via the mirror through the deployed code (abort-if-via-panel guard never fired),
**20/20 PASS** in `stress20-verify.sh` (17 files / 20 endpoints / 10 exts / 20
devices / vm / hints / inbound route / cos each), then deleted: PBX rows + 340
files + AstDB + Main trunk/route/ARS rows, 65 orphaned `ombu_settings` rows
(incl. §13/§14/§18 leftovers), 14 auto-created Connect shells + `MIRROR TEST
delete me 0819` (money/user guards on every erase), 20 fake `PbxTenantInboundDid`
rows. **Every count byte-back to the pre-test snapshot** (27/119/167/67/56/80/
75/48/853/546 conf 546), 0 `mirror-test.invalid`, 0 stale ARS contexts, doorways
1/1/2 with 0 cc-wipes throughout, api 200 on both hostnames.

**The sweep-hardening fix that fell out of it (`9068acca`):**

```bash
node --experimental-test-module-mocks --import tsx --test apps/api/src/pbxOrphanTenantSweep.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

**Result: 19 tests, 19 pass, 0 fail** (12 existing + 7 new, incl. the exact
2026-08-19 failure shape: REST says gone, MySQL says alive → NOT marked). api
typecheck **75 = the exact baseline**, none in an edited file. **All 3 new
source guards on `server.ts` fail replayed against `HEAD`** (sync route passes
the verifier; confirm route verifies; unreachable MySQL answers 503).

**The incident that motivated it, for the record:** calling `sync-tenant-dids`
over VitalPBX's stale REST cache auto-marked Comfort control + LUZER removed;
both fully restored within the hour; their PBX tenants (ids 10, 26) genuinely
do not exist — a pre-existing condition now awaiting Izzy's decision.

---

## PBX Console: geo writes armed via the root path-unit channel (2026-08-19 afternoon)

Branch `feat/ivr-migration-takeover`. Handoff
`AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §17 (the "GEO
WRITES ARE ARMED" subsection). Touched: `scripts/pbx/mirror/console_writes.py`,
`scripts/pbx/vitalpbx-inbound-route-helper.py` (2026.08.19.4 + `buildChannel`
on geo-state), the installer (embedded copies re-synced + the
`connect-geo-build` runner/service/path-unit ship section), and the guard
suite. **No api/portal code touched — no Connect deploy needed.**

```bash
npx tsx --test scripts/pbx/install-vitalpbx-inbound-route-helper.test.ts
python -m py_compile scripts/pbx/vitalpbx-inbound-route-helper.py scripts/pbx/mirror/console_writes.py
```

**Result: 49 tests, 49 pass, 0 fail** (was 45 — 4 new geo guards). Both
embedded-copy byte-identity drift guards pass, which is the proof the re-embeds
are exact. Remote `py_compile` under the PBX's own venv also clean before
install.

**Proven non-vacuous:** all 7 new assertions (installer ships/arms the path
unit, runner heredoc exists, `unit` channel in `geo_build_available`,
`systemctl is-active` gate, request-file-carries-only-the-id, after-state read
after the build) **fail when replayed against `HEAD`'s blobs**.

**Proven on the live PBX (read/inert only — no firewall build was run):**
helper `/health` → `2026.08.19.4`; `systemctl is-active connect-geo-build.path`
→ `active`; `/console/geo-state` → `buildChannel: "unit"`, 232 blocked, 15
whitelist; and through the deployed api with a self-signed SUPER_ADMIN token,
`GET /admin/pbx-console/geo` → `200 enforcement.buildChannel: "unit"`.

**Deliberately NOT run: the first live `build_geo_firewall`** — Izzy's explicit
answer was "Hold off — I'll say when" (midday, 5 active calls). `direct.xml` is
still stamped 2026-04-29 and the journal shows no firewalld reload from this
work.

---

## PBX Console: creating a customer (2026-08-19)

Branch `feat/ivr-migration-takeover`, `3e914b4f` → `4faf2635`. Handoff
`AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §18.

```bash
node --experimental-test-module-mocks --import tsx --test apps/api/src/pbxConsole/pbxConsole.test.ts
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/onboarding/*.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/portal && npx tsc --noEmit -p tsconfig.json
```

**Result:** console suite **13 tests, 13 pass, 0 fail**; api typecheck **75 =
the exact baseline** with **0 in `pbxConsole/`**; portal typecheck **0**.

**Onboarding suite: 284 tests, 260 pass, 24 fail — and the 24 are NOT from this
change.** Proven rather than assumed: the same suite was run with
`pbxConsoleRoutes.ts` reverted to `HEAD` and returned the **identical**
284/260/24. They are the documented pre-existing `setupOrchestrator.test.ts`
failures from another session's `c2d9fdd9`.

**Proven non-vacuous.** All four new guards were replayed against `HEAD`'s
`pbxConsoleRoutes.ts` and **all four fail** there (9 pass / 4 fail), then pass
on the fixed tree:
- creating a tenant goes through the MIRROR, never the panel form
- the create reuses onboarding's slug rule rather than inventing one
- a duplicate customer is refused by name, before anything is written
- the create does NOT re-render

⛔ The last of those was **inverted after the production run**. It originally
asserted a failed re-render could not fail the create; prod showed the
re-render can never succeed at all (see below), so the guard now fails if
anyone re-adds it.

### Exercised against production, not just in tests
Throwaway customer created and deleted through the deployed routes while the
PBX carried **10 active calls**:
- create **200** — tenant 119, **13 baseline files rendered**, 80 outbound
  profiles offered by the picker
- duplicate **409 `tenant_exists`**, naming the customer that already held it
- delete **200** via the console's own route, doorway re-bake **3/3,
  linesChanged 0**
- **byte-back at baseline**: 27 tenants, 119 extensions, 554 tenant-settings
  rows, 353 tenant conf files, 0 rows or files mentioning 119, doorways on
  T2/T35/T105 still 0

⛔ **The prod run found what the tests could not:** the mirror's *second*
render fails `[Errno 13] Permission denied` because the first render hands each
file to `www-data` with an ACL mask of `r--` while the helper runs as
`asterisk`. Tests exercise the route, never the PBX's file ownership.

---

## Worker deploy — round 3's other half, and how it was missed (2026-08-19)

Branch `feat/ivr-migration-takeover`, worker at `95beef53`. No code change — a
deployment that had never happened. Handoff `AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md`
§11 (worker bullet) and §13.

```bash
DEPLOY_BRANCH=feat/ivr-migration-takeover DEPLOY_FORCE_RESTART=1 bash scripts/deploy-worker.sh
docker exec app-worker-1 grep -c "Same chain as apps/api" /app/apps/worker/src/connectChatSmsJob.ts   # 1
docker exec app-worker-1 grep -c "PUBLIC_PORTAL_URL" /app/packages/integrations/src/pbx-wirepbx/index.ts  # 2
```

**Result:** worker deployed (~15 min), both markers present in the running
container, `RestartCount=0`, **0** `level:50/60` lines in the five minutes after.
`git merge-base --is-ancestor 6a0f3a01 95beef53` → in.

⛔ **How it was missed:** `deploy-direct.sh` accepts `api|portal` only, so an
api+portal deploy leaves `apps/worker` and `packages/integrations` behind, and
`app-worker-1` carries **no `/app/.build-commit`** — the usual verification step
answers nothing rather than failing. ⛔ `deploy-worker.sh` takes **env vars, not
`--branch`**. ⛔ The change was behaviourally identical at the time (all six env
names in the chain are unset in the worker, so both versions resolved the same
literal), which is precisely why nothing surfaced it.

---

## PBX Console: geo write refuses safely, and the refusal reads as a refusal (2026-08-19)

Branch `feat/ivr-migration-takeover`, `81ccf2fa` (helper) + `b481ea19` (api).
Handoff `AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md` §17.

```bash
node --experimental-test-module-mocks --import tsx --test apps/api/src/pbxConsole/pbxConsole.test.ts
npx tsx --test scripts/pbx/install-vitalpbx-inbound-route-helper.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

**Result:** console suite **9 tests, 9 pass, 0 fail**; installer drift guard
**45 tests, 45 pass, 0 fail**; api typecheck **75 errors = the exact baseline**,
**0 in `pbxConsole/`**.

**Proven non-vacuous.** The new guard *"a known refusal answers 409 with a
sentence, never 500"* was replayed against `HEAD`'s `pbxConsoleRoutes.ts` and
**fails** there (8 pass / 1 fail), then passes on the fixed tree. The installer
guard *"the geo capability check never RUNS the firewall builder"* likewise fails
against the pre-change `console_writes.py`.

**⛔ Two guards had to be rewritten because they were matching my own doc
comments** — the comment above each fix quotes the defect it describes, so a
naive `!includes("--connect-probe")` failed on correct code. Both now strip
comments or assert only on executable lines. **Third recorded instance of this
trap in this repo.**

**Verified on production, not just in tests:** `POST /admin/pbx-console/geo`
answers **409** with the plain-English sentence (was 500); all three console
reads answer **200**; `/etc/firewalld/direct.xml` is **still stamped
2026-04-29**, firewalld shows **no reload**, and the PBX is byte-back at
**27 tenants / 119 extensions / 55 phones** with **0 doorway wipes** on
T2/T35/T105.
⛔ A firewall **rule count is a noisy check** — live reads 258 runtime / 253
permanent and the gap is fail2ban's 7 bans, which come and go.

---

## The agent's read-only investigation workspace, wired up (2026-08-19)

Branch `feat/ivr-migration-takeover`, `95beef53`. **apps/agent only** — no api,
no portal, no migration. Handoff `AGENT_HANDOFF_EZRA_100_QUESTIONS_2026-08-19.md`
§5b.

```bash
cd apps/agent && npm test
cd apps/agent && npx tsc --noEmit -p tsconfig.json
```

**Result:** **655 tests, 653 pass, 2 fail** — the same two pre-existing failures
(`corpus/archive.test.ts`, `transcription/everett.test.ts`), in files this change
never touched. Typecheck **15 errors = the exact baseline**, none in a new file.

**12 new tests** in `tools/investigationTools.test.ts`, picked up by the existing
`src/**/*.test.ts` glob. The ones that matter:

- a **customer** conversation cannot see the tool (`toolsForRole` → 0) **and**
  cannot execute it by naming it directly — and nothing reaches the door;
- the tenant is bound from the verified context: the model claiming
  `tenantId: "someone-elses-tenant"` has it stripped by the registry *and*
  overridden by the tool — two locks, both asserted;
- a guard **refusal comes back as DATA, not a thrown error**, so the model reads
  "you tried to write" and adjusts;
- source guards on the wiring, incl. that `EscalationService` still receives
  `chatTools` and still runs `role: "internal"` — otherwise the researcher
  silently loses `investigate` and its reports go back to being reasoned.

⛔ **Proven live against production before the tool was written** (read-only,
`POST /internal/agent/investigate` on the running api):

| probe | result |
|---|---|
| no secret | **403** `{"ok":false,"error":"forbidden"}` |
| `select count(*) from "Tenant"` (connect) | **200** — 52 rows, 66 ms |
| `select count(*) from ombu_tenants` (pbx) | **200** — 27 tenants, 376 ms |
| `update "Tenant" set name = name` | **200 `ok:false`, refusedByGuard** — *"Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN queries are allowed here… This workspace can look at data but never change it."* |

Container-verified after the rebuild: both new files in the image,
`buildInvestigationTools` registered, `minRole: "customer"` **0 hits**,
`AGENT_INTERNAL_SECRET` present (48 chars), agent healthy, **0 error-level log
lines**.

---

## Agent escalations reached nobody; the hold-music clarify trap (2026-08-19)

Branch `feat/ivr-migration-takeover`, `ce9f2318`. **apps/agent only** — no api,
no portal, no migration. Handoff `AGENT_HANDOFF_EZRA_100_QUESTIONS_2026-08-19.md`.

```bash
cd apps/agent && npm test
cd apps/agent && npx tsc --noEmit -p tsconfig.json
```

**Result:** **643 tests, 641 pass, 2 fail.** Both failures are **pre-existing**
and in files this change never touched — `corpus/archive.test.ts` ("export
manifest yields (audio,text) pairs") and `transcription/everett.test.ts`
("normalizeLanguage: hint wins"); `git diff --name-only HEAD -- apps/agent/src/corpus
apps/agent/src/transcription` is empty. Typecheck **15 errors = the exact
baseline** (8 × `unref` in `server.ts`, 7 × `@connect/shared` subpath resolution
in `packages/db`), **none in an edited file**.

**26 new tests**, both files picked up by the existing `src/**/*.test.ts` glob:
`escalation/escalationGate.test.ts` (11) and `triage/mohClarifyTrap.test.ts`
(14), plus one in `auth.test.ts`.

⛔ **Proven non-vacuous, which mattered more than usual here** — the escalation
gate had **no test coverage at all** before this. All source guards were
replayed against `HEAD`:

| guard | on HEAD |
|---|---|
| `routes.ts` passes `isPlatformStaff(identity.platformRole)` | absent ✅ |
| `escalations.ts` gate reads `ctx.isPlatformStaff` | absent ✅ |
| the old `ctx.role === "owner"` gate is gone | **present on HEAD** ✅ |
| `auth.ts` carries `platformRole` | absent ✅ |
| `orchestrator.ts` has `MOH_NEW_REQUEST_RE` | absent ✅ |
| HEAD's `ESCALATION_RE` matches "the Connect team" | **no — extracted from the HEAD blob and run against the real sentence** ✅ |

**Corpus replay against the real 135-message session** (2026-08-18, Ezra,
7 conversations): **48/48 escalation promises now match, 0 false positives among
the other 87 assistant replies.** Before: 5/48 matched, and all 48 were
suppressed by the role gate anyway.

---

## Sign-in code — hardening pass, three findings from attacking it (2026-08-19)

Branch `feat/ivr-migration-takeover`, `1fa34d29`. api + portal.
Handoff `AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §12.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/mfa/*.test.ts" src/publicReadyJwtBypass.test.ts src/loginRequest.test.ts src/loginThrottle.test.ts src/nodeEnvGates.test.ts src/globalRateLimit.test.ts src/publicOrigins.test.ts src/tenantScopeHardening.test.ts src/securityHardeningRound2.test.ts src/internalSecret.test.ts
cd apps/portal && node --import tsx --test lib/mfaLogin.test.ts
```

**Result:** api security sweep **178/178** (mfa 18 + 9 + 24 after +5 new), portal
**11/11**. New: `decideChallengeReuse` rules; a source guard that the login
handler has **no** `.catch()` on the 2FA tenant read and **does** answer 503; a
guard that `startOtpChallenge` checks reuse **before** it creates or sends; and
two end-to-end route tests — **eleven consecutive sign-ins produce ONE text and
ONE challenge row**, the original code still verifies through the newest login
while older pre-auth tokens are dead, and a challenge that burned its five tries
really is replaced rather than handed back.

**Replayed against the shipped commit `07105681`** (i.e. the code as deployed
when the pass started): all five markers confirm the findings were real — the
login gate carried the fail-open `.catch`, `issueLoginSession` carried it too,
there was no 503 branch, no `decideChallengeReuse`, and `startOtpChallenge` sent
unconditionally. api typecheck **75 = baseline**, portal **0**.

Also verified by reading rather than assuming: `EmailJob.type` is a plain
`String` (no enum), so `LOGIN_CODE` inserts; and the send door skips **only**
`ADMIN_ALERT`, so a login code really is sent.

### Live (acceptance)

See the deploy bullets. ⏳ Still no tenant switched on and no code sent to a human.

---

## Per-tenant sign-in code (2FA by text/email) + Turnstile (2026-08-19)

Branch `feat/ivr-migration-takeover`, `fc551996`. api + portal + db migration.
Handoff `AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §12.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/mfa/loginOtp.test.ts src/mfa/loginOtpRoutes.test.ts src/mfa/mfa.test.ts
cd apps/portal && node --import tsx --test lib/mfaLogin.test.ts
```

**Result:** api **46/46** (15 rules+guards, 7 end-to-end routes through a real
Fastify + `@fastify/jwt` against a faked db, 24 existing MFA), portal **11/11**
(+3). Neighbouring api suites (bypass list, internal doors, loginRequest,
loginThrottle, nodeEnvGates, tenantScopeHardening, securityHardeningRound2,
globalRateLimit, publicOrigins, internalSecret, userDisplayName.callsites,
sipRouteDefault, sipPublicEndpoint) **147/147**. **All 9 source guards fail
replayed against `HEAD`** (bypass entries, `turnstileGate(`, `decideOtpGate(`,
`registerLoginOtpRoutes`, `expiresIn: OTP_SESSION_EXPIRES_IN`, `loginRequest`
fields, portal `/auth/otp/verify`, `TurnstileWidget`, `writeTrustedDeviceToken`).
Also: every `(db as any).xxx` accessor in the routes maps to a real
`Prisma.ModelName`. Typecheck: api **75 = baseline**, portal **0**. Migration
`20260819080000_tenant_login_otp` verified column-identical to `prisma migrate diff`.

### Live (acceptance)

See the deploy bullets in CLAUDE.md's section. ⏳ No tenant switched on; no code
sent to a human; no Turnstile key exists.

---

## Loopcom parity in code — publicOrigins, same-origin WS, signup gate (2026-08-19)

Branch `feat/ivr-migration-takeover`, `6a0f3a01`. api + portal + worker/integrations/mobile source.
Handoff `AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §11.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/publicOrigins.test.ts
cd apps/portal && node --import tsx --test lib/loopcomParity.test.ts
```

**Result:** api **11/11** (resolution order, host allow-list, OAuth path-keeping,
tree sweep for the literal hostname as CODE), portal **5/5** (same-origin telephony
WS, relative download links, platform identity). 8/8 source guards fail replayed
against the pre-change files. Typecheck: api **75 = baseline** (identical set),
portal **0**, integrations **0**; worker/mobile only their pre-existing errors.

### Live (acceptance)

✅ api + portal DEPLOYED and container-verified at `6a0f3a01`. Both hostnames:
health 200, portal 200, bad-credential login 401; `/auth/signup` → 404. ⏳ No
Loopcom-host OAuth sign-in, no email opened from a Loopcom link, no phone paired
from `app.loopcom.net`.

---

## Overdue cutoff sweep — invalid invoice status, the sweep had never run (2026-08-19)

Branch `feat/ivr-migration-takeover`, `97cad9f7`. api only. Handoff
`AGENT_HANDOFF_EMERGENCY_CALLING_SERVICE_INTERRUPTION_2026-08-17.md` §11.

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/billing/serviceInterruption/*.test.ts" src/billing/billingDunning.test.ts
```

**Result:** 125/125 (job suite 13, of which 3 new; dunning suite +1). The job
suite's fake db now parses `BillingInvoiceStatus` out of `schema.prisma`
(CRLF-normalised) and throws Prisma's message on any non-member in `status.in`.
**Replayed against the OLD list** (`["FAILED","OVERDUE","UNPAID"]`, swap the
constant and re-run): **9/13 fail** with `Invalid value for argument 'in'.
Expected BillingInvoiceStatus. (got "UNPAID")` — restored, 13/13. Also pinned:
FAILED and OVERDUE start a countdown, OPEN does not; `mergeDunningAfterFailure`
stamps `firstFailedAt` once and a retry never moves it. apps/api typecheck
**75 = baseline**, 0 in the four edited files.

### Live (acceptance)

✅ api DEPLOYED and container-verified `97cad9f7` (`deploy-direct.sh api`, 295 s, `.build-commit` = `97cad9f7`, `grep -n 'UNPAID_FAILURE_STATUSES = ' …serviceInterruptionJob.ts` → line 68 `["FAILED", "OVERDUE"]`, `firstFailedAt,` at `billingDunning.ts:109`). Boot log `sweep scheduled {armed:true, cutoverAt:2026-08-18T12:01:07Z}`; five minutes later `sweep complete {considered:1, remindersSent:0, interrupted:0, restored:0, skippedPreCutover:0, errors:[]}` — **no `tenant failed` line**. The `considered:1` is TYH Industries, whose only invoice is PAID, so no countdown — the correct answer. On the previous build (`1c1d067e`, same day) the same tenant had produced `errors:[{…Invalid value for argument 'in'. Expected BillingInvoiceStatus.}]`.

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
