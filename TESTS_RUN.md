# Tests run

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
- Still not proven: no TELNYX-number live send, no real Telnyx webhook events (URL/public key not configured), backup route never fired in prod (tests only).

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
