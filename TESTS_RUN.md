# Tests run

## Gesheft pay line — the stray pound / "no input is not a wrong answer" — 2026-09-18

- apps/api NEW `src/supermarket/payLineNoInput.test.ts` **7/7**: the real 06:49 ET call (C-00000024) replayed through the real runtime + FakePos (2 → 10 digits → "" → hears ONLY `02_pin`, `pinAttempts` 0 → PIN serves); three silences → a person with no "too many tries" and 0 PIN attempts (wrong PINs still cost one); silence/wrong interleaving; every gathering phase replays exactly its own prompt with no attempt spent and no register effect; probe-in-flight / card_entry / human / done / no-cards card_choice keep their branches; legacy rows normalise; 400 callers × random silences all served + 400 × three-in-a-row all handed over.
- `src/supermarket/payIvrDialplan.test.ts` **13/13** (+3 NEW source guards: the gather block's timed single `Read()` + one bounded local re-ask under 6 s that never CURLs; the card block posts `${PAY_CARD}` as the next step's digits; the AGI's `collect()` branches on empty inside `STRAY_WINDOW_S`, never plays `45_card_invalid` for a silence, `GET_TIMEOUT_MS = 10000`). **Replayed against HEAD's conf + AGI (git stash): 10 pass / 3 fail — all three new guards red.**
- The whole `src/supermarket/*.test.ts` glob **248/248** (238 before + 10 new).
- `python3 scripts/pbx/supermarket/connect-pay-card.selftest.py` **9/9** (fake AGI pipe + fake clock: stray re-ask once uncounted, silence replays without "invalid", 3 silences give up, 3 wrong give up with 3 "invalid", mixes, hangup).
- api `npx tsc --noEmit`: 0 errors in `src/supermarket/*`; the ~20 listed errors are pre-existing in billing/delivery/ops/mfa.
- Live measurements (read-only, before the change): door step latency 0.04–0.62 s; PBX→api 0.39–0.47 s incl. TLS.
- ⏳ NOT run here: a human call keying `10 digits + #` and hearing only the PIN prompt; the AGI card flow with `MMYY + #`.

## GDMS redirect for Grandstream (round 24) — fence + honest delivery — 2026-09-18

- apps/api NEW `gdmsRedirect.test.ts` **15/15**: P237/P47 host parsing off the real config shape; the private/VPN/loopback/CGNAT gate (10.8.0.1 = the proven bug) ; no-P237 refused; look-alike public hostname refused; bare public IP passes; deliverRedirect → delivered / queued_offline / not_claimed / refused-without-pushing; deviceStatus reads online+synchronized.
- `deviceCloudRoutes.test.ts` +2 (VPN-targeted render → fence refusal REPORTED, 0 cloud calls; offline phone → 'waiting for the phone to check in' words, still pushed for GDMS to hold); existing SEND/pushConfig tests updated to the real fenced config shape (they encoded the pre-fence contract).
- Full `src/deskPhoneSetup/*.test.ts` **381: 380 pass, 1 fail = pre-existing `managedPhonePostgres.test.ts` (local Postgres only)**. `npx tsc --noEmit`: zero errors in every touched file (gdmsRedirect, gdmsClient, grandstreamProvider, gdmsSimulator, deviceCloudRoutes).
- Research (read-only): Grandstream's machine-readable OpenAPI (doc.grandstream.dev api_data.json, 41 endpoints) confirms NO site/template-level redirect API exists — per-device `device/config/xml` is the only API redirect; the account-wide template is web-console-only.
- DEPLOYED 2026-09-18: api `deploy-direct.sh api --commit bffc5ea6` (origin tip), `.build-commit` = `bffc5ea6`, 0 restarts, healthy, health 200 both hostnames; fence + deliverRedirect grepped in the running container.
- NOT proven: a factory Grandstream claim→check-in→redirect→register hands-off (needs the handset).

## Desk-phone wizard round 23 — the hidden robot + OpenAI brain + auto RPS release — 2026-09-17 (night)

- LIVE PROOF: a Playwright headless-Chrome prototype logged into the factory T42S (192.168.6.170, admin/admin), wrote the Landau `/phoneprov/a70274ea0f143ca0/` folder into AutoProvisionServerURL, triggered autoprovision; PBX nginx logged `805ec0b3b2d0.boot`+`.cfg` 200 (UA `Yealink SIP-T42S`) and the mirror shows **T21_101 REGISTERED** — 65 s, no human step after the reset.
- desktop `node --import tsx --test src/phoneSetup/*.test.ts` **214/214** (46 new phoneWebRobot + fence-hardening; baseline was 167). tsc 0.
- api `phoneRobotRoutes.test.ts` + `yealinkMacRemoval.test.ts` + `deviceCloudRoutes.test.ts` + `deskPhoneRouteOrder.test.ts` + `yealinkRedirectClaim.test.ts` **140/140**; api tsc 0 in every touched file.
- portal `setupDriver.test.ts` **53/53** (7 new round-23 + fence-allowedUrl guard); portal tsc 0.
- agent `phoneRobotAdvisor.test.ts` **9/9**; router `phone_web_robot` task added; agent tsc: the `unref` errors in server.ts are pre-existing (14 in origin, unchanged), none in touched files.
- Fence hardening replayed: a bare hostname (no scheme) and any fill into a server/URL-named field are refused in BOTH the desktop op and the `/robot-advise` endpoint (tests in each).
- DEPLOYED: see the desk-phone summary file after container verification.
- NOT proven: the wizard (not the prototype) end to end; playwrightRobotBrowser against a real handset; the improviser on a real unknown screen; a real Yealink MAC-removal filing.

## Desk-phone wizard round 22b — Try again forgets the lock; conflict note never clobbers a halt — 2026-09-17 (evening)

- apps/api `yealinkRedirectClaim.test.ts` + `deviceCloudRoutes.test.ts` + `deskPhoneRoutes.test.ts` **154/154** (+2: a halted row's note is never overwritten; somebody else's note is never overwritten).
- apps/portal `setupDriver.test.ts` + wizard tests + `lib/deskPhoneWizard.test.ts` **97: 96 pass, 1 fail** (+2: retried() forgets locked/passwordUnavailable/defaultCredentialsTried; keeps a typed credentialRef; the 1 fail = the documented pre-existing standing-listener test). Portal `tsc` **0**; api tsc: 0 errors in touched files (pre-existing elsewhere).
- Live evidence that motivated it: desktop log 21:26:40/52Z `factory_reset … refused:locked` then nothing; 14 `DESK_PHONE_RETRY` audits 21:27–21:33Z each followed by a halt in <1 s; the phone pinged continuously (never rebooted).
- DEPLOYED 2026-09-17 ~21:55Z: api + portal `deploy-direct.sh --commit 64746df2` (origin tip), both `.build-commit` = `64746df2`, 0 restarts, health 200 both hostnames; guard + `.retried(` grepped in the containers.

## Desk-phone wizard round 22 — office-wizard Yealink RPS claim + scan-page canary — 2026-09-17

- apps/api `node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/*.test.ts` **328: 327 pass, 1 fail** (the fail = pre-existing `managedPhonePostgres.test.ts`, needs a local Postgres; baseline before this work 291/290/1). New: `yealinkRedirectClaim.test.ts` 23, `managedPhoneIntegration.test.ts` +8, `deviceCloudRoutes.test.ts` +10 (+3 claim, +7 scan mode / decoderExpected).
- packages/shared `node --import tsx --test packages/shared/src/deskPhoneSetup/*.test.ts` **228/228** (+1: Yealink `claim` in supportedActions never flips reset/restart to vendor_cloud).
- apps/portal `npx tsx --test components/deskPhones/*.test.ts lib/deskPhoneWizard.test.ts app/phone-setup/decoderSelfTest.test.ts` **131: 130 pass, 1 fail** (the fail = the documented pre-existing "standing provisioning listener — desktop full window only" test, unchanged). `decoderSelfTest.test.ts` alone 11/11 incl. a REAL zxing-wasm decode of the built-in PNG.
- apps/api `npx tsc --noEmit -p tsconfig.json`: **689 errors before, 689 after, 0 new** (sorted line-list diff; all pre-existing in packages/db + elsewhere). apps/portal `npx tsc -p tsconfig.json --noEmit` **exit 0**. `bash -n scripts/deploy-portal.sh` OK.
- Desktop `pnpResident.test.ts` + `pnp.test.ts` **41/41** (baseline, untouched).
- Live read-only proofs (no code): office PC resident heard a synthetic multicast SUBSCRIBE in 5 ms; YMCS RPS token + server list + 0 devices from inside `app-api-1`; PBX cfg for the T42S fetched and compared field-by-field to the working T53W (identical shape).
- DEPLOYED 2026-09-17 ~16:07Z: api + portal `deploy-direct.sh --commit e6adad6b` (origin tip), both `.build-commit` = `e6adad6b`, 0 restarts, health 200 both hostnames; new source/strings grepped in both containers; CSP wasm-unsafe-eval live; the new portal verify stage passed.
- NOT proven: any phone claimed through the new door against real RPS; a factory-fresh Yealink registering end to end.

## Yiddish24 outage no longer pauses the 24/7 listen — 2026-09-17

- apps/api `src/yiddishCorpus/*.test.ts` **172/173** (4 new: 524 = unavailable not BLOCKED; challenge-on-5xx still BLOCKED; 403/503 still BLOCKED; outage runs never count empty/pause). The 1 failure = routes.ts audio-mode source guard, CRLF artifact on Windows, file untouched.
- Deployed api `7c2554c8`: container commit matches, `Yiddish24Unavailable` present, 0 restarts, discovery DONE 11:31/11:36 UTC, budget unpaused.

## Creative Studio native selects → ConnectSelect — 2026-09-16 (night)

- portal `lib/nativeSelectSweep.test.ts` + `lib/dropdownOutsideClose.test.ts` **5/5** (sweep was failing on audio:254/302, images:205, storyboard:251/289 before `a3768b14`).
- portal `npx tsc --noEmit -p tsconfig.json` **exit 0** (the first run errored only on `LaybelVideoCall.tsx` → `@anam-ai/js-sdk` missing from the worktree's node_modules; `pnpm install --frozen-lockfile --filter ./apps/portal` fixed it, not a code error).
- DEPLOYED: `deploy-direct.sh portal --commit a3768b14` success; live `.build-commit` = `dcef71a9` (a later session deploy that contains `a3768b14`), 0 restarts; shipped chunks for creative audio/images/storyboard have 0 native `select` and all five ConnectSelect `ariaLabel`s; the three routes 200.
- NOT proven: a human picking a value in any of the five dropdowns.

## Texting switcher (VoIP.ms → Telnyx on landing) — 2026-09-16 (night)

- apps/api `src/textingRegistration/switcher.test.ts` **13/13** (new): not-on-Telnyx and port-pending left alone; landed+live → profile set, flipped, History event without a carrier name, registration kicked, engine attach list includes it; chosen profile never overwritten; only VOIPMS rows with a tenant (0 Telnyx reads otherwise); concurrent sweeps flip/record/kick once; draft / no registration; one error isolated; no creds = no reads; guards: VoIP.ms DID sync never writes provider, VoIP.ms poll selects VOIPMS, switcher's only write.
- Mutation: removing `provider: "VOIPMS"` from the flip's where → 2 FAIL (exactly-once + write guard).
- `src/textingRegistration/*.test.ts` **54/54**. tsc on switcher/wire/test: 0 errors (pre-existing elsewhere only; full api tsc blocked by another session's uncommitted `deviceCloudRoutes.ts:1523` syntax error).
- Prod dry run before deploy: 18 VOIPMS rows, none active on Telnyx (Telnyx owns 723-1213 port-pending, 460-9054, 777-4807, 306-6825 active).
- DEPLOYED: api `56879d0f` (`.build-commit`, 0 restarts, health 200, `TEXTING_SWITCHER_ARMED`); after first run 21:31Z: VOIPMS 18 / TELNYX 1 unchanged, 0 audit rows.
- NOT proven: a real landing → flip → campaign attach → text sent/received.

## 10DLC "texting is on" email could never queue — fixed (2026-09-16)

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test src/signalwire/*.test.ts` → **41/41 pass**
  (1 new: activation EmailJob payload valid against `schema.prisma` — status omitted/QUEUED, tenantId required,
  own type not ADMIN_ALERT, no carrier name; the fake db now validates every EmailJob create). Against the
  pre-fix `signalWireTenDlc.ts` the same file fails **2** (the new test + the existing activation test).
- `tsc --noEmit` (apps/api): 0 errors in touched files (51 pre-existing elsewhere: yiddishCorpus, webrtc*, packages/db).
- Live DB read-only: 0 `SMS_REGISTRATION_ACTIVE` EmailJobs, 0 `TenantSmsRegistration` rows.
- Deployed api at origin tip `56879d0f` (contains fix `966c9110`; waited out a peer portal build first). Container `.build-commit` = `56879d0f`, fix is an ancestor, `signalWireTenDlc.ts` in the container has the QUEUE_FAILED log and no `status: "PENDING"`, 0 restarts, health 200.

## Laybel live reply failure and Yiddish Labs microphone wiring — 2026-09-16

- CONFIRMED LIVE FAILURE: owner transcripts present; agent requests req-8ou/req-8p1 at 16:49Z return 500, Prisma invalid AgentChannel VOICE. Agent health 200 did not prove chat. Portal observed build 47584ef643ec9a5f68867a9546824ee2fa9f18bd.
- PASS: 74 Assistant tests across auth/authRoles; conversation store, voiceTranscribe, speechRoutes, engine, engine.bridge, engineTools, engineIdentity, engineCoworkerWorkspace; llm speechStream. Includes actual Prisma store mapping checked against schema enum, YL-only STT JWT/audio validation/concurrency, strict translation failures, English speech/Yiddish chat and tool isolation/no replay.
- PASS: 31 portal tests in lib/laybelMic.test.ts, lib/laybelSpeech.test.ts, components/floatingAssistantOpening.test.ts. Uses actual worklet source in VM for bounded capture/overflow/mute, canonical WAV, VAD ID pairing, late-end cleanup, serialized STT, duplicate protection and safe failures.
- PASS: final portal tsc --noEmit --incremental false --types node,react,react-dom (exit 0), and Agent tsc with --moduleResolution bundler --module esnext (exit 0). Prior default agent resolver errors remain unrelated and are not claimed fixed.
- Test maintenance: fixed timing race in new concurrency test (explicit entry signal + timeout); updated static onTurn assertion for added language metadata. Final suites green. No production build/deploy, live YL audio round-trip, hardware microphone test, audible reply proof or latency improvement claimed.
- Release remains local while explicit GitHub push approval is pending. Full evidence/resume checklist: AGENT_HANDOFF_FACE_TO_FACE_AI_SUPPORT_2026-09-15.md.

## Laybel streaming latency implementation — 2026-09-16

- Final repeat portal typecheck PASS. Release bb16c34b remains local: auto-review rejected the two-branch GitHub push; owner approval requested. No production build/deploy or live speed comparison occurred.

- PASS: 76 agent tests (auth/roles, engine/identity/workspace/bridge/tools, streaming router and real local HTTP streaming). Includes early final speech, no commentary/unphased/tool speech, no partial-answer failover/tool replay, verified tenant identity, and English speech before YL output translation.
- PASS: 23 portal tests (Assistant/layout/consent/takeover, incremental UTF8 NDJSON, sentences, early speech, barge-in and failure no-retry).
- PASS: portal typecheck. Agent default typecheck reports pre-existing packages/db shared-subpath module-resolution errors; new test schema type fixed. Agent typecheck with --moduleResolution bundler --module esnext passes. Default configuration is not claimed green.
- Pending: deployment/build and live before/after audible latency evidence. No performance improvement claimed from synthetic tests.


## Onboarding cold-calling / CRM pricing + phone-wizard step-1 fix — 2026-09-16 (night)

- apps/api `src/onboarding/*.test.ts` **475/500**; the 25 failures (24 setupOrchestrator + 1 pbxTenantBuild) are identical on HEAD (all 11 touched files swapped to HEAD and re-run: 7/24). New `onboardingAddOnPricing.test.ts` 8/8 (quote math all/partial/clamp/plain $35, autosave cannot set/change/clear pricing, admin shape, month-2 lines, /quote route prices add-ons). `inviteEmail.test.ts` gate guard widened to put/patch, passes.
- packages/shared `onboardingPricing.test.ts` 16/16. portal `lib/onboardingSignalWireWizard.test.ts` 9/9 (new guard for the step-1 re-route). tsc 0 errors in touched api/portal files.
- DEPLOYED `014c0399` api + portal (`.build-commit` both; grep `onboarding_addon` in api; phone-fix + admin checkbox strings in shipped `.next/static` chunks; /admin/onboarding 200).
- LIVE: Swift Mechanics stamped cold calling all + CRM all; public `/onboarding/<token>/quote?extensions=1|2|3` → **$90 / $175 / $260**.
- NOT proven: an autosave after the stamp keeping pricing; the real checkout invoice; month-2 lines; admin checkboxes in a browser; phone fix on a real phone.

## Telnyx port of 845-723-1213 + ported-number owner guard — 2026-09-16 (night)

- apps/api `telnyxOnboarding.test.ts` **50/50** (new: owner-guard source checks incl. read-failure = build fails and check-before-job ordering; landing with `portedDidExistingPbxTenant` makes no PBX/caller-ID/publish/texting change). setupOrchestrator 7/24 unchanged. tsc 0 in touched files.
- Deploy: `e0e1ef28` shipped in api tip `6c2ef93e` (2 queue runs failed on other sessions' heavy-job locks, 3rd succeeded; `.build-commit` + grep verified, 0 restarts, health 200).
- LIVE: VoIP.ms `getInvoice` → PDF text verified (number present, account number absent); bill uploaded via wizard (200); submission paid (DB, no card) → temp +18454609054 bought, Telnyx FastPort order 58969290-… SUBMITTED (foc 2026-09-18T11:00Z), guard fired, PBX build done; PBX read-back: `ombu_tenant_dids` (35, 8457231213) only, default-trunk `_8457231213 → Loopcom tenant`.
- NOT proven: Telnyx document acceptance, the actual switch-over, calls on 723-1213 via Telnyx, the landing on a real port.

## Private contacts per user — 2026-09-16

- apps/api `src/contactVisibility.test.ts` **7/7** (new): rule unit tests (shared+mine, no viewer = shared only) + source guards for /contacts list, every :id route, dup check + import merge, ring/missed-call caller name (required viewer), search, assistant, chat decoration, SMS→email, CRM gate/import/SMS hooks, blasts, migration backfill, no-FK schema.
- Guard replay: `PORTAL_GUARD_ROOT=<worktree at pre-fix HEAD>` → 2 pass / **5 fail** (non-vacuous).
- apps/api crm + supermarket + agentProvisioning + globalSearch suites **1016/1016** (after fixing STRESS 19 fixture to seed `ownerUserId: null`, the real column default); `inboundCallerMatch.test.ts` guard updated to the new signature.
- apps/agent `notify/smsEmail*` + `tools/contactsTools*` **88/88**.
- tsc api/worker/agent: no errors in touched files (pre-existing unrelated errors only).
- LIVE (deployed api, minted tokens in app-api-1): GET /contacts → 101 external **4250**, 102 **0**, 103 **0**; /internal/agent/contacts-info → 101 4250, 102 0, no-user 0. api 34ff3aae / worker e0e1ef28 / agent e0e1ef28 grepped in-container, 0 restarts.
- NOT proven: human opening the app on 102; a real inbound call name check; SMS→email + CRM live.

## 10DLC texting registration (customer link → File with Telnyx) — 2026-09-16 (evening)

- apps/api `src/textingRegistration/textingRegistration.test.ts` **41/41** (new, registered in the api test glob): carrier wording passes every filing check (incl. awkward/140-char names); wording/policy/terms/emails never name a carrier, price or marketing; Izzy's exact invite copy; policy in the LEGAL name with no-sharing wording; checks catch every published rejection cause; customer-answer validation; EIN token (bound to its registration, no plaintext, masked, TTL); link tokens; brand/campaign/assignment phase mapping (unknown never approves); client vs FAKE fetch (EIN digits, sole-prop no EIN, referenceId/subscriber flags/policy links, three error shapes, timeout sent once); webhook id extraction; limiter; ENGINE vs in-memory DB + simulated registry — whole happy path (each creating write once, EIN destroyed on verification, usecase spelling from live enum, ready email once), 10 simultaneous File presses → 1 brand/1 campaign/1 charge, two tabs submitting → 1, link revocation/expiry, brand-create timeout reconciled by name (never resent, charged once), never-appearing create → error for a person, refusal → back to Ready with no charge, campaign-create timeout reconciled by referenceId, brand not verified → send back ONLY refused fields → customer can't touch locked fields → brand UPDATED not recreated, campaign rejected → staff edit → appeal → live, sole proprietor PIN (capped wrong attempts, resend resets), wizard-registered tenant refused, non-Telnyx numbers never attached, 14-day EIN purge, deactivate; **STRESS 300 customers** with duplicate presses + racing sweeps: all live, exactly 300 brands/campaigns/assignments/charges/ready emails, zero EINs left; source guards (charge path has no period dates / no "monthly service", server wiring + permission prefix, anchored JWT bypass, every admin route gated, EIN token never selected, nav + six keys + SUPER_ADMIN force line + Locked, customer pages have no carrier name or price).
- ⛔ One real race found by the stress run and fixed before commit: concurrent checks on one registration could send two number assignments → per-registration in-flight lock in `advanceRegistration`.
- apps/api `publicReadyJwtBypass.test.ts` + `src/telnyx/*` **81/81** with the new bypass case; packages/shared **710/710**; portal `permissionToggleCoverage` + `navVisibility` pass; portal `nativeSelectSweep` FAILS on Creative Studio pages built by another session (not these files — task chip spawned).
- api tsc: 0 errors in any new file (49 pre-existing elsewhere, 6 in server.ts on unrelated lines). portal tsc: **0 errors**.
- Full api suite: 4604 pass / 220 fail — 180 are `deskPhoneSetup/*` failing to TRANSFORM `deviceCloudRoutes.ts:1523` (another session's uncommitted half-edit in the shared tree), 24 setupOrchestrator + 1 pbxTenantBuild (documented pre-existing), 7 pbxTenantDirectorySync, 1 publicOrigins, 1 yiddish routes — none touch this feature.
- DEPLOYED: api `34ff3aae` (blue/green done, container commit verified, textingRegistration files present, migration `20260916210000_texting_registration` applied — `prisma migrate status` "up to date", boot line `TEXTING_REGISTRATION_SWEEP_ARMED`, first sweep ran with no error); portal first build `06a77e7a` (contains 34ff3aae; pages present in .next, policy page server-renders the policy text on app.loopcom.net), then the CSS fix redeploy.
- LIVE PROOF inside app-api-1 on the "Loopcom Telnyx Test" tenant (never filed with Telnyx): board 200 / 401 without session / 403 for a TENANT_ADMIN (board + EIN reveal); create + prefill; link created; public view phase=form; draft stored no EIN; invalid submit → 422 with 6 field errors; **25 simultaneous valid submits → exactly 1 200** (others 409/410/429), one submitted event; EIN token row has no digits, registration row has no EIN, masked ••-•••6789, audited reveal matched; used link → 410 link_used; 30 checks pass, 0 fail, 1 warn (no Telnyx-hosted number); policy page 200 in the legal name; invite email built on the Loopcom shell and **actually SENT** to the test owner izzy+telnyx-e2e@loopcom.net (EmailJob SENT 19:14:27Z), no carrier name (the only "telnyx" string anywhere is that test address itself); **200 random tokens from 200 IPs → 200× 404 in 384ms; 90 from one IP → 60× 404 + 30× 429; 500 policy reads → 500× 200 in 722ms; 40 board reads → 200; 50 forged webhooks → 50× 401; junk bodies/unknown ids/path traversal → 400/404/401, never 500.**
- ✅ **REAL BROWSER (Izzy's Chrome, app.loopcom.net)**: the public form on a Loopcom Demo link rendered with the logo in light AND dark; empty Send → all 10 plain-English errors + focus on the first field; filled by keystrokes (ConnectSelect business type + searchable State) → "Thanks, we've got it"; admin board showed both registrations under Needs you with health (Telnyx connected, balance $124.71, re-check ran); review page showed source tags + checks + $24 breakdown; EIN Show revealed and wrote "EIN shown to staff" to history; Close registration (type the name) worked. Both test registrations CLOSED afterwards, 0 EIN rows left.
- ⛔⛔ **TWO BUGS ONLY THE BROWSER FOUND** (every test + typecheck + curl was green): (1) **the public form could not scroll** — the portal locks html/body overflow, so everything below the fold incl. Send was unreachable → `.tr-page` is now its own scroll container; (2) ConnectSelect sets width inline (160px) so State ran into ZIP → `!important` width. Plus a dead error-border selector. Fixed in the CSS redeploy below.
- CSS redeploys: `6c2ef93e` (scroll container — verified live: page scrolls to the bottom, Send visible) then `9a04bb2c` (the State dropdown still ran 9px into ZIP because ConnectSelect's `.cs-wrap` has min-width:160px > the 141px column → `min-width:0 !important`; verified in the shipped stylesheet). api still contains the feature after another session's api deploy (`6c2ef93e`). All 3 test registrations closed, 0 EIN rows.
- NOT PROVEN: a real filing with Telnyx (costs $24 + needs a real EIN) — brand verification, campaign review, number assignment, the ready email and the charge invoice have only run against the simulated registry; the live 10DLC enum spelling (read at first filing, cached); a real Telnyx 10DLC webhook delivery; the sole-proprietor PIN on a real phone; the customer form clicked by a human in a browser.

## Telnyx 911 postal form + owner alert + retry + FastPort — 2026-09-16 (evening)

- apps/api `telnyxOnboarding.test.ts` **49/49** (7 new: NY route/unit normalizer, validate→correct-once→validate incl. house-number guard and 85009, AgentEscalation alert de-dupe + never ADMIN_ALERT, retry schedule, sweep retry success/alert, route wiring + SUPER_ADMIN gate, FastPort earliest window / non-eligible untouched). pbxTenantBuild 39/1, setupOrchestrator 7/24, signalWireOnboarding 19/19 — unchanged. api tsc: 0 in touched files.
- LIVE: Telnyx validator probes (NY 17M → 85009; State Route 17M + Ste C → valid); retry on test number created the corrected address, then hit 10015 Emergency Terms of Service (account acceptance pending); sweep boot retry fired by itself; FastPort draft probe on +18457231213 (eligible, windows, requirements) deleted 204.
- Deploys: api `826f181c`, `42cccd3a` (queue, `.build-commit` + grep verified, 0 restarts, health 200).
- NOT proven: an actual 911 activation on Telnyx (blocked on ToS), the owner SMS content on a phone, a filed FastPort.

## Telnyx onboarding wizard switch — 2026-09-16

- apps/api `src/onboarding/telnyxOnboarding.test.ts` **42/42** (new): search mapping/refusals, 10031=empty, 429 burst retried + concurrency ≤4 + cache, Monsey alias, no statewide fallback, locality cleanup; provisioning dry-run (zero provider calls), live new number (one order → configure → CNAM → address → E911 active), resume-stored-order (no second order), adopt-if-owned, order timeout re-read (sent once), failed order clears stored id, pending_activation never "provisioned", connection by name/env/refuse, port = temp first + filing last + filing throw never fails the stage; filing draft→docs→PATCH→confirm, retry reuses order/doc ids, in-process never re-confirmed, refusal → needs_attention, PATCH body fields, requirements mapping; sweep landing order, caller-ID failure stops landing (no email), in-process recorded, refile only after number stage ready, pending 911 confirmed then email; autosave carry (provider/provisioning carried, texting NOT); source guards for every wiring point (dispatch, SMS gate, public routes, PBX shared trunk + temp CID, orchestrator Main re-save+apply, DB tenant lookup, full-table directory fallback, server sweep, registryFor, portal mapping, switch).
- Guard replay: every wiring string grepped at pre-change HEAD = 0 matches (non-vacuous).
- Refreshed to current truth: providerSwitch 10/10 (telnyx selectable), signalWireOnboarding 19/19 (2 guards were already stale since 09-15's resolver change + my orchestrator change).
- Unchanged differentials: telnyx 17/17, telnyxWebhooks 10/10, scopedLinks 10/10, portQueue 4/4, portLanding 38/38, voipMsProvisioning 54/54, signalWire 19/19, signalWireSmsChat 6/6, signalWireTenDlc 15/15; pbxTenantBuild 39/1 and setupOrchestrator 7/24 = the SAME pre-existing failures as before this work.
- api tsc: zero errors in any touched file (6 pre-existing server.ts errors on unrelated lines).
- LIVE stress + end to end (details: AGENT_HANDOFF_TELNYX_ONBOARDING §12–13): 45 parallel live searches (found 429s + Monsey/NYC stock); real wizard in Chrome → pay page; test invoice marked PAID in DB (NO card charged); +18457774807 bought (one order, retry adopted); PBX tenant 143 on trunk 183; Main dispatch verified in `dialplan show`; sync + owner + invite; ACTIVE. Five live-only bugs found and fixed (autosave stamp wipe, messaging PATCH 10027, missing Main dispatch, un-resumable build, stale directory). Port filing proven on 3 live drafts (never submitted, deleted 204).
- Deploys (queue, container-verified by `.build-commit` + grep, 0 restarts, 200 both hostnames): api 3c2de350 → 483930a9 → 782b1b34 → 7807c4fd → 8985eb9a → ad59f4a4 → 06855f22 → b467ca5a (final, includes aae262a3/68602d31); portal 1744190d (contains the wizard mapping).
- NOT proven: a human call on 845-777-4807, a submitted real port, the card leg on a Telnyx sign-up, Telnyx 10DLC with a real EIN, the landing sweep on a real port.

## Unified messaging Phase 1 (Messaging Router + Telnyx) — 2026-09-16

- apps/worker full suite **186/186 pass** (was ~168 + 25 new): telnyxChatSend (7 — provider JSON shape/Bearer/E.164/media_urls, refusal taxonomy, chaos hook, chunking, no-MP4 guard, config-error contract), messagingDispatch (11 — registry map, no-inline-if/else guard, and the one-message-one-delivery backup-route rules incl. partial-delivery and unflagged-error refusals), updated signalWireChatSend guard to the registry architecture.
- Guard replay vs pre-change HEAD: HEAD carries the inline SIGNALWIRE branch, no registry file — new guards FAIL there (verified by grep on git show HEAD).
- ⛔ One test caught a real defect before commit: the backup route fired on an error carrying NO __anySent flag; fixed to fire only on an EXPLICIT false (may-have-sent is never retried).
- apps/api: src/telnyx **27/27** (11 new webhook tests with REAL Ed25519 signatures — fail-closed 401s, ingest wiring with the telnyx: prefix, final-states-only DLR, message.sent writes nothing, ingest-failure still 200), publicReadyJwtBypass **12/12**, src/sms **20/20**.
- Typechecks: worker + integrations clean in all touched files (worker baseline has 8 pre-existing module-resolution errors in packages/db/src/webrtcPlatformOutageService.ts, untouched); api my-files clean (49 total pre-existing ambient, none in telnyx/, server.ts additions clean).
- Prisma client regenerated against the schema + migration 20260916170000 (TELNYX enum value, TenantSmsNumber.fallbackProvider).
- NOT proven yet: no deploy at test time (deploy follows in the same task), no real Telnyx inbound/DLR (needs webhook URL configured on the messaging profile + the account public key saved), no live send on a TELNYX-provider number (none exists yet).

### Deployed and live-proven (same task, ~16:15Z)

- api blue/green `done 287a32e6`, container commit verified, /health 200; migration `20260916170000_messaging_telnyx_fallback` read back FINISHED from the live DB; `fallbackProvider` column + TELNYX enum value present; `/webhooks/telnyx/sms` 401 fail-closed on local :3001 AND the public hostname, route file in the container.
- ⛔ worker deploy first SELF-SKIPPED on a false baseline (api deploy had reset the server checkout to my commit; change-detect diffed against another session's newer push and saw "no worker paths"); container verified WITHOUT the new file, then force-rebuilt at the origin tip (`DEPLOY_FORCE_RESTART=1`, done 2ac9e9fc) and verified WITH messagingDispatch.ts + telnyxChatSend.ts + the registry call.
- Live traffic through the NEW dispatch: the poll fetched real customer texts minutes after cutover; round-trip probe on Connect's own pair (+18455577768 ↔ +18457231213, shared thread, via /internal/chat/sms-system-reply): worker `voipms_sms_part_send` → **sent, VoIP.ms id 111471089 @16:15:10Z** → polled back INBOUND `voipms:111471092` @16:15:42. One message, one delivery, 32s.
- Still not proven then: no TELNYX-number live send — CLOSED the same evening, see below.

### Telnyx acceptance + backup-route door + carrier-word sanitizer (same day, evening)

- **Telnyx OUTBOUND LIVE through the chat door**: first probe failed honestly (no messaging profile); profile "Loopcom Chat" created via API with our webhook URL + US/CA whitelist, number attached; fresh probe → worker `telnyx_chat_sent`, id `telnyx:4031a0ab…`, arrived on the VoIP.ms side as `voipms:111472663` — 9s cross-carrier round trip. Telnyx INBOUND still blocked on the portal-only Ed25519 public key (`publicKeySet:false`) — Izzy pastes it into /apps/telnyx.
- Backup-route admin door: 5 source guards (closed enum SIGNALWIRE|TELNYX, SUPER-only gate before the write, equals-primary refusal, super-only GET projection with zero unconditional mentions, worker reads the column); sms+leak suites 33/33.
- ⛔ RULE-2 LEAK (pre-existing): raw deliveryError ("Telnyx refused…", "SIGNALWIRE_21610") shipped to every client. Fixed server-side via a fixed-phrase whitelist; 4 new tests incl. a real-production corpus — no carrier word can survive; SUPER keeps raw. sms suite 29/29. Portal tsc 0; portal suite 662/667 (5 pre-existing failures in untouched files: creative-studio native selects, campaign layout, coworkerHands, deskPhoneWizard, webrtcSdp). Mobile: type + one meta-row Text ("via backup route"); tsc clean in touched files; rides the next app build.
- **Deploys verified by FILE, not by "done"**: another session's queue job deployed api+portal at 483930a9 (my commits are ancestors — checked with merge-base, the pinned-SHA lesson); containers grepped: sanitizer present in both api files, portal chunks carry "sent via backup route" (6523) and "Backup: off" (voip-ms page chunk).

## Laybel live screen proof and layout correction — 2026-09-16

- Reproduced real production bug: connected call's video panel collapsed to 21.6 px. Initial call speech reached existing Assistant transcript and replies appeared; audible playback not confirmed.
- Portal fix 40c3ba2a: 17/17 Assistant tests, full isolated typecheck passed. Production build generated 221 pages; scripted blue/green rollout completed.
- Running container build SHA equals 40c3ba2a; built chunk contains flex:0 0 auto, aspect-ratio:16/9 and object-fit:contain. Stable upstream :3000, public /ready 200. Final log said fb563e27 due concurrent shared-clone advancement; this mismatch was investigated, not treated as matching proof.
- Post-fix browser: actual approved portrait, Connected, panel 287.8 px/video 310.4 x 174.6 px. Call later disconnected, reason unknown. Owner reported repeat-start trouble; End > Talk to Laybel > Start connected a second session in controlled Chrome. Screenshot shown. No post-fix spoken question/reply or audible output confirmed. Ended test; microphone off and start screen left open. Customer rollout disabled; end-to-end acceptance remains open.

## Laybel key/avatar activation — 2026-09-16

- Anam UI confirmed no existing keys; explicitly approved session-token-only key created (all resource scopes None). Approved portrait upload and completed custom Laybel avatar verified visually/in UI.
- Loopcom owner settings Saved; reload/reopen showed enabled Start video call. Live API status 200: configured/available/apiKeySet true, enabled false. Session endpoint 200 with a token; token/secret not logged. Persisted avatar and voice IDs matched the UI.
- No microphone/WebRTC/animated call or audible/Yiddish evaluation performed. No customer rollout, paid upgrade, code change, unit-test rerun or redeploy in this activation turn.


## Laybel production release verification — 2026-09-16 UTC

- API/PBX 14/14 + Assistant/consent/turns 16/16 passed on isolated release. Frozen/offline pnpm 10.30.2 lock validation and full portal typecheck passed. Production portal build passed, generating 217 pages.
- API + portal blue/green deploy logs ended `done b6d3310e`; both `/app/.build-commit` values equal `b6d3310ec3177ddb02de3d16c1853c6a66afe4d6`. API custom-LLM source and portal session/setup/streaming bundles verified inside running containers.
- Stable upstreams API :3001 / portal :3000; public /ready 200; external internal tenant-map 403.
- Live endpoint checks: anonymous 401, owner status 200/no-store/no returned key, unconfigured session 503, override 400, customer settings 403. Read-only configuration check: Anam absent. No real provider call or media proof; customer rollout disabled.


## Laybel isolated release — 2026-09-16

- Frozen/offline lockfile validation: pnpm 10.30.2, all 15 workspaces, passed; 18 additive lock lines only.
- API + PBX safeguard focused tests: 14/14 passed on isolated release source.
- Assistant + consent/turn lifecycle tests: 16/16 passed on isolated release source.
- Production configuration existence checked without returning secrets: SignalWire configured; Anam/Laybel absent. No live media test performed.

## Creative Studio build — 2026-09-16

- `apps/api` creativeStudio suite: **40/40 pass**
  (`node --experimental-test-module-mocks --import tsx --test "src/creativeStudio/*.test.ts"`).
  Three layers: pure logic (15s segment planning against Sora's real 4/8/12 limit, trademark and
  real-person refusals, brand-kit prompt building, storage-key escaping, SRT, export presets); the job
  engine against an in-memory database (idempotency — the same request twice is one job, a different
  company is a different job; the licence gate refusing a non-commercial engine; quota before spend;
  two runners cannot claim one job; a dead lease is re-queued but a provider-side job keeps polling;
  cancel records part-done work; one company cannot cancel another's); and source guards (routes
  registered, permission rules present, the JWT bypass, navConfig's import shape, no publishing tool,
  FFmpeg protocol whitelist, the test glob registered in package.json).
- **Two real bugs the tests caught:** a run of dots surviving `safeSegment` (a key could contain `..`),
  and `cancelJob()` reading `job.status` after its own update (worked with Prisma's detached rows,
  silently skipped the spend record otherwise). Both fixed.
- Typecheck: `apps/portal` **0 errors**; `apps/api` — my files clean, the rest are the documented
  pre-existing set on this shared worktree (billing `accountPricing`, delivery, mfa, `apiRequestProfiler`,
  `ops/hostMetrics`), none in `src/creativeStudio/*`.
- ⛔ The repo-wide api suite was NOT run for this change: it has a large pre-existing failure set on this
  workstation (stale `packages/integrations/dist`), and this build is a new directory plus registration
  lines in `server.ts`.

### Proven on PRODUCTION (not a harness)

- **Image:** queued → succeeded in 15s; 2,022,197-byte PNG at the requested 4:5; FFmpeg thumbnail made.
- **Video:** a 4s shot in 74s — h264+aac, 1280×720, duration 4.1s.
- **A 15-second shot from a 12-second engine:** planned **12 + 4**, two provider jobs, part 2 started
  from part 1's last frame, joined and trimmed → **duration exactly 15.000000s**, 3,900,780 bytes.
- **Refusals:** Coca-Cola logo → 422 with a customer-ready sentence; wrong internal secret → 403;
  another company asking for the same job → **404, not 403**; their asset list empty; tampered signed
  URL → 401 while the correct one served exactly 2,022,197 bytes as `image/png`.
- **Learning loop:** three identical rejections → `suggested(1) → suggested(2) → active(3)`; the next
  generation returned `appliedMemory:["Prefers a slower pace"]` and the prompt actually sent carried
  *"Pacing: slower, let shots breathe."*
- **A real Coworker turn** (agent chat, gpt-5, real user identity): the model chose the tools itself,
  created a project "Website delivery photo", generated the image and replied
  *"All set — your image is ready and saved in Creative Studio…"* with sensible next steps.
  ⛔ The FIRST attempt replied "ran out of investigation steps" — it burned its tool budget polling.
  Fixed by making `creative_check_job` wait up to 20s server-side and bounding the polling in the prompt.
- **Stress:** ten identical requests fired at once → **exactly one job created, one job id returned**;
  five different requests → some accepted, the rest refused with *"You already have 2 jobs running…"*;
  the queue drained to **11 succeeded, 0 stuck** — while the API container was being replaced mid-flight.
- **Worker death:** a live job forced to "claimed by dead-worker, lease expired 5 minutes ago" was swept,
  re-claimed, ran and **succeeded** within ~20 seconds.

### Not proven

No human has used the portal screens in a browser (the pages serve 200 and the shipped bundle carries
every permission key, but nobody has clicked them); no customer holds a Creative Studio key; the
storyboard, timeline UI, audio/captions, export screen and the self-evaluation pass are not built.

## B Visible missed charges + billingRecurringCustomLines — 2026-09-15

- `node --experimental-test-module-mocks --import tsx --test src/billing/billingRecurringCustomLines.test.ts src/billing/billingPeriodGuards.test.ts` (apps/api): **8/8 pass** — parse junk-tolerance/caps/taxable-strictness, built-line shape, CRLF-normalised source guard pinning the engine push BEFORE `applyBillingPeriodToRecurringLines`, plus both existing period-guard tests. ⛔ Plain `tsx --test` fails billingPeriodGuards on `mock.module is not a function` — the runner flag, not a regression.
- New test file registered in `apps/api/package.json`'s explicit test list (the runner never globs billing tests).
- `npx tsc --noEmit` (apps/api): no NEW errors — the documented pre-existing pair (billingPricingDiagnostics/State `accountPricing`) plus other sessions' in-flight areas (ops/, delivery/, globalSearch, mfa); nothing in the files this task touched.
- Live proof (prod, read-only): deployed preview route for B Visible returns $205.00 with both CUSTOM lines for the default period and Oct 2026.
- Not run: full api suite (change is two new files + a 7-line engine insert, guarded by its own registered suite); no real Oct 2 invoice/charge yet.

## LoopCom Mobile full product build — 2026-09-16

- `apps/api` loopcomMobile suite: **20/20 pass** (welcome-email template + once-per-tenant trigger guard added 09-16) — was 19/19 before the welcome addition; original scope: (money math incl. twice-run recount identity, ONE-request eSIM purchase + timeout-not-resent, real Ed25519 tamper/stale/wrong-key refusals, and the source guards: product routes registered + owner-gated (check count >= route count), tenant-from-JWT, no purchase/order call in product routes, no carrier port-filing call, EmailJob-only email lane, transfer PIN never echoed, activation code never in an email, nav/catalog/bucket contract for all 11 mobile keys, nine per-page API prefix rules).
- `apps/portal` nav suites: **40/40 pass** (loopcomMobileNav rewritten for the section: ten pages x visibility-honesty through the real `isNavItemVisibleForUser` for USER and TENANT_ADMIN jwts, hidden without the key; PermissionGate + no-SUPER_ADMIN + no-native-select swept across all ten page sources + both detail pages; console owner-check + "PURCHASES 1 eSIM" + "cannot double-bill" strings; permissionToggleCoverage 10/10 incl. one-toggle-per-page and no-lying-toggle over the new section).
- `apps/portal` FULL suite: **638 pass / 4 fail** — all four pre-existing at HEAD in files this build never touched (deskPhones setupDriver reboot guard, coworkerHands "Delete anything" copy, CRM campaignsIndexLayout CRMWorkspaceShell, webrtcSdpDiagnostics codec check). Verified: none of those suites' scanned sources are in this build's change set.
- `apps/api` FULL suite: **4,342 pass / 35 fail of 4,378** — every failure outside this build's change set: 34 in the onboarding orchestrator/scoped-links/checkout family (assertions like `resolvePbxRouteHelperConfig is not a function` and provider-wording drift "job needs company and did" vs expected "…, voipms" — the provider-switch/onboarding sessions' in-flight area on this shared worktree) + the publicOrigins tree sweep flagging `m.connectcomunications.com` in server.ts (introduced `2ade3422`, 2026-08-21). Nothing in those suites imports `src/loopcomMobile/*`, and this build's api diff is loopcomMobile/* + the server.ts mobile registration/prefix rules only.
- Typecheck: api = exactly the 87 pre-existing ambient errors (0 in `src/loopcomMobile/*`, 0 introduced); portal = 0 errors.
- Email templates: all 8 (incl. the welcome) rendered through the production `emailShell` with sample data (the artifact's Emails screen, v4, IS that output).
- ⏳ Not run/not provable yet: no real mobile line exists, so no live provisioning/usage/webhook/invoice/email delivery was exercised against production objects; deploy + container verification recorded in the summary file.

## Face-to-face AI Support mockup — 2026-09-15

- Static fragment/assets check passed for `talk-to-ai-support.html`: 29,338 bytes, under 1 MB; correct root; no document wrapper or escaped markup; all three generated avatar assets and critical live-call, admin and transfer states are referenced.
- Updated Concept A image was inspected after its tie-removal and Loopcom-infinity-pin edit; this now-superseded avatar draft remains historical review material only.
- Scope correction review: `talk-to-laybel.html` static fragment check passed at 9,907 bytes; no document wrapper or escaped markup; it contains the `Talk to Laybel` row and local start/end voice-state controls. It uses no avatar asset or provider integration.
- The visualization wrapper rendered successfully.
- `apps/portal/components/floatingAssistantOpening.test.ts`: passed 11/11 using `tsx --test`, including `Talk to Laybel is a voice mode of the existing Assistant, not another agent`.
- `git diff --check` passed for the Laybel implementation.
- Shared-worktree portal typecheck is presently blocked by an unrelated concurrent error in `apps/portal/components/deskPhones/DeskPhoneWizard.tsx` (`runId` used before declaration). A clean temporary worktree cannot resolve the local non-checked-in dependency tree, so it is not a substitute for a full typecheck.
- Not run: production deployment or production browser acceptance. No provider integration, LiveKit/avatar session, customer/PBX/remote-support operation, or new recording/storage path is involved.

## Browser Companion hybrid extension candidate — 2026-09-16

- `node --import tsx --test apps/desktop/src/coworker/browserCompanion.test.ts apps/desktop/src/coworker/playwrightRuntime.test.ts` — **5/5 pass**.
- `node --import tsx --test apps/desktop/src/coworker/browserCompanion/hybridRuntime.test.ts` — **2/2 pass**.
- `node --test apps/desktop/scripts/browser-companion/security.test.mjs` — **3/3 pass**.
- `pnpm --filter @connect/desktop build` — **pass** (schema generation and TypeScript build).
- Packaged candidate `scratchpad/browser-companion-package-20260916002842347/release3/Connect-Setup-0.1.17-rc.18.exe` — ASAR contents and all seven Loopcom icon frames verified.

Not run / not proven: installer execution, manual unpacked Chrome extension load, bridge pairing, live Coworker/provider flow, restart/stress and production distribution. The supported Windows computer-control service first reset, then exposed no native-app launcher and refused the existing `chrome://extensions` tab before those authorized UI actions could occur.

## Browser Companion Playwright engine — 2026-09-15

- `pnpm --filter @connect/desktop build` — passed (schema generation and TS 6 build).
- `node --import tsx --test apps/desktop/src/coworker/*.test.ts` — passed, including the new Playwright integration test.
- `node --test apps/desktop/scripts/browser-companion/security.test.mjs` — 3/3 passed.
- `node --import tsx --test apps/desktop/src/coworker/playwrightRuntime.test.ts` — passed. Uses installed Chrome headlessly with a temporary profile and verifies scope isolation, approval binding/replay prevention, a form fill and byte-verified same-origin download.
- Clean package candidate `scratchpad/browser-companion-package-20260915162157175/release/Connect-Setup-0.1.17-rc.16.exe` — ASAR required-file check passed; `verify-built-icon.ts` passed against unpacked `Loopcom.exe`.

Not run: installed-app live chat/provider acceptance, ordinary-profile Chrome access, 2FA/captcha handling, vision transport, restart/stress matrix and production distribution.

## Installed-app verification — 2026-09-15

- Installed `Connect-Setup-0.1.17-rc.16.exe` with owner approval, restarted Loopcom, and observed the current processes running from `C:\Users\izzyw\AppData\Local\Programs\@connectdesktop\Loopcom.exe`.
- Elevated ASAR inspection of the installed app passed for `playwrightRuntime.js`, `playwright-core/index.js`, `playwright-core/package.json`, and `coworkerConnections.html`.
- The desktop-control service returned no targetable Loopcom window after restart. No visible Settings or live agent conversation assertion was made.

## Coworker IDE mockup — 2026-09-15

- Static fragment check passed for `loopcom-coworker-ide-mockup.html`: it is under 1 MB, has the required preview root, contains no document wrapper or escaped markup, and has balanced main/article elements.
- Not run: product UI tests, desktop build, packaging, or browser acceptance. This task produced a review mockup only; no application source changed.

## Coworker SCREEN CONTROL — 2026-09-15

- `cd apps/desktop && node --import tsx --test src/coworker/screenControl.test.ts` → **13/13 pass** (pure session
  state machine; `shouldYieldTo`; `screenArgsToCommand`; the 8-tool catalogue; runtime integration against a fake
  controller incl. the **500-action ask-once stress with 0 re-asks**, no-session refusal, per-task consent,
  denied-override precedence, call-deferral, admin-PowerShell-always-asks + denylist, fenced capture).
- `node --import tsx --test src/coworker/coworkerHands.test.ts` → **18/18 pass** (existing suite; the drift/coverage
  guard now covers the 9 new `computer_screen_*` runtime cases — every catalogue tool still has a runtime case).
- `node --import tsx --test src/coworker/*.test.ts src/remoteSupport/*.test.ts` → **110/110 pass** (no regression from
  reusing `remoteSupport/inputInjector.ts`).
- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` → **EXIT 0** (clean, incl. the new Electron surface).
- ⏳ NOT run (needs a real Windows screen + a human): a real cursor moving, a real screenshot, UIA Invoke on a live
  button, the yield/Escape LL hook, and the UAC elevation. Acceptance steps are in
  `docs/ai-context/AGENT_HANDOFF_COWORKER_SCREEN_CONTROL_2026-09-15.md`.

## Android TABLET / every-device compatibility — 2026-09-15

- `cd apps/mobile && npx tsx --test src/ui/deviceCompatibility.test.ts` -> **4/4 pass**.
  Replayed against the pre-fix tree (`MOBILE_GUARD_ROOT=<git archive HEAD checkout>`) -> **3 of 4 FAIL**,
  so the guard is real and not a tautology. (The 4th, "nothing is declared required=true", passes on HEAD
  because HEAD declared no `<uses-feature>` at all — that one guards the future.)
- `cd apps/mobile && npx tsc --noEmit` -> **EXIT 0**.
- **THE BEFORE**, `aapt2 dump badging apps/mobile/dist/connectcomms-v1.0.0+20260906-115729.apk`
  (the fleet APK whose code matches Play vc102): **six `uses-implied-feature` lines** —
  telephony (`reason='requested a telephony permission'`), camera, microphone, bluetooth, location,
  screen.portrait. `supports-screens` was already all four sizes, so that was never the cause.
- **THE AFTER**, same command on a release APK assembled from the fixed manifest
  (`android/app/build/outputs/apk/release/app-release.apk`, `versionCode=103`):
  **ZERO `uses-feature` and ZERO `uses-implied-feature` lines; all 16 read `uses-feature-not-required`**
  (bluetooth, bluetooth_le, camera, camera.any, camera.autofocus, camera.front, faketouch, location,
  location.gps, location.network, microphone, screen.landscape, screen.portrait, telephony, touchscreen, wifi).
- **The shipped bundle carries it**: `apps/mobile/dist/loopcom-play-vc103.aab` (55,799,932 b, BUILD SUCCESSFUL
  in 7m59s via `scripts/android-play-bundle.ps1 -VersionCode 103 -VersionName 1.0.0`); all 16 feature names are
  present in its `base/manifest/AndroidManifest.xml`.
- Source-traced, not guessed: `grep -rn hasSystemFeature` over `apps/mobile/src` and the native Kotlin/Java
  returns **nothing**, so no code branches on any of these — the change is store-side only.
- ⏳ NOT run / NOT proven: the AAB is **NOT uploaded to Play** (owner's call), and **no real tablet has installed
  it**. The honest test is a Wi-Fi-only tablet showing an **Install** button instead of "Your device isn't
  compatible with this version", then a call ringing on it.
- ⛔ Still excluded and NOT addressed here: x86/x86_64 (the AAB carries `armeabi-v7a` + `arm64-v8a` only).

## Onboarding welcome email → Google Play badge — 2026-09-15

- `cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/*.test.ts"`
  -> **1,423 tests, 1,414 pass, 9 fail**. ⛔ **All 9 are PRE-EXISTING and unrelated to this change**:
  7 × `syncPbxTenantDirectoryFromRows`, `the model really exists in the schema (the (db as any)
  transposition trap)`, and `apps/api/src: the old hostname and mail domain appear as CODE only in
  publicOrigins.ts` — that last one flags `"m.connectcomunications.com"` in `server.ts`, which is
  **present at HEAD** (`git show HEAD:apps/api/src/server.ts | grep -n` -> L42556) and which this
  change never touches (`git diff` added zero hostname literals).
- `src/androidApkInviteUrl.test.ts` + `src/userEmailTemplates.invite.test.ts` -> **25/25 pass** after
  a real catch: the new guard `the template resolves BOTH Play URLs itself` **failed on first run**
  because its `!/androidApkUrl/` regex matched the *historical comment* explaining why the field was
  removed. Tightened to `/androidApkUrl\s*\?*\s*:/` + `/input\.androidApkUrl/`, so prose stays legal
  and only the field or a read of it fails the build.
- `src/onboarding/setupOrchestrator.test.ts` fails **wholesale** on
  `(0 , import_pbxInboundRouteHelperClient.resolvePbxRouteHelperConfig) is not a function`.
  ⛔ Pre-existing, from `1c1d067e` (another session's PBX-mirror work): the suite never mocks that
  module, and this change's only edit to that file is removing one import + the `androidApkUrl` field.
- `cd apps/api && npx tsc --noEmit -p tsconfig.json` -> **87 errors, ZERO in any file this change
  touched** (`grep -E "userEmailTemplates|androidApkInviteUrl|setupOrchestrator"` over the output is
  empty). The 87 are the repo's standing api type debt (Timeout/unref, storage-maintenance types, …).
- **Rendered from the real template**, `PUBLIC_PORTAL_URL=https://app.loopcom.net npx tsx` over
  `welcomeCreatePasswordEmail()`: badge `<img>` at 180×70 linked to
  `play.google.com/store/apps/details?id=com.connectcommunications.mobile`, plain text carrying the
  same URL, no APK wording left.
- **DEPLOYED + container-verified** (api then portal, `scripts/deploy-direct.sh … --commit 66eb7096…`):
  both `.build-commit` = `66eb7096c6f96bcfed71682d520bbe8fe73d0ff9`, **0 restarts**, both running.
  `welcomeCreatePasswordEmail()` **executed inside `app-api-1`** emits the badge linked to the
  listing and resolves the image to `https://app.connectcomunications.com/brand/google-play/…`
  (temp proof file removed after). Badge over HTTPS: **200, 4,904 b, image/png on BOTH hostnames**.
  `https://app.loopcom.net/api/mobile/android/download` -> **200**, so the APK is not withdrawn.
- ⏳ **NOT run / NOT proven: no invitation has been SENT since the deploy**, so no email has been
  opened in a real client and **Outlook's Word engine has never rendered the badge**. The honest
  test is the 2026-08-09 one: invite a spare address, then read the last `USER_INVITE` `EmailJob`
  bodies and confirm **both** paths (admin invite AND self-service sign-up) carry the Play URL.
- **SUBMITTED TO PLAY 2026-09-15** (owner said "go"): `loopcom-play-vc103.aab` uploaded by Izzy by hand (the
  page-JS upload trick that put vc101/vc102 in is now blocked — see the handoff §7), then driven from the
  extension: Play parsed **ONE** bundle row `103 (1.0.0)` / API 24+ (no duplicate), release name auto-filled
  `103 (1.0.0)`, notes set, only the benign no-deobfuscation warning, Save → Submit → confirm. Publishing
  overview now reads **"Changes in review"**, one row: **Production · 103 (1.0.0) · Start full rollout**.
  Managed publishing OFF, so approval puts it live by itself. ⏳ Approval and real-tablet install still pending.

## 2026-09-16 — Yiddish Learning Engine, built end to end (`88682602`)

**apps/api/src/yiddishCorpus — 127/127 pass** (registered in `apps/api/package.json`
as `src/yiddishCorpus/*.test.ts`, alongside the creativeStudio glob):
- governance / evidence / corpusService: 47 — customer content unreadable and
  unexportable; a legacy `stt-yi` row with an unprovable provider counts as
  Yiddish-Labs-derived (and `sttProvider:"ivrit"` proves the opposite); the audio
  gate refuses on each half alone; a 500-repeat single-speaker flood loses to ten
  speakers; a NAME lexeme cannot become a rule without a human; fingerprint
  dedupe; consensus refuses below the confidence floor; retention never removes text.
- yiddish24Adapter / jobs / audioPipeline: 46 — real saved HTML fixtures parse;
  the rate limiter actually spaces requests; audio stages are SKIPPED, not failed,
  while the gate refuses; a lease prevents double-claim; retries then FAILED with
  the error kept; two empty discovery runs raise a health alert instead of
  "nothing new"; ffmpeg-missing degrades to `{available:false}`; a source guard
  asserts the `Referer` literal appears once and sits after the gate.
- routes / benchmark: 34 — every route 403s for a non-SUPER_ADMIN; rights and
  audio-mode refuse without an acknowledgement; export preview reports 0
  exportable with the breakdown; a second BASELINE is refused; runBenchmark
  resumes and stops at the budget; compareRuns refuses a verdict below the
  sample floor.

**Migration** `20260916180000_yiddish_corpus_learning_engine` — test-applied to a
throwaway database on the server BEFORE production: 21 tables created, defaults
verified (`audioFetchMode=DISABLED`, `contentAllowed=false`, eligibility
`UNKNOWN`), `YcSourceItem` cascade-deletes with its source, database dropped.

**Live-site parser check** (read-only, 2 polite requests, no audio): `/cat/227/`
→ 10 episodes, 100% field coverage (media/duration/title/series/date label),
`totalPages=8 perPage=10 catId=227`, 136 series links, 10/10 unique fingerprints,
`1:09:40 → 4180 s`.

**Typecheck:** `tsc -p apps/api` — 0 errors in `yiddishCorpus`, 0 on any line we
added to `server.ts`. `tsc -p apps/portal` — clean.

**Portal:** `permissionToggleCoverage` 13/13, nav guards 30/30, full suite
645/650 (the 5 failures are pre-existing, in creative/campaigns/coworker/
deskPhone/webrtc files we did not touch).

⚠️ **36 api tests fail on this workstation and none are ours** — setupOrchestrator
24, pbxTenantDirectorySync 7, signalWireOnboarding 2, pbxTenantBuild 1,
complianceCalendar 1, publicOrigins 1. Cause: `packages/integrations/dist/index.js`
is a gitignored build artifact dated 2026-05-24 while its source is 2026-08-12, so
those suites load a stale build missing `resolvePbxRouteHelperConfig`. Every file
involved is byte-identical to HEAD; the server builds fresh in Docker.

## Browser Companion desktop install — 2026-09-16

- Owner-approved silent NSIS installation of `Connect-Setup-0.1.17-rc.18.exe` completed.
- Read-only installed-archive inspection passed for `hybridRuntime.js`, the MV3 manifest,
  and the branded icon asset; the regular installed `Loopcom.exe` process was observed
  after launch.

Not run: Chrome Developer Mode unpacked extension loading, pairing, and live Coworker/provider acceptance. The available supported UI control cannot claim `chrome://extensions`.

## Laybel live-video adapter — 2026-09-15

- `apps/api`: `node --import tsx --test src/laybel.test.ts src/pbxMutationSafeguard.test.ts` — **14/14 pass**. Auth, disabled rollout/owner preview, no client config overrides, write-only credentials, partial settings validation, sanitized failures, rate limiting, PBX safeguards.
- `apps/portal`: `node --import tsx --test components/floatingAssistantOpening.test.ts` — final **16/16 pass**. Existing support paths, same-brain video wiring, consent/cleanup guards, duplicate/serial turn handling, interruption, close/late-response suppression, takeover and no automatic retries.
- Full portal typecheck passed with `--noEmit --incremental false --types node,react,react-dom`. Final focused portal/API typechecks **passed** using `scratchpad/laybel-typecheck.json` (includes Next declarations) and `scratchpad/laybel-api-typecheck.json` (extends actual workspace aliases). Default ambient discovery failed on missing emscripten declaration; sandbox tsx failed initializing `os.userInfo` but authorized elevated tests passed. Initial standalone API/portal focused commands omitted required workspace/Next declarations; corrected configs passed without source suppression.
- No live Anam/SignalWire session, production deployment, provider portrait, microphone/playback or browser visual verification proven. Unit tests do not establish live-call readiness.

## Yiddish Learning Engine — audio runner + 24/7 download un-stall — 2026-09-17

- No code changed in the engine this session; no new tests run. The off-box
  runner (`scripts/yiddish-runner/`) is a committed copy of the PC script.
- Verified on production (read-only SQL, `connectcomms-postgres`): 34 Yiddish24
  `fetch_audio` DONE (was 31), 34 `YcAudioAsset` STORED, 19,163 `YcSegment`,
  and `YcTranscript`/`YcLexeme`/`YcPronunciationRule`/`YcFinding` all 0 —
  confirming acoustic-only, no language learning (no transcribe/align/cluster
  handler exists).
- Verified the download un-stall live: after parking the 1,888 voicemail
  fetch jobs (`nextRunAt`→2027-01-01), the runner produced new Yiddish24 assets
  and its log advanced (`done=65` at 15:28:42Z).
- Live api container `.build-commit` = `51072578`; `YIDDISH_WORKER_EXCLUDE_STAGES=fetch_audio,segment,features` present in the container env.

## Gesheft pay line — the caller-ID rule — 2026-09-17

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test src/supermarket/supermarketCore.test.ts src/supermarket/supermarketStress.test.ts src/supermarket/supermarketWiring.test.ts src/supermarket/payIvrDialplan.test.ts src/supermarket/customerSync.test.ts src/supermarket/customerPhoneMatch.test.ts` — **105/105 pass** (includes all 25 heavy stress tests and 4 new caller-ID-rule reducer tests).
- `apps/api`: `… --test src/supermarket/phonePinRoutes.test.ts` — **11/11 pass** (desk PIN routes: permission matrix, tenant isolation, verify-before-store, never echoes the PIN, classification pinned to the register's real bodies).
- `apps/api`: `… --test src/supermarket/payLineStress.test.ts` (new, 8 heavy tests) — **8/8 pass**: PAYLINE 1 caller-ID matrix `accounts=2000 silentServed=70 askedOnce=148 noPinLandings=1129 foreignPinAsks=653 charges=8 posRequests=5782` (a matched caller never hears `02_pin` except once per account when the POS has a PIN we lack; a foreign caller always does and never enrolls; a stored PIN never rides a non-matching call); PAYLINE 2 dialplan emulator through the real door `calls=500 httpOk=1148 midCallHangups=19 emptyReads=57 dupPosts=18` (duplicated POSTs never double-charge/enroll); PAYLINE 3 refusal fuzz `mutations=5000` (unknown text never classifies as not_set); PAYLINE 4 `concurrentCalls=200 charges=100 ledgerCents=99900` reconciled; PAYLINE 5 same step ×10 concurrent `chargeDoubles=0 enrollDoubles=0`; PAYLINE 6 outage `calls=400 attemptsWronglyBumped=0 wronglyPurged=0`; PAYLINE 7 purge scoping 300 accounts; PAYLINE 8 legacy session shapes ×10 phases.
- Typecheck: api `npx tsc -p tsconfig.json --noEmit` → 0 errors in supermarket files (4 pre-existing in `deskPhoneSetup/deviceCloudRoutes.ts`); portal `npx tsc --noEmit` → 0.
- ✅ Live, read-only, through the real api door on loopcom against the real POS register (`/root/payline-live-proof.sh`): matched no-PIN caller → person on the first step (`status no_pin`); foreign caller → PIN asked, no enrollment; matched PIN-having account → asked once. Vault unchanged.

Not run: a human phone call keying a real POS PIN and a real card charge (no test account has a POS PIN and a card).

## Yiddish Whisper fine-tune pipeline — 2026-09-17 (commit f3c818b0)

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test "src/yiddishCorpus/*.test.ts"` →
  **265/266** (+79 new: transcribe 27, transcribeBackend 16, gold 34, governance +5, audioPipeline +6,
  routes +2, ycRegisterCallRecordings 9). The 1 failure = `routes.test.ts` "the audio-mode route is the
  one place that requeues refused audio work" — pre-existing Windows CRLF source-guard artifact
  (`indexOf("\n  }\n")` against a CRLF working copy); passes on the LF server checkout; file untouched.
- repo root: `node --import tsx --test "scripts/yiddish-finetune/*.test.ts" "scripts/yiddish-runner/*.test.ts"`
  → **98/98** (build-dataset 26, runpod-pod 24, runpod-endpoint 5, smoke-transcribe 5, kaggle-run 16,
  copyCallRecordings 14, languageProbe 8).
- `apps/portal`: `node --import tsx --test navigation/*.test.ts` → **41/41**; `npx tsc --noEmit` clean.
- `packages/shared`: `node --import tsx --test "src/portalPermissions*.test.ts"` → **70/70**.
- `apps/api`: `npx tsc --noEmit -p .` → 0 errors in every touched file (pre-existing errors elsewhere).
- `python scripts/yiddish-finetune/train.py --self-test` → tier 0 (pure Python) passes; tiers 1–2 SKIPPED
  (no torch/jiwer on this PC, by design). `local_whisper.py --self-check` → faster_whisper imports, exit 0.
- CPU benchmark (measurement, not a test): `ivrit-ai/yi-whisper-large-v3-turbo-ct2` int8, 8 threads, on a
  44 s voicemail — NOT finished after 39 min / 2,084 CPU-s; killed. This PC cannot label audio.
- NOT run: anything against a real RunPod pod/endpoint or Kaggle (no key/account), a real dataset build
  (no transcripts exist yet), a real fine-tune, any before/after WER.

## 2026-09-17 (evening) — Gesheft pay line: Izzy's full spec (matched = never a PIN; unknown → account number → PIN or star → one-time code by call/text)

Commit: the `feat(pay-line): matched caller never keys a PIN …` commit on `feat/ivr-migration-takeover`
(hash + deploy + live proof recorded in the docs follow-up commit right after it). Summary
`docs/ai-context/claude-md-sections/2026-09-17-pay-line-code-by-call-or-text.md`, handoff §16e.

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test src/supermarket/payIvrDialplan.test.ts`
  → **10/10** (4 new: dial/dialPlayback view, ten-digits-or-nothing, the conf's single async
  Originate + say leg never Read()s + Gesheft leg dials its own trunk with its own CID).
- `apps/api`: `node --experimental-test-module-mocks --import tsx --test "src/supermarket/*.test.ts"` (the
  `npm test` glob for this area) → **224/224**: `supermarketCore` 37/37 (4 updated to the new rule, 3
  added: default "never" vs `matchedPinPolicy:"ask_once"`, foreign never enrolls, no-PIN foreign blocked
  at once), `payLineCode` **13/13 NEW** (text + call delivery, last-four-only prompts, 8-wait / 3-wrong /
  2-send caps, expiry + resend, `payLineCodeSmsBody`, `resolvePayLineFromNumber` matrix, two source
  guards — `payIvrCore` imports only `./payAmount`, the runtime never logs the code — and a 500-account
  × {call,text} × {1,3 numbers} × 5-behaviour stress: code never persisted, only account numbers
  contacted, ≤2 sends/call, every failure lands on a person, exactly one charge per payer),
  `payLineStress` 9/9 (PAYLINE 1 split into never/ask_once; 5/7 pinned to ask_once — they test
  purge/concurrency; 8's blockedReason allow-list gained `pin_not_enrolled`), `supermarketStress` 28/28
  (STRESS 1's recorded-prompt set gained 23–33; 22 → ask_once; 25 toggles the env lever around its
  scenario), `supermarketWiring` 11/11 (the banned-substring guard's bare "expir" false-positived on
  `codeExpiresAt` — replaced with the real PCI field names), `phonePinRoutes` 11/11, `customerSync`
  11/11, `customerPhoneMatch` 14/14.
- `apps/api`: `npx tsc -p tsconfig.json --noEmit` → 0 errors in supermarket/*, voice/polly.ts,
  mfa/loginOtp.ts (pre-existing errors elsewhere, untouched).
- Register probe (read-only, inside `app-api-1`, real key): 3762 balance no header → 401
  "Customer PIN required."; pin 0 → 401 "Invalid customer PIN."; 1001021 pin 0 → "required";
  **1001021 POST /charges (bogus card, no header AND pin 0) → 401 "Customer PIN required."** —
  the register refuses charges on a no-PIN account before anything else.
- Prompt cutter (inside `app-api-1`, Polly Stephen/neural): 11/11 files, all natively 8 kHz
  mono 16-bit, durations 0.7–9.1 s; installed on the PBX (`en-male` 52 → 63, md5-matched).
- PBX dialplan: spliced + `dialplan reload` clean for the pay blocks (the reload's WARNINGs are
  pre-existing VitalPBX files); `dialplan show` verified the three contexts.
- Live door proof (`/root/payline-live-proof2.sh` on loopcom, after the deploy): recorded in the
  docs follow-up commit and in the summary file's Verification section.
- NOT run: a human code call / code text / real charge (needs Izzy on a phone that is NOT on an
  account, keying an account that has a POS PIN Loopcom holds); `SUPERMARKET_PAY_MATCHED_PIN_POLICY=ask_once`
  in production (covered by tests only).
- DEPLOYED api `50f57f76` (direct, container-verified, `/ready` 200) and LIVE-PROVEN through the real api
  door (`/root/payline-live-proof2.sh`): matched no-PIN → person (no_pin); matched 3762 (POS PIN, not
  enrolled) → person (pin_not_enrolled), NO 02_pin; foreign→no-PIN account → person at once; foreign→3762
  star+1 → `dial=8457823064` + say-list, wrong code refused; star+2 → one REAL text from 845-244-9666;
  0 persisted codes, vault 0 rows. NOT proven: the Originate ringing a real phone, a keyed-back code, a charge.

## 2026-09-17 (evening, round 2) — pay line: a matched caller whose own account can't be served is asked for the account to pay

Commit: the `feat(pay-line): a matched caller whose own account can't be served …` commit on
`feat/ivr-migration-takeover` (deploy hash + proof in the docs line right after these).

- `apps/api`: the `src/supermarket/*.test.ts` suites, all green — `supermarketCore` 37/37 (4 reducer tests
  now prove the redirect: prompt 34, phase `lookup_entry`, `ownAccountBlocked`, then the SAME call continues
  to a charge or to a once-only second person-landing), `payLineCode` **16/16** (+3: no-POS-PIN own account
  → redirected → another account with an enrolled PIN via star+code → one charge; un-enrolled own account →
  same number re-keyed → probe → correct POS PIN → served, vault stays 0; redirect fires ONCE — a second
  unservable account → person, `status no_pin`), `payLineStress` 9/9 (PAYLINE 1a/1b/7 reworked: matched
  no-PIN / vault-none / stale now redirect-then-relookup; per-call request cap 6→8), `supermarketStress`
  28/28 (recorded-prompt allow-list gained 34), `payIvrDialplan` 10/10, `phonePinRoutes` 11/11,
  `supermarketWiring` 11/11. Re-run by hand after the agent: stress + code + core → 81/81.
- `apps/api`: `npx tsc -p tsconfig.json --noEmit` → 0 errors in supermarket/* (pre-existing elsewhere).
- Prompt cutter inside `app-api-1`: `34_enter_account_phone` 9.5 s, 8 kHz mono 16-bit; installed on the
  PBX (`en-male` 63 → 64, md5-matched) and in `loopcom:/root/stephen-neural/`.
- Deploy + live door proof (`/root/payline-live-proof3.sh`): recorded in the docs follow-up commit and in the
  summary file's "Round 2 — tested / deployed / proven" section.
- NOT run: a human call; a real charge.
- DEPLOYED api `528bf977` (direct, container-verified, `/ready` 200) and LIVE-PROVEN (`/root/payline-live-proof3.sh`):
  Izzy's cell (no-POS-PIN account) → `34_enter_account_phone` → keys 8457823064 → `23_pin_or_star`; 3762's own
  line → asked → keys its own number → `23_pin_or_star`; redirect fires ONCE (second no-PIN account → person,
  `status no_pin`). Vault 0 rows. NOT proven: a human hearing prompt 34; code call ringing; a charge.

## 2026-09-17 (late evening, round 3 — FINAL) — pay line: "your account or a different one?" → PIN → menu; one-time code removed

Commit: the `feat(pay-line): final flow` commit on `feat/ivr-migration-takeover` (deploy hash + proof in
the docs line right after these). Summary `docs/ai-context/claude-md-sections/2026-09-17-pay-line-final-flow.md`.

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test "src/supermarket/*.test.ts"` → **208/208**:
  `supermarketCore` 37/37 (pay-IVR block rewritten: choice gather, silent probe, keyed PIN every time, no-PIN →
  36+20, choice/lookup/PIN caps, the money rule, legacy phase → human), `payLineStress` 8/8 (PAYLINE 1 = a
  2,000-account matrix × {own #1, own #2 self-lookup, foreign} × {no PIN, right PIN, wrong ×3}: served ⇒ keyed
  the PIN, no-PIN accounts hear exactly 36 then 20 and never 02_pin, vault touched 0 times, POS-request cap,
  money reconciles), `supermarketStress` 28/28 (recorded-prompt set = `payPromptRefs()`; STRESS 22 now proves
  the line never touches the vault), `payIvrDialplan` 10/10 (guard: no Originate/Dial in the conf),
  `phonePinRoutes` 11/11, `supermarketWiring` 11/11, `customerSync` 11/11, `customerPhoneMatch` 14/14 …
- `apps/api`: `npx tsc -p tsconfig.json --noEmit` → 0 errors in supermarket/* (pre-existing elsewhere).
- Prompt cutter inside `app-api-1` (Polly Stephen/neural, 8 kHz mono 16-bit): `36_no_pin_visit_store` 5.8 s,
  `37_which_account` 7.3 s, `38_enter_phone` 3.5 s — installed on the PBX (`en-male` 64 → 67, md5-matched)
  and in `loopcom:/root/stephen-neural/`.
- PBX dialplan: code-call `Originate` + both contexts removed (backup `.bak.paycode-removed.20260917T204449Z`),
  `dialplan reload` OK, `Originate` count 0, `connect-pay-code-say` gone, the two CURL steps intact.
- Deploy + live door proof (`/root/payline-live-proof4.sh`): in the docs follow-up commit and the summary
  file's "Round 3 — tested / deployed / proven" section.
- NOT run: a human call; a real charge.
- DEPLOYED: commit `25ef3d12` shipped as branch tip `64746df2` (direct; container-verified, `/ready` 200) after
  TWO attempts failed at candidate start — `bind 127.0.0.1:3004 address already in use` was an nginx keepalive's
  ephemeral SOURCE port (ip_local_port_range 1024–65000, nothing reserved); fixed with
  `net.ipv4.ip_local_reserved_ports=3000-3010` (runtime + sysctl.d) and `ss -K`. LIVE-PROVEN
  (`/root/payline-live-proof4.sh`, 5 scenarios: own #1 → PIN; own no-PIN → "visit the store" + person; own #2 +
  number → PIN; unknown → number → no-PIN → store + person; bad choice replays, 7 digits get 845). Izzy's own three
  calls reached accounts with the PIN accepted (two ended at 12_no_card). NOT proven: a real charge.

## 2026-09-17 (night, round 4) — pay line: pay with a KEYED card (one-time or saved), AGI collector + card door + memory vault

Commit: the `feat(pay-line): pay with a keyed card` commit on `feat/ivr-migration-takeover` (deploy hash +
proof in the docs line right after these). Summary `2026-09-17-pay-line-final-flow.md` "Round 4", handoff §16g.

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test "src/supermarket/*.test.ts"` → **229/229**:
  `payLineCard` **19/19 NEW** (confirm 39 + hand-off to action "card"; the card door vaults under the session row
  id and advances to 46; cardFailed → 45+20; invalid shapes refused at the door; empty-digit re-entry then cap;
  once = inline card on /charges with no cardId; save = POST /cards then charge by id + GET /cards shows it; one
  charge per confirmation; no card on file → 12+40 offer; keyed decline → 11+47 with the amount kept; card-on-file
  decline → old 11+05; the secrecy sweep — door response, step results, persisted rows, every log call, the
  register's own 400 body carry no card number; hangup clears the vault; TTL expiry; empty vault → declined never
  a charge; route-level door with/without the secret; CARD STRESS 500 sessions × card-on-file {none/declined/ok}
  × keyed {once/save} × {valid/declined/gave-up}), `supermarketCore` 37/37, `supermarketStress` 28/28 (fuzzer now
  reaches the card phases; `human` re-transfers), `supermarketWiring` 11/11 (guard: the raw keyed card variable
  in the runtime is used only at its four sanctioned call sites, never in a log or db write), `payLineStress`
  8/8 (dialplan driver models the AGI hand-off), `payIvrDialplan` 10/10 (action "card"; the conf's card block
  calls `AGI(connect-pay-card.py,` and never Read()s), `phonePinRoutes` 11/11, `customerSync` 11/11,
  `customerPhoneMatch` 14/14, others unchanged.
- `apps/api`: `npx tsc -p tsconfig.json --noEmit` → 0 errors in supermarket/* (pre-existing elsewhere).
- Register validator probe (inside `app-api-1`, Izzy's own card-less 1001021, invalid numbers only — nothing
  storable): field names `CardNumber` (Luhn-checked), `ExpMonth` 1–12, `ExpYear` 0–99, `CVV`, `ZipCode`,
  `HouseNumber`; unknown fields ignored.
- Prompt cutter (Polly Stephen/neural, 8 kHz): 39–47 cut, installed on the PBX (`en-male` 67 → 76) + canonical
  stash. AGI `connect-pay-card.py` → `pbx:/var/lib/asterisk/agi-bin/` (py_compile OK, asterisk 755); conf
  spliced (`.bak.paycard.20260917T221133Z`), reload clean, `AGI(` present, 0 Originate/Dial, 2 CURL steps.
- Deploy + live proof (`/root/payline-live-proof5.sh` on loopcom, `/root/agi-harness.py` on the PBX): in the
  docs follow-up commit and the summary file's "Round 4" section.
- NOT run: a real keyed charge (needs a caller with an account PIN and a real card) — the inline `card`
  shape on `/charges` is inferred from the add-card validator until then.
- DEPLOYED api ``d2bf48ee`` then ``f238b0bf`` (direct, container-verified, ``/ready`` 200). ⛔ The FIRST deploy proved
  a miss live: the card door was not on the JWT public-route bypass, so the AGI's POST answered **401 with the
  correct secret** (401 = never reached the handler; the route-level test could not see it because it registers
  the routes without the JWT hook) — fixed in ``f238b0bf`` + pinned by the wiring guard.
  LIVE-PROVEN after the fix: ``/root/payline-live-proof5.sh`` — wrong secret → 403; no session → ``ok:false
  no_session``; bad-Luhn card → ``ok:false invalid`` and the session unchanged; a valid test card → ``ok:true``,
  vaulted, reducer ignores it outside card entry, session state carries no digits, the test number appears 0
  times in the api log. ``pbx:/root/agi-harness.py`` drove the installed AGI through a fake AGI pipe: GET DATA
  ×5 (one ``45_card_invalid`` replay for month 13), one HTTPS POST to the live door, ``PAY_CARD=fail`` for the
  unknown call id, and 0 occurrences of the test number in ``/var/log/asterisk/full``.
  NOT proven: a real keyed charge (inline ``card`` shape on ``/charges``) and a real save-then-charge — needs a
  caller with an account PIN and a real card.

2026-09-17 — Yossis Wood Works IVR migration + closed-Monday announcement (api `3049fd53`)
  ``apps/api`` ``node --experimental-test-module-mocks --import tsx --test src/ivrMigration.test.ts`` →
  **44/44 pass** (2 new: instructions-only menus keep their greeting; welcome still wins when both exist).
  The fallback test **FAILS replayed against the pre-fix source** (promptRef came back null). api typecheck:
  the only errors are 4 pre-existing syntax errors in another session's mid-edit local
  ``deskPhoneSetup/deviceCloudRoutes.ts`` — zero in edited files; the pushed commit was built from a clean
  worktree at the origin tip. LIVE proof on the PBX (``/root/ivr-e2e.sh``): bare call to 845-827-9500 →
  ``connect-menu,mcmu67d91000sers12b070ba2h`` played ``custom/yossis_wood_works_vpbx89`` PASS; keys "0" →
  ``Goto(T28_app-announcement,announcement-36,1)`` + its recording played PASS. Keys 1–5 deliberately not
  probed (they ring real ring groups at 2 AM).

## 2026-09-17 (late night, round 5) — pay line: choose the card by last four BEFORE charging; a decline re-offers the cards or a new card

Commit: the `feat(pay-line): choose the card before charging` commit on `feat/ivr-migration-takeover` (deploy hash +
proof in the docs line right after these). Summary `2026-09-17-pay-line-final-flow.md` "Round 5", handoff §16h.

- `apps/api`: `node --experimental-test-module-mocks --import tsx --test "src/supermarket/*.test.ts"` → **238/238**:
  `supermarketCore` 43/43 (+6: exact 2-card prompt sequence, 4-card cap with the 5th dropped, out-of-range pick
  → cap → person, a decline re-lists silently, `no_card` keys a new card, `cards_result` failure → person),
  `payLineCard` 22/22 (rewritten for choose-first; 2-card/9-new-card hand-off; card-on-file decline re-lists
  and a DIFFERENT card can be picked; 3 declines hit the cap; new 500-session stress over {0,1,2,4 cards} ×
  {pick ok / pick declined then other / 9 new once / 9 new save} asserting the charged cardId is ALWAYS the
  picked one), `payLineStress` 8/8 (dialplan driver picks by counting `48_to_use_card_ending`; the
  double-charge race now fires on the pick), `supermarketStress` 28/28 (fuzz pool gains `cards_result` incl.
  malformed last-fours; cap invariants; ⛔ STRESS 4's seeded balance was 1 cent over PAY_MAX_CENTS — a latent
  test-data bug, fixed), `payIvrDialplan` 10/10, `supermarketWiring` 11/11, `phonePinRoutes` 11/11, others
  unchanged. Re-run by hand: fast suites 86/86, heavy suites 36/36.
- `apps/api`: `npx tsc -p tsconfig.json --noEmit` → 0 errors in supermarket/* (pre-existing elsewhere).
- Prompt cutter (Polly Stephen/neural, 8 kHz): 48/49/50 cut, installed on the PBX (`en-male` 76 → 79) + canonical
  stash. No dialplan change.
- Deploy + live proof: in the docs follow-up commit and the summary file's "Round 5" section.
- NOT run: a real pick-a-card charge and a real keyed charge (need a caller with an account PIN and a card).
- DEPLOYED api ``af23a052`` (direct, container-verified: ``.build-commit``, healthy, ``/ready`` 200, ``50_new_card_press_9``
  + ``cardsOnFile`` in the container). Live regression on the deployed container: the final-flow proof
  (``/root/payline-live-proof4.sh``, 5 scenarios) and the card-door proof (``/root/payline-live-proof5.sh``: wrong
  secret 403, no session, invalid refused, valid vaulted with 0 digits persisted/logged) both unchanged and green.
  NOT proven: a real pick-a-card charge and a real keyed charge (need a caller with an account PIN + a card).

## 2026-09-18 — desk-phone per-device registration truth (api `828a07a8`)
- `apps/api/src/deskPhoneSetup/phoneRegistrationTruth.test.ts` — 11/11 (node:test): the 2026-09-17 live T21 run replayed exactly (Yealink .170 + GS .172 both on ext 101, the .171 "extension held by another device" lie refused, x-ast-orig-host parsing incl. hostname/garbage refusals, WebRTC never greens a desk phone, cold-mirror fallback).
- Desk-phone suites re-run with the change: deskPhoneRoutes + deskPhoneChaos + deskPhoneRecordWiring + phoneRegistrationTruth = 101/101; deskPhoneStress + deviceCloudRoutes + managedPhoneIntegration + gdmsRedirect + deviceProviders = 149/149. (Existing suites inject `isRegistered` only → they exercise the cold-mirror fallback path unchanged.)
- api tsc: 45 pre-existing errors elsewhere, none in the touched files.

## 2026-09-18 — guided desk-phone setup (R27)
- `packages/shared`: `npx tsx --test src/deskPhoneSetup/resetRecipes.test.ts src/deskPhoneSetup/deskPhoneSetup.test.ts src/deskPhoneSetup/vendorCoverage.test.ts` — 84/84 (7 new: family mapping, honesty/confidence, customer-words guard, every catalogue vendor resolves).
- `apps/api`: `node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/*.test.ts` — 405/406 (14 new laybelGuide: scripted lines, truth fence, improviser budget/fallbacks; the 1 failure is `managedPhonePostgres.test.ts` needing a generated Prisma client in the fresh worktree — env, not code).
- `apps/portal`: `node --import tsx --test components/deskPhones/guidedFlow.test.ts components/deskPhones/setupDriver.test.ts components/deskPhones/wizardHonestFinish.test.ts` — 72/72 (11 new: sticker match, connectedAsMapped, screen selection, stuck classification, candidate ordering).
- Typecheck: api touched files 0 errors; portal `tsc --noEmit` exit 0 (0 errors). Portal `next build` run before deploy (result in the handoff).
- ⏳ Not run: a human walking the guided setup on a real phone; Laybel video inside the rail.
- R28 (super-admin tenant switcher reaches the desk-phone doors): `apps/api` `node --experimental-test-module-mocks --import tsx --test src/deskPhoneSetup/effectiveUser.test.ts src/deskPhoneSetup/deskPhoneRoutes.test.ts src/deskPhoneSetup/managedPhoneIntegration.test.ts src/deskPhoneSetup/deviceCloudRoutes.test.ts` — 155/155 (5 new); api + portal tsc clean.
- R29 (Grandstream robot family + Yiddish + mic): `apps/desktop` `node --import tsx --test src/phoneSetup/grandstreamWebRobot.test.ts src/phoneSetup/phoneWebRobot.test.ts` — 58/58 (11 new, fake GXP2170 incl. the GDMS-claimed no-op refused `save_not_verified`); `apps/api` laybelLanguage 8/8 + deskPhoneRoutes/RouteOrder 64/64; `apps/portal` setupDriver + guidedFlow 64/64; tsc clean api/portal/desktop.
- R30 (first walk fixes): `apps/portal` guidedFlow 12/12 (+1: O→0, MAC label stripped); `apps/api` laybelGuide 14/14; portal tsc clean.
- R31 (second walk): `apps/api` effectiveUser (real CUID/slug shapes) + laybelGuide + deskPhoneRoutes — 75/75; api + portal tsc clean.

## 2026-09-18 — Yiddish training runs + bulletin gold

| suite | result |
|---|---|
| `apps/api` yiddishCorpus (`src/yiddishCorpus/*.test.ts`) | **298 / 299** — the 1 failure is the pre-existing source-reading guard on `routes.ts` (file untouched today, fails at HEAD too) |
| bulletin trio (`bulletinText`, `bulletinAlign`, `bulletinIngest`) | **29 / 29** — NEW |
| `scripts/yiddish-finetune` (`kaggle-run`, `watch-training`, `build-dataset`, `report-state`) | **70 / 70** (2 NEW in kaggle-run, 4 in watch-training) |

New guards, each replaying a real 2026-09-18 failure:
- `kernelPush mounts the CODE dataset as well as the data dataset` — the run that executed a stale `train.py`.
- `a refused dataset source fails the push instead of burning a GPU session` — `kaggle kernels push` exits 0 while reporting it dropped the dataset.
- `the reported error is the ROOT cause, not papermill's re-raise of it` — the log tail is always the wrapper.
- `the OLDER layout, with the body and no content_block wrapper, is harvested too` — the parser miss that lost 70% of the bulletin archive as "empty pages".
- `a paragraph the reader SKIPPED is dropped, never invented into the audio` — the 97%-verbatim hazard.
- `the raw article is stored UNUSABLE and only aligned spans carry timing`.

Live, not tests: bulletin harvest 3,227 articles / 324 pages / 0 empty; agreement measured over the
98 bulletins that have ASR (median 0.636 — see the handoff for why that number is our ASR's error
rate, not the article's); Kaggle training run 7 RUNNING past 25 minutes after four runs died inside 6.

### 2026-09-18 (later) — the two remaining Kaggle "success" modes

`scripts/yiddish-finetune/kaggle-run.test.ts`: **24 / 24** (2 more NEW).

- `a code dataset that is still processing blocks the kernel push` — run 7 spent 25 minutes
  of GPU time on a `train.py` whose fix had been uploaded 30 seconds earlier and was still
  processing. Kaggle served the previous version and said nothing anywhere.
- `a push that Kaggle refused to START is a failure, not a launch` — verbatim
  "Kernel push error: Maximum batch GPU session count of 2 reached." on stdout, exit code 0.

Live: the new guard correctly refused run 8 at 21:29Z (both free GPU slots busy) instead of
reporting a launch; `retry-training-push.sh` is waiting for a slot.
