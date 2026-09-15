# Tests Run

Newest entries first.

## GDMS device/add batch-result fix (2026-09-15, `3040f2bc`)

- api `npx tsx --test src/deskPhoneSetup/deviceProviders.test.ts` → **34/34 pass** (1 new: a serial
  belonging to a different handset is refused by the BATCH result — `gdms_request_rejected`,
  non-retryable, nothing added, right serial still registers afterwards). Replayed against the
  pre-fix `gdmsClient.ts` (HEAD copy): **fail 1** — the test catches the live bug; restored: fail 0.
- api tsc: pre-existing diagnostics only, none in the three touched files.
- Live evidence that motivated it: first real GDMS write ever — device/add answered retCode 0 with
  `{success:0, failure:1, errorDeviceList:[{errorMsg:"30010"}]}` for Izzy's typed serial
  `20ZE115N308C605F` against MAC `C0:74:AD:8C:65:4E` (the serial embeds the OTHER unit's MAC tail
  `8C605F`); account device list total 0 before and after. Probe recipe in the handoff.
- Deployed api `3040f2bc`, blue/green, container-verified (commit + `errorDeviceList` in shipped
  source, `CRM_OCR_ENABLED=true` survived, 0 restarts). ⏳ Not proven: no successful claim with a
  correct serial yet.


## Deploy Center autoban regression (2026-09-14)

15 focused route/polling tests pass, including 74 queued-log reads with zero public 404s and all six deploy services; PBX safeguards 6/6 pass. Portal typecheck passes; API tsc has 84 existing diagnostics, none in the new route/registration. Actual-component Chrome fixture verifies queued zero-read, running log, stale error warnings, manual recovery and terminal single read. Live nginx ban/74-path aggregation proved cause; owner-approved one-IP unblock restored both login hosts and API health to 200. API/portal fix release pending; see AGENT_HANDOFF_DEPLOY_LOG_AUTOBAN_2026-09-14.md.


## Support agent hands — watcher hookup (2026-09-14, `84a5fc16`)

- watcher `node --test stress.test.mjs hands.test.mjs` → **66/66 pass** (19 new in `hands.test.mjs`: per-company cap
  boundary 9/10, other company unaffected, platform lane never counted, name fallback + unknown company never capped,
  skips/yesterday not counted, claim records the company; the three hands in ALLOWED_TOOLS and argv; guardrails still
  state no commit/push/deploy, no PBX write, no customer message, Bash read-only, and now state the fixing rules; 30-min
  default; the client posts only to /act, /owner-notice, GET /owner-notices with the token; a hostile reference stays
  under the escalation path; the api's 409 reaches the agent; server.mjs registers the tools; watch.mjs has no POST).
  `node --check` on server/loopcom/watch/triage ✅.
- api `src/support/verifiedChange.test.ts src/support/customerUpdate.test.ts src/support/supportAgentNotice.test.ts
  src/support/actAsFilerRoutes.test.ts src/support/agentRunRoutes.test.ts src/support/supportMessages.test.ts
  src/support/verdictFollowUp.test.ts src/support/supportLoopGuardrail.test.ts src/agentFixByText.test.ts` →
  **186/186 pass**. api tsc 84 = baseline. Control-byte scan of all 8 touched files: 0.
- Guards against HEAD by symbol count: `act_as_filer` (watch.mjs, server.mjs), `tenantKeyOf`, `verifiedChangeOnTicket` → 0 in HEAD.
- Deployed: api job `488b8c20` → container 84a5fc16, healthy, 0 restarts. Watcher restarted (pid 9484, new startup line).
- ⛔ Not proven: no ticket has run with the new tools (and the office IP was nginx-banned at the time — handoff §8);
  writes still OFF.

## Profile menu release verification blocked (2026-09-14 18:42 Eastern)

- Runtime `8b866ed6` pushed to the feature branch and `codex/profile-menu`. Local portal typecheck, 6 DND/dropdown tests, 6 PBX safeguard tests, and actual-component browser fixture checks passed (details below and profile-menu handoff).
- Production dry run `4f104c91-3517-4f4f-af0f-ebd388177b68` passed. First real job `1ee9806f-db7f-43d3-b469-5c33df86004a` stopped before build on the separate heavy-job lock.
- Bounded retry `10fee31a-fd98-45b7-9071-0e856e6bb7e5` started 18:28:39, reached Next production compilation with expected SHA, and was last seen RUNNING/build. Final build/rollout checks were not obtained.
- Around 18:41 fresh Chrome dashboard and Deploy Center returned nginx 403. Independent network-enabled workstation GETs: Loopcom login 403, ready 403, legacy-host login 403. Initial sandbox socket denial was not an HTTP result. No cause/global-outage inference.
- No live DND mutation or incoming-call acceptance test; awaits owner-selected company/extension. No fresh deployed light/dark verification or manual container grep. Do not report these as passed.


## Support agent hands — phase 1 act-as-filer + phase 2 owner notices STOP/GO (2026-09-14, `d1f2aa46` `cc8211c1` `31dc0e05`)

- api `node --experimental-test-module-mocks --import tsx --test src/support/supportAgentNotice.test.ts
  src/support/actAsFilerRoutes.test.ts src/support/agentRunRoutes.test.ts src/support/supportMessages.test.ts
  src/support/customerUpdate.test.ts src/agentFixByText.test.ts` → **150/150 pass** (phase 1 alone: 116/116).
  New: path check (every blocked prefix incl. /api + case, URLs, traversal, encoded traversal, backslash, token= /
  tenantContext=), SUPER_ADMIN-only, token claims from the DB row, tenant mismatch / platform filer / alarm / stale /
  inactive refused, writes off without the env switch, per-tenant cap by distinct tickets, write refused without a
  live owner notice or after STOP; notice parser (word+code, negated go refused, FIX not a notice), gate (no notice,
  undelivered SMS, expired, system waits for GO), replies (STOP halts every later write, one reply acts once,
  stranger ignored, GO on tenant = not needed, GO after expiry refused, STOP after expiry works, code only stored
  hashed and never returned by the route, no new notice after STOP, alarm cannot get a tenant notice).
- Source guards replayed against HEAD by counting the asserted symbols in `git show HEAD:<file>`: every one **0** in HEAD,
  present in the worktree. (A scratchpad-copy replay died on `Cannot find module 'fastify'` — that proved nothing.)
- `prisma validate` ✅; api `tsc --noEmit` 84 errors = baseline, none in touched files; `packages/shared` tsc 0.
- New files scanned for stray control bytes: 0 each (after the `d1f2aa46` binary-file mistake, fixed in `cc8211c1`).
- Live: `/api/admin/support/escalations/3GTH9M/act` → **401** without a token on both hostnames; health 200 on both.
- ⛔ Not proven: no request has gone through `/act` from the watcher, no owner notice has been texted, no real STOP/GO
  processed; `SUPPORT_AGENT_WRITES_ENABLED` unset. Phase-2 deploy: first attempt `33fb81a7` stopped before migrate
  (another session's portal heavy job) — changed nothing; retry result is in the handoff §6.

## Profile menu implementation + extension-wide DND (2026-09-14)

- Portal TypeScript `--noEmit --incremental false`: PASS.
- `profileDnd.test.ts` + `dropdownOutsideClose.test.ts`: 6/6 PASS (registered as `test:profile-menu`).
- API `pbxMutationSafeguard.test.ts`: 6/6 PASS; no live PBX access.
- Chrome actual-component fixtures: confirmed DND On/Off POST, save/reopen, unconfirmed/failed write, unknown read, GET-only retry, SMS error/revert, voicemail dependency, keyboard close/tabs, both themes, 390px and 320px layout. PASS. No real phone call or live DND toggle performed; awaiting owner-selected extension.

## Profile menu mockup (2026-09-14)

Chrome visual/interaction checks passed: light/dark, Quick settings/Voicemail tabs, email-dependent transcription, close/reopen, Escape focus return. Light quick settings at 390px and dark voicemail at 320px fit without horizontal overflow. Local preview only; no production settings or runtime code changed. Full-page screenshot timed out once; normal captures succeeded. Assigned-extension Tweak option not exercised. See `AGENT_HANDOFF_PROFILE_MENU_DESIGN_2026-09-14.md`.

---

## Voicemail greeting also plays on busy — ticket 3GTH9M (2026-09-14, `5b499073`)

- api `node --experimental-test-module-mocks --import tsx --test src/voicemailGreetingMirror.test.ts src/vmRecordCallJobs.test.ts
  src/vmRecordCallHelpers.test.ts` → **60/60 pass** (9 new: create busy when absent, replace a previous copy, NEVER
  overwrite a distinct busy greeting, call-to-record reads bytes from the PBX, helper failure reported not thrown, reset
  removes busy only when it is a copy, non-unavailable reset untouched + still throws, source guard).
- Source guard replayed against pre-fix HEAD `server.ts`/`vmRecordCallJobs.ts` → **FAILS** ("upload must mirror to busy.wav"), as it should.
- api `tsc --noEmit`: 84 errors, **none in `voicemailGreetingMirror.ts` or `vmRecordCallJobs.ts`**; the `server.ts` ones are
  far from the edited lines (Timeout/apnsVoipPush types). HEAD's count was not re-run.
- ✅ Deployed: api queue job `4c42b792` → container `7d12c14f` (contains `5b499073`), 0 restarts, healthy, 200 on both hostnames.
- ✅ Backfill dry-run then apply (Trust 101/105/107 → `created`); PBX read-back: busy.wav sha256 == unavail.wav for all
  three, owner asterisk, 8 kHz mono PCM; 106's own busy.wav unchanged.
- ⛔ Not proven: no real busy/declined call to ext 101 has played the recording yet.

---

## Desk-phone: no password → ask for the SERIAL (second door) (2026-09-14, round 6)

- shared desk-phone suite **158/158**, tsc 0. New: `resetFallback` on `DeviceMechanisms` (Grandstream+GDMS →
  `vendor_cloud`; no cloud or a cloud that cannot wipe → `none`; Yealink → `none`), plus a sweep invariant that the
  fallback is never the same door as the primary and never claimed without a real cloud wipe for that brand.
- api desk-phone routes **92/92**. New: `passwordUnavailable` + a cloud that can wipe → `reset_over_lan` with
  `via: vendor_cloud` + the folder (so the wizard asks for the serial); `passwordUnavailable` +
  `makerCloudUnavailable` → halted, hands-on message (both doors shut); no cloud configured → halted, no false promise.
- portal driver **44/44**, tsc 0 (the advance body now carries `makerCloudUnavailable`).
- desktop rc.16: **167/167**, tsc 0, built from a clean export of `3aec620e` and installed; shipped asar verified to
  contain `cgi-bin/access`, `Referer`, `sha256` and the login cap.
- ⛔ Not proven: a real Grandstream login/reset. That needs Izzy's password on the handset.

---

## Desk-phone Grandstream REAL login protocol (token + hashed password) (2026-09-14, round 5, rc.16)

- ⛔ Round 4's login shape was WRONG in production: Izzy's correct password was refused 4× in 40s
  (`factory_reset … -> refused:locked`, desktop log 21:57Z). Root cause found by reading the phone's own GWT
  bundle: the login is two steps and the password is hashed, and every CGI path needs a `Referer`.
- desktop `node --import tsx --test src/phoneSetup/*.test.ts` → **167/167 pass** (was 164; the Grandstream adapter
  suite was rewritten for the two-step protocol: username-hash-only token request, Referer on all three requests,
  `hex(sha256(password+token))` with a test asserting the PLAIN password never appears in url/body/headers,
  access→dologin→RESET ordering, 403-on-token → locked with nothing further sent, unreadable token → `refused`
  not `locked`, no-password → nothing sent). desktop tsc 0.
- portal setupDriver **44/44** after teaching `classifyResetAnswer` that `too_many_login_attempts` sent nothing.
- Live, read-only, no password sent by an agent: `POST /cgi-bin/access` with `access=hex(sha256("admin"))` +
  `Referer` → **200 `{"response":"success","body":"<token>"}`**; the same POST without `Referer` → **403**.
- Server state after the failed run: every phone row `resetCount 0, attempts 0` — nothing wiped, nothing spent.
- ⛔ Not proven: the `dologin` half (needs Izzy's password) and therefore a real reset.

---

## Desk-phone Grandstream LAN reset with the password, no serial (2026-09-14, round 4, `c7f5459c`)

- shared `npm test` → **708/708 pass**; tsc 0. Changed expectations: `deviceMechanisms` now LAN-first (a
  Grandstream with GDMS connected still resets over the LAN); `deviceIdentification` capabilities gain the local
  Grandstream reset; the `deskPhoneInvariants` "only Yealink over HTTP" invariant is now Yealink+Grandstream.
- desktop `node --import tsx --test src/phoneSetup/*.test.ts` → **164/164 pass** incl. new
  `grandstreamAdapter.test.ts` (12: login body not URL, private-address fence, sid/cookie parse, RESET/REBOOT
  ordering, 401→locked with no operation sent, session-less 200→locked, no-password→nothing sent,
  unreachable≠sent, credential test). desktop tsc 0.
- api deviceCloudRoutes **33/33** (Grandstream ticked → `reset_over_lan` with no `via`; the old "via vendor_cloud"
  expectations flipped to LAN). portal setupDriver **44/44** (Grandstream cleared over the LAN with the password;
  a brand with no executor still takes the hand-off; the cloud-reset path tests moved to a Poly fixture).
- First run caught 3 shared + 7 portal expectation failures — all were tests encoding the old "only Yealink
  resets over HTTP" fact; updated, not the code.
- ⛔ Not proven by any of this: a real GXP2170 logged into and reset over the LAN. Izzy's live run is the proof.

---

## Desk-phone per-brand mechanisms + Grandstream through GDMS in the real wizard (2026-09-14, round 3, `7e54716a`)

- shared `npm test` (full script, new `deviceMechanisms.test.ts` registered) → **707/707 pass**; `tsc --noEmit` 0 errors.
  `deviceMechanisms.test.ts` 8/8 incl. the SWEEP over every catalogue brand × 9 cloud shapes.
- api `node --experimental-test-module-mocks --import tsx --test`: deviceCloudRoutes **33/33** (5 new: Grandstream +
  GDMS → `reset_over_lan via vendor_cloud` + folder; no cloud → answered as before; Yealink never `via`; spent reset →
  `set_provisioning via vendor_cloud`; unticked → nothing), deskPhoneRoutes 56, deskPhoneStress 38, deskPhoneChaos 6,
  deskPhoneRecordWiring 28, deskPhoneRouteOrder 8, deviceProviders 33, provisioningRecordWriter 21,
  managedPhoneIntegration 12, yealinkRps 12 — **0 fail**. api tsc: no errors in `deskPhoneSetup`.
- portal `node --import tsx --test`: setupDriver **43/43** (8 new maker-cloud tests: listen-first, never a local wipe,
  cannot-listen blocks the clear, serial asked + paced + resumed, "can't find it" falls back, permanent vs retryable
  refusal, restarts bounded at 2 and spaced 3 min, already-delivered phone not restarted, unnamed brand path unchanged);
  other registered desk-phone files 46/46; portal tsc 0.
- First run of the new driver tests: 1 failure was the TEST (an observation travels on the NEXT advance) — fixed in the test.
- ⛔ Not proven by any of this: a real GXP2170 added to GDMS, reset and restarted through GDMS, then provisioned by PnP.

---

## Desk-phone Prepare Device goes reset-first + GDMS card (2026-09-14, round 2, `acb994a3`)

- shared `node --import tsx --test src/deskPhoneSetup/deviceIdentification.test.ts` → **33/33 pass**
  (reset-first ordering, no second reset, Yealink tick-only, hands-on, SWEEP over `resetAlreadyDone` > 2000 combos).
- api `node --experimental-test-module-mocks --import tsx --test` on every `src/deskPhoneSetup/*.test.ts`:
  deviceCloudRoutes **28/28** (incl. first run caught the claim-before-reset gap: 2 failed, fixed),
  deviceProviders 33, deskPhoneRoutes 56, deskPhoneStress 38, deskPhoneRecordWiring 28, deskPhoneRouteOrder 8,
  provisioningRecordWriter 21, managedPhoneIntegration 12, yealinkRps 12, deskPhoneChaos 6 — **0 fail**
  (managedPhonePostgres 0 run: needs the local test Postgres).
- `tsc --noEmit`: shared 0 errors; portal 0 errors; api errors only in pre-existing unrelated files
  (webrtc outage/incident, billing preview tests, delivery audit, hostMetrics) — none in deskPhoneSetup.
- desktop (clean export `f8e11424`): tsc 0; `node --import tsx --test src/phoneSetup/*.test.ts` → **152/152 pass**.
- Post-deploy container checks: api + portal `.build-commit` = `acb994a3`, 0 restarts, migration columns present,
  shipped portal chunks carry the GDMS card + label box, `/admin/integrations` 200 on both hostnames.
- ⛔ Not proven by any of this: a real GDMS account, a real phone reset through /prepare, the card in a browser.

---

## Desk-phone automatic device identification + maker-cloud providers (2026-09-14, latest)

```bash
cd packages/shared && npm test                                                              # 698/698
cd packages/shared && npx tsc --noEmit -p tsconfig.json                                     # 0 errors
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/deviceProviders.test.ts     # 33/33
cd apps/api && node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/deviceCloudRoutes.test.ts   # 27/27
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/deskPhoneSetup/*.test.ts"                # 242: 241 pass, 1 skipped (real-Postgres)
cd apps/api && npx tsc --noEmit -p tsconfig.json                                            # 84 = baseline, 0 in deskPhoneSetup
cd apps/desktop && node --import tsx --test "src/phoneSetup/*.test.ts"                      # 152/152
cd apps/desktop && npx tsc -p tsconfig.json --noEmit                                        # 0
cd apps/portal && npx tsx --test components/deskPhones/*.test.ts lib/deskPhoneWizard.test.ts lib/nativeSelectSweep.test.ts
#   113: 112 pass; 1 fail = nativeSelectSweep on app/(platform)/orders/OrdersDesk.tsx:563 (pre-existing, not this work)
cd apps/portal && npx tsc -p tsconfig.json --noEmit                                         # 0
# prisma migrate diff (HEAD schema -> new schema) == migration 20260914190000 SQL
# PORTAL_GUARD_ROOT=<HEAD export> wizardDeviceIdentity.test.ts -> 3 of 5 fail at HEAD (other 2 are regression guards)
```

Not run: any live GDMS / Yealink RPS call (no credentials stored), any real handset, any deploy.

## Desk-phone reset wired + counted only when sent (2026-09-14, later)

Branch `feat/ivr-migration-takeover`. Plan doc §20f. ⛔ Every reset proof below uses a FAKE
bridge / fake db — no phone on any network was reset, rebooted or sent anything (Izzy:
"don't factory reset any of the phones on my network. I have to do it.").

```bash
# api  (⛔ needs --experimental-test-module-mocks)
cd apps/api && npx tsc --noEmit | grep -c "error TS"                 # 84 = the exact baseline, 0 in deskPhoneSetup
node --experimental-test-module-mocks --import tsx --test "src/deskPhoneSetup/*.test.ts"
#                                                                    # 156 / 156
# replayed against HEAD's deskPhoneRoutes.ts (backed up, restored, cmp-identical):
#   12 of the reset tests FAIL there (incl. the route-order source guard
#   "deciding a reset never spends it"). Regression guards that pass at HEAD by design:
#   "twenty concurrent reset reports count it once" (route absent -> nothing counted),
#   "another customer cannot report a reset" (404 either way).

# portal
cd apps/portal && node --import tsx --test components/deskPhones/setupDriver.test.ts   # 31 / 31
```

---

## Desk-phone record writer, make/model pickers, and the record-move rule (2026-09-14)

Branch `feat/ivr-migration-takeover`, commits `257b0b07` (pickers + identify route) and
`b9956746` (the bare device-name fix + the move rule). Plan doc
`PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §20.

```bash
# shared
cd packages/shared && npx tsc --noEmit                               # 0 errors
npm test                                                             # 672 / 672

# api  (⛔ needs --experimental-test-module-mocks)
cd apps/api && npx tsc --noEmit | grep -c "error TS"                 # 84 = the exact baseline
npx tsc --noEmit | grep "error TS" | grep -E "deskPhoneSetup|provisioningRecord|loginThrottle"
#   -> empty
node --experimental-test-module-mocks --import tsx --test "src/deskPhoneSetup/*.test.ts"
#                                                                    # 150 / 150

# portal (only 257b0b07 touched it)
cd apps/portal && npx tsc --noEmit                                   # 0 errors
npx tsx --test components/deskPhones/wizardIdentifyPhone.test.ts \
  components/deskPhones/wizardMakeAndPhotos.test.ts lib/deskPhoneWizard.test.ts
#                                                                    # 56 / 56
```

**Replay against HEAD** (source file backed up to the scratchpad, `git show HEAD:<file> >`
swapped in, suite re-run, restored, sha256 compared identical):

| suite | against | fails there |
|---|---|---|
| `provisioningRecordWriter.test.ts` (21) | the committed writer | **16** |
| `deskPhoneRecordWiring.test.ts` (28) | the committed routes | **3** |

⛔ Ten of the sixteen writer failures are the fixture correction: the old fixture used
`T21_101` for `ombu_devices.user`, the live PBX uses `101`. ⛔ Three "move refused" tests
first PASSED at HEAD for the wrong reason (HEAD refused with `no_desk_device`); they now
assert the reason `held_by_another_account` and fail there.

---

## Desk-phone wizard — every brand, not just Yealink (2026-09-11)

Branch `feat/ivr-migration-takeover`, commit `dac3aab2`. Plan doc
`PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §18.

```bash
# shared
cd packages/shared && npx tsc --noEmit                               # 0 errors
npm test                                                             # 597 / 597

# desktop
cd apps/desktop && npx tsc --noEmit                                  # 0 errors
npm test                                                             # 285 / 285

# portal
cd apps/portal && npx tsc --noEmit                                   # 0 errors
npm test                                                             # 585 tests, 581 pass, 4 fail
#   all four pre-existing and none in a touched file:
#   campaignsIndexLayout, coworkerHands, webrtcSdpDiagnostics, and
#   nativeSelectSweep catching another session's OrdersDesk.tsx:563

# api  (⛔ needs --experimental-test-module-mocks or every mock.module file dies)
cd apps/api && npx tsc --noEmit | grep -c "error TS"                 # 84 = the exact baseline
npx tsc --noEmit | grep "error TS" | grep -E "deskPhoneSetup|vendorAdapters|deviceKinds|deviceIdentity|discoveryFilter"
#   -> empty: none in any edited file
node --experimental-test-module-mocks --import tsx --test "src/deskPhoneSetup/*.test.ts"
#                                                                    # 101 / 101
```

**Replay against HEAD.** The eight changed SOURCE files were copied to the scratchpad,
`git checkout HEAD --`'d, the suites re-run, then restored and `cmp`-verified byte-identical.
The new tests fail there:

| suite | fails at HEAD |
|---|---|
| shared invariants | **2 of 2** rewritten tests |
| desktop `pnp` + `pnpResident` | **4** — the Accept echo, and three two-port / interface tests |
| portal driver + wizard | **3** — a Grandstream is listened for, the hour is gone, the give-up threshold |
| api routes | **5** — catalogue naming ×2, the shared OUI block, both Phase-F tests |

⛔ **Named rather than counted: the new tests that PASS at HEAD are regression guards, not
bug-proofs.** The hostile-`Accept` test (HEAD hard-coded the literal, so nothing could be
injected), the `cannot_listen` recovery test (HEAD never set the flag at all), and the api's
Grandstream-ladder test (the api never had the Yealink gate — that gate was in the driver).

⛔ **One repair found by a control-character scan, not by a test:**
`apps/portal/lib/deskPhoneWizard.test.ts`'s jargon guard read
`/<BS>(HTTP|SIP|DHCP|…)<BS>/i` with two literal BACKSPACE bytes where `\b` word boundaries
were meant, so it had matched nothing since the day it was written. Proven both ways
afterwards — the fixed regex catches "over HTTP", "provisioning folder" and "DHCP option 66"
and passes honest copy; the broken one matches none of them.

```bash
# the scan worth repeating on any file written through a shell
python -c "import io,sys; d=io.open(sys.argv[1],'rb').read().replace(b'\r\n',b'\n'); \
print(len([b for b in d if b<9 or (10<b<32) or b==127]))" <file>
```

⏳ **NOT PROVEN: no phone of any brand has been set up through this.** Every number above is
a suite or a typecheck; the acceptance test is Izzy's own rig.

---

## The Coworker's hands — unit suites + the end-to-end acceptance harness (2026-09-09)

Branch `feat/ivr-migration-takeover`, commits `336ad19f` → `1ac3d427`. Handoff `AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md`.
Toolchain on the dev box: scratch `npm install` junctioned into `apps/desktop/node_modules` (electron 41.5.0,
typescript 6.0.3, tsx) and `apps/agent/node_modules` (typescript 5.9.2, fastify, zod, prisma client generated);
the pnpm store here is unreadable (`devbox-toolchain-blocker`).

```bash
# desktop
node_modules/.bin/tsc -p tsconfig.json --noEmit                      # 0 errors
node --import tsx --test --test-timeout=90000 src/*.test.ts src/phoneSetup/*.test.ts src/coworkerWidget/*.test.ts src/coworker/*.test.ts src/remoteSupport/*.test.ts src/remoteDesktop/*.test.ts
#   250/250 (235 before + 15 in src/coworker/coworkerHands.test.ts; +2 xlsx tests later = 252)
# agent
node_modules/.bin/tsc -p tsconfig.json --noEmit                      # 0 errors in apps/agent/src (11 pre-existing in packages/*)
node --experimental-test-module-mocks --import tsx --test src/coworker/desktopLink.test.ts src/conversation/coworkerAwareness.test.ts src/conversation/staffPrompt.test.ts src/conversation/engineTools.test.ts src/tools/coworkerTaskTools.test.ts
#   desktopLink 11/11, coworkerAwareness 6/6, staffPrompt, engineTools, coworkerTaskTools all green
# full agent suite: 419 ok; the ✖ files (escalationGate, escalations, standingKnowledge, smsEmail*, permissionGrant)
#   are "Cannot find module 'zod'" through the workspace junctions of this harness + two pre-existing assertions
#   (everett 'yi' vs 'he', permissionGrant) — not touched by this work.
# packaged build
node_modules/.bin/tsc -p tsconfig.json && node_modules/.bin/electron-builder --win && node --import tsx scripts/verify-built-icon.ts
#   release/Connect-Setup-0.1.17-rc.10.exe, verify:icon OK
# acceptance (the real agent, the real app, this machine)
node apps/desktop/scripts/coworker-acceptance/run.mjs --suite dev --out %USERPROFILE%\Loopcom-Coworker-Proof-2026-09-09T1751
#   base: 41 PASS / 4 FAIL first run → O4 (xlsx template rows: fixed in code), W2 + B (GiB vs decimal GB: check fixed),
#   W5 (dev build is electron.exe: check fixed) → reruns 4/4 PASS ⇒ 45/45
node run.mjs --suite dev --extended --only BG1,CC1,CN1,FR1,FR2,LP1,PM2,PM3,SL1,PF1,PV1,PV2,FR3 --out …/extended-dev
#   9 PASS / 5 FAIL first run: BG1 (foreground changes were another operator's, now attributed), CC1 (regex),
#   CN1 (the harness's own Get-Process CommandLine query took ~100 s so the cancel came late — now waits for the
#   in-flight call), PM2 (Esc via SendKeys never reached the prompt; watcher now posts to the HWND), PV1 (the Claude
#   turn ran the pipeline and wrote the file; the check wanted the provider NAME in it). Reruns: handoff §5/§6.
```

---

## Sign-in code v3 — per user on Account → Security, text/email only (2026-09-08)

Branch `feat/ivr-migration-takeover`. Handoff `AGENT_HANDOFF_LOGIN_OTP_V3_SECURITY_PAGE_2026-09-08.md` §5.
Same dev-box harness as the v2 entry below, plus `bcryptjs@2` and a mirrored
`packages/db/prisma/schema.prisma` four levels above `src/mfa` (the new Prisma-column guard reads it).

```bash
node --import ./ts-hooks.mjs --test src/mfa/loginOtp.test.ts
node --experimental-test-module-mocks --import ./ts-hooks.mjs --test src/mfa/loginOtpRoutes.test.ts
node --experimental-test-module-mocks --import ./ts-hooks.mjs --test src/mfa/mfa.test.ts
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/mfaLogin.test.ts
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/turnstileWiring.test.ts
```

**Results:** api rules+guards **19/19**; api routes end-to-end **14/14** (incl. enable/disable
with real bcrypt, the password throttle, and 404s for the removed admin + trusted-device
routes); TOTP suite **25/25** (status now also reads `loginOtpEnabledAt`); portal `mfaLogin`
**12/12**; `turnstileWiring` **13/13**. ⏳ `tsc` not run (unavailable here).

---

## Sign-in code v2 — text-or-email choice, once per sign-in, no expiry (2026-09-08)

Branch `feat/ivr-migration-takeover`, **NOT deployed** (Izzy: preview first). Handoff
`AGENT_HANDOFF_LOGIN_OTP_V2_CHOICE_2026-09-08.md` §5.

Dev-box harness (pnpm store unreadable): `apps/api/src` copied to the scratchpad,
`@connect/*` + `@prisma/client` stubbed, `fastify@5 @fastify/jwt@9 zod@3` installed,
Node 26 type-strip + resolve/load hook.

```bash
node --import ./ts-hooks.mjs --test src/mfa/loginOtp.test.ts
node --experimental-test-module-mocks --import ./ts-hooks.mjs --test src/mfa/loginOtpRoutes.test.ts
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/mfaLogin.test.ts
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/turnstileWiring.test.ts
```

**Results:** api rules+guards **20/20**; api routes end-to-end **13/13** (one wrong
expectation fixed in the test: an unsigned call to the removed trusted-devices route is
the JWT hook's 401, a signed call is the router's 404); portal `mfaLogin` **12/12**;
`turnstileWiring` **13/13**. ⏳ `tsc` not run (unavailable here).

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

## 2026-09-14 — desk phones: factory reset first (plan §20h)
- shared `src/deskPhoneSetup/*.test.ts` (node --import tsx --test): 183/183
- desktop `src/phoneSetup/*.test.ts`: 143/143
- api `src/deskPhoneSetup/*.test.ts` (--experimental-test-module-mocks): 157/157
- portal `components/deskPhones/*.test.ts`: 73/73
- typecheck: shared 0, desktop 0 (own TypeScript), portal 0, api 84 = baseline, none in edited files

## 2026-09-14 — Dashboard design concept

Manual Chrome verification: standalone visualization rendered, layout inspected, Overview/By direction toggle showed the observed Gesheft totals and restored correctly. No automated suite or production deployment; responsive viewport and host design controls not tested. See AGENT_HANDOFF_DASHBOARD_DESIGN_CONCEPT_2026-09-14.md.


## 2026-09-14 — Existing dashboard polish mockup

Manual Chrome check: fragment rendered through visualize wrapper; layout inspected; call-status help expanded and displayed expected text. Source/readback checked; chart uses bounded segment control points to avoid negative counts. Responsive viewport and host-only Tweak controls not browser-tested. No runtime application changes or deployment.


## 2026-09-14 — Dedicated light dashboard mockup

Read-back and wrapper render succeeded; Chrome screenshot/accessibility inspection verified fixed light surfaces and consistent blue incoming / purple outgoing / teal internal colors. No production theme change or deployment. Dark mode not tested.


## 2026-09-14 — Dashboard polish implementation, both themes

PASS: 4 chart/date regression tests (bounded cubic values, empty/single points, width-adaptive endpoint ticks, exclusive end/timezone/DST date caption). PASS: full portal tsc --noEmit --incremental false. PASS: Next development /dashboard compile + HTTP 200; Chrome light/dark card-to-chart color parity, live direction badges, help open/Escape, 390px dark chart endpoints and recent-message layout. Restricted tsx first failed OS user lookup; elevated tsx and transpiled node tests both passed. Production build/deployment pending; see dashboard design handoff for final results.

Build checkpoint: Next production webpack compilation passed, then its type phase failed on another agent's untracked packages/shared/src/deskPhoneSetup/deviceMechanisms.ts importing a nonexistent VendorSlug. This file and its related dirty desk-phone files are excluded from this dashboard commit. Earlier full portal typecheck passed before those concurrent edits appeared. Production release build must verify the clean committed source. Light-mode 390px check also passed without horizontal page overflow; mobile presets wrap and Recent Messages uses a compact unread badge.

Final release PASS: portal f2460c4f, dry run d862f0de and real job 2e769464. Production build/type validation/185 static pages passed; candidate and stable/public readiness, container commit-marker verification, final upstream :3000, done f2460c4f. Live Chrome checked light/dark color parity, actual 7/30-day date captions, flat zero plateau/full endpoint, Recent Messages count/scope, and Enter/Escape help. Live light and dark 390px have no page overflow and wrap controls. Extra manual container unique-code grep unavailable; release-script docker exec commit check and fresh live compiled UI provide the recorded proof.

2026-09-14 dashboard voicemail layout: PASS portal tsc --noEmit --incremental false and git diff --check. Actual React component + processed production CSS in Chrome: light/dark desktop and 390px, all six populated rows 46px and aligned, no overflow/leading separator/play icon; empty/loading/unavailable and accessibility unread text verified. Production rollout pending.

2026-09-14 dashboard voicemail release PASS: 7d12c14f; dry run 0f33571d and real portal job 477e8dce. Full production build/types/pages, candidate and stable readiness/public checks, container commit-marker verification and done SHA passed. Live empty card/count/scope/centering checked light/dark and restored light; populated/mobile proof is actual-component fixtures. Manual container unique-code grep unavailable.

## 2026-09-14 — Browser Companion (local, unfinished)

Resume verification, 19:49 EDT: Coworker suite **43/43 PASS**; `node --test apps/desktop/scripts/browser-companion/security.test.mjs` **3/3 PASS** (one-use exact approval binding, extension schema, HMAC/challenge); DOM components **10/10 PASS** in isolated installed Chrome (new CSS-hidden redaction and changed form/link approval refusal). TS6.0.3 typecheck and build **PASS**, with no tsconfig override. Generated extension schema was refreshed. These are component/security checks, **not actual extension or natural-language agent acceptance**. Loopcom dashboard access recovered. Windows tool stopped Chrome Extensions selection due inability to verify the current URL for policy enforcement; no installation or further UI input occurred.

- Fresh baseline: node --import tsx --test apps/desktop/src/coworker/*.test.ts — 39/39 PASS, elevated execution after restricted tsx userInfo ENOMEM.
- After implementation: same suite — 43/43 PASS, including real loopback auth/replay/correlation/cancellation tests and mandatory browser approval profiles.
- Desktop tsc --noEmit and emitted build with --ignoreDeprecations 5.0 — PASS (installed root TS 5.9; repository expects TS6).
- worker.js, page.js and portal.mjs node --check — PASS.
- node apps/desktop/scripts/browser-companion/dom-components.mjs — 8/8 PASS in isolated installed headless Chrome with sandbox enabled; first run 7/8 exposed select-label defect, fixed and all rerun green. NOT actual agent acceptance.
- electron-builder --win --dir --publish never --config.electronVersion=41.5.0 — unpacked package produced, but dependency diagnostics mean clean-export + asar smoke checks still required. No installer/install/deploy.
- Real application UI: nginx 403 Forbidden. Owner reports independent repair in progress. Subsequent Windows Computer Use stopped with physical Escape; no more UI actions.
- Full handoff: docs/ai-context/AGENT_HANDOFF_BROWSER_COMPANION_2026-09-14.md. No Claude/OpenAI real-agent Chrome acceptance, packaged acceptance, vision, sustained stress or complete security matrix proven.

## Deploy autoban production acceptance (2026-09-14)

- Runtime fix commit **dae5a2451fbe404da512ea1dc9547889013e904b**, pushed to origin/feat/ivr-migration-takeover and origin/codex/deploy-log-safety. Deploy Center UI used as queue fallback; SSH stayed read-only after the separately approved unblock.
- API dry run `1396ed9c-8120-4e1d-83f9-f3ef344c794e` passed checkout safety. Real job `d460c9aa-eaf7-4b2a-934a-a542396cdc74` succeeded at 23:17:51 UTC; log ends `[deploy-api] done dae5a245`. Running app-api-1 /app/.build-commit matches the full SHA and the new route source marker is present.
- Portal dry run `32ec34b1-5971-4e86-a0a0-d79eaad8c2cb` passed. While it waited behind the API, the OLD live UI displayed the new waiting response. Nginx recorded **8 log requests, all 200**, 23:16:01-23:16:22 UTC. This directly verifies backward compatibility for the incident trigger without a synthetic request flood.
- Portal queue job `3580e071-e686-4cbc-8e48-6d56b49ba3b7` safely stopped at the build lock because another direct portal release was already running. No blind retry: inspected the active process and `/var/log/connect-deploys/direct-portal-20260914T231756Z.log`. That release targeted **68cac2f46caa957df961510252372a3359ed9471**, a direct descendant of our commit, so a separate older deployment was unnecessary.
- **Concurrent-clone caveat:** the direct release stamped 68cac2f4 but its final done line printed dae5a245 (the shared checkout was advanced/reset by the queue attempt while the direct build ran). This line alone does not establish the live version. Extra verification confirmed stable app-portal-1 /app/.build-commit = 68cac2f4, the compiled Deploy Center fix in `page-28a1c4235637ef04.js`, AND the descendant desk-phone `awaitingSerial` marker in its live chunk. Both changes are preserved in the stable container. The scripts' shared-clone concurrency/log-SHA discrepancy is a separate unresolved deployment concern; do not infer that queue runningCount=0 means no direct deployment is active.
- Both blue/green rollouts completed health checks and normalized upstreams to API **3001**, portal **3000**. Portal finished around **23:27 UTC**. Fresh Chrome load shows **Updates every 10s while visible**. Opening the completed preflight log at 23:28:02 UTC displayed its real log and produced exactly one additional 200 request over >30 seconds, with no terminal auto-polling.
- At **23:27:40 UTC**, office IP absent from denylist; latest five-minute access window **zero 404s**, following the earlier full window at 23:21:52 with no renewed ban. Other permission/validation responses are not misrepresented as a clean all-200 traffic stream. Both public login URLs and API health returned **200**; the protected internal tenant-map URL remained **403** from outside the server. No security thresholds or allowlists changed.
- Prior validation remains 15 focused tests + 6 PBX safeguards passed; portal typecheck and production builds passed. Whole-API typecheck still has 84 pre-existing diagnostics. Profile menu visually checked in light/dark; original light setting restored. Real extension DND incoming-call acceptance still requires an owner-chosen test extension.

## 2026-09-14 — Desk phones: no password, the serial is asked on the extension screen

- `packages/shared` `npm test` — **709 pass, 0 fail** (run twice: after the `deviceMechanismsFor` precedence flip, and again after the `usesCloud` fix). Includes the rewritten precedence tests (cloud primary / `resetFallback: "lan_http"`) and the rewritten sweep invariants (a fallback is never the primary's own door, never offered with no primary, `lan_http` only where a local reset executor really ships).
- `apps/api` `node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/*.test.ts` — **250 pass, 1 skipped, 0 fail.** `deviceCloudRoutes.test.ts` alone: 36/36. The ticked-Grandstream test was rewritten to expect `via: "vendor_cloud"` + `provisioningUrl`; "no password → the cloud route is offered" and "no password AND no serial → honest hands-on halt" both still pass, the first now through the new halt→cloud conversion.
- `apps/portal` `node --import tsx --test components/deskPhones/setupDriver.test.ts components/deskPhones/deskPhoneWizardSource.test.ts` — **44 pass, 0 fail.**
- Portal `tsc -p apps/portal/tsconfig.json --noEmit` — **exit 0, clean.**
- API `tsc -p apps/api/tsconfig.json --noEmit` — errors reported, **none in any file touched this round** (only `ops/`, `billing/`, `delivery/`, `mfa/`, `storageMaintenance/`, `apiRequestProfiler`); this matches the 84 pre-existing diagnostics recorded in the entry above. The only api file changed here is `deskPhoneSetup/deskPhoneRoutes.ts`, which reports nothing.
- ⏳ **NOT PROVEN:** nobody has typed a serial on the extension screen in a browser, and no phone has been cleared through GDMS from one. Deployment recorded separately below/after.
- **Deployed and container-verified** `6cae33e2`: `app-api-1` and `app-portal-1` both report `.build-commit` = `6cae33e2`, 0 restarts, running; `serialOnFile` present in the shipped portal chunks. ⛔ A first probe read `0` for the api change because it grepped a `/app/apps/api/dist/…` path that does not exist — the container runs TypeScript from `/app/apps/api/src/…`. Re-checked there: `laddersPasswordQuestion` ×2, `condition.locked && condition.passwordUnavailable` ×1, `serialOnFile` ×1. A grep reading 0 is not evidence of a failed deploy until the path is confirmed.

## 2026-09-14 — Desk phones, parts 2 and 3: the label as a photo (uploaded or texted)

- `apps/api` `node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/*.test.ts` — **262 tests, 261 pass, 1 skipped, 0 fail**, including 11 new photo/text tests and a re-run of the route-order security guard against the three new run-scoped routes.
- API `tsc -p apps/api/tsconfig.json --noEmit` — **no errors in any file touched** (`deskPhoneSetup`, `docOcr`, `chatAttachment`); the rest remain the documented pre-existing 84.
- `apps/portal` `node --import tsx --test components/deskPhones/setupDriver.test.ts components/deskPhones/deskPhoneWizardSource.test.ts` — **44 pass, 0 fail**.
- Portal `tsc --noEmit --incremental false` — clean apart from one error in `app/(platform)/voicemail/page.tsx`, which is another session's in-flight file, not this work. (`--incremental false` also avoids dirtying the tracked `tsconfig.tsbuildinfo`.)
- **A test caught a real defect, not a typo:** `label-photo/expect` validated `fromNumber` with `z.string().min(7)`, so a short typo answered a bare `invalid_request` with no sentence and the browser fell back to its own vague wording. Fixed to `min(1)` with `normalizeUsCanadaToE164` as the single judge, which always returns the "enter the 10 digits" message.
- **Harness changes:** the fake db's `matches()` now really compares `gte/gt/lte/lt` — it previously returned `true` for every unrecognised object filter, which would have passed the "a photo that predates the request is never used" test while the real query did the opposite; `makeApp` registers `@fastify/multipart` (as `server.ts` does) so the upload path is exercised for real.
- ⛔ **The OCR engine is FAKED on purpose.** What these tests prove is our judgement of a picture (the confidence bar, the MAC-corroboration rule, the refusal wording), not Tesseract's accuracy. ⏳ **No real photograph has ever been OCR'd here**, and nobody has uploaded or texted one.
- ⏳ Both doors are **inert in production until `CRM_OCR_ENABLED=true`** on the api — with it off they answer `photo_reading_off` and store nothing.

### Browser Companion second resume — 2026-09-14 20:04 EDT
Clean NSIS build PASS from isolated production dependencies (Electron 41.5.0). ASAR payload presence checks 5/5 PASS; exact candidate embedded icon PASS (7/7 frames). Installer SHA256: 29A6CD35CE9253FAAE424957356B602A31EE53A9A09003F7A32173AFCAC14E26. node --test apps/desktop/scripts/browser-companion/portal.test.mjs: 1/1 PASS, actual binary file hash and cross-origin rejection. Script syntax checks PASS. No installation/pairing or real-agent acceptance; Windows tool again refused chrome://extensions URL-policy verification.

## 2026-09-14 — Universal search

24 passing search/catalog/PBX safeguard tests via `node --import tsx --test --test-concurrency=1 apps/api/src/globalSearchRoutes.test.ts apps/portal/lib/globalSearch.test.ts apps/api/src/pbxMutationSafeguard.test.ts`. Windows tsx required execution outside the sandbox because `os.userInfo()` failed within it. Light/dark actual-component browser fixture inspected with settings/record navigation and company clearing. API full typecheck has pre-existing errors; no search-module diagnostics. See universal-search handoff for final release/typecheck evidence.
