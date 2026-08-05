# Connect 2 — working rules for Claude

## ⛔ AGENT HANDOFF — IVR Studio: numbers/scheduling/announcements, wizard checkout, ElevenLabs, teams, permissions (2026-08-04) — READ FIRST for IVR Studio, DID switching, onboarding payment, voice generation, or custom-role permission work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IVR_YIDDISH_2026-08-04.md`** (3 sessions appended).

- **The wizard has NO payment screen.** Reaching checkout calls
  `POST /onboarding/:token/checkout` (creates tenant + first invoice in the
  background, idempotent, re-lines an UNPAID invoice if the quote changed) and
  hands to `/pay/invoice/[token]` — the real customer checkout. The public pay
  route detects `metadata.source=onboarding_signup`, FORCES card-vault +
  autopay (upsert, not update — a new tenant has no settings row), marks the
  submission paid, and kicks number purchase + PBX build + welcome emails.
  Never rebuild a second card form; that mistake was made and deleted twice in
  one night (wizard inline form, then a bespoke /admin/card-test form).
  `/admin/card-test` = $1 invoice on the same checkout (super-admin, amount is
  a server constant).
- **Number↔menu scheduling** (`didSwitchSchedule.ts` + `DidSwitchSchedule` /
  `IvrAnnouncementSchedule` tables): the Studio's top step picks which DID
  rings a menu and WHEN — exactly two timing options (now / date+time), end
  never / on-a-date. ⛔ **The scheduler never reimplements the flip** — it
  mints a 2-min SUPER_ADMIN service JWT and drives the EXISTING
  `/voice/did/:id/switch-to-connect|switch-to-pbx` via `app.inject`. "Now"
  executes inside the Studio's publish(); dated switches run on a 60s tick,
  retry 30 min, then mark failed + email ADMIN_ALERT_EMAIL. A failed HAND-BACK
  deliberately stays on Connect (the direction that keeps answering).
- **Pre-menu announcements are END-TO-END LIVE**: one AstDB key
  (`connect/t_<slug>/pre_announce`) set/cleared by the same tick; the dialplan
  patch was applied 2026-08-04 under Izzy's one-time PBX mandate (backup
  `/etc/asterisk/extensions__60_custom.conf.bak.pre-announce.20260804T150419Z`).
  Plays ONCE per call (retries jump to `(prompt)`), skips if the file is
  missing.
- ⛔ **`requirePermission(canManageIvr)` is a ROLE-ONLY check** — custom-role
  portal permissions are invisible to it. Every Studio/DID write must use
  `requireRoleOrPortalPermission(..., "can_manage_ivr_routing" | "can_publish_ivr_routing" | "can_manage_ivr_prompts")`.
  Half the Studio's writes had the bare form: a custom role could open the
  Studio and fail every save. **IVR Migration is super-admin only, with NO
  grantable permission** — nav-hidden AND page-gated (`backendJwtRole`).
- **ElevenLabs greeting generation** (`apps/api/src/voice/elevenLabs*.ts`):
  key lives in AgentSecret (same CREDENTIALS_MASTER_KEY as the agent), asks
  for phone-native `pcm_8000` (no conversion at all; 16 kHz fallback → one
  ffmpeg downsample), IVR-tuned defaults, preview saves nothing, generated
  rows are `source:"generated"` = play-only (no download, `no-store`).
  ⛔ ElevenLabs returns **401 for an UNPAID account** — same code as a bad
  key; `classify()` reads `detail.status` first. `usable:false` ≠
  `keyWorks:false`. Never blame the key on status code alone.
- **Ring groups / waiting lines** ship from the Studio (`MakeTeam.tsx` →
  `POST /voice/teams`): members arrive as extension NUMBERS, resolved against
  ONE live PBX read that also yields free numbers + tenant path; unknown
  extension = refuse whole request; Apply Changes is NEVER fired.
  ⛔ apps/api must not import undeclared packages (`undici` killed the
  container on boot — blue/green refused cutover; guarded by
  `dependencyHygiene.test.ts`; local `require.resolve` LIES, pnpm hoists).
- **Deploys do not queue**: `deploy-direct.sh` fails fast when the queue has a
  running job (a parallel server session deploys the same branch). Wait on
  `curl 127.0.0.1:3910/ops/deploy/status` until `runningCount:0` — never
  `--skip-queue-check`, never `pgrep`-based waiters (they self-match the
  compound command line; cost three dead SSH sessions).
- Yiddish: every new customer-facing screen registers a PHRASES list +
  `useUiLanguage`; phrases are warmed through Yiddish Labs via the agent's
  `/agent/ui/translate` (warm:true). ~240 phrases warmed this engagement,
  0 failures. Never let a `teams.map((t) => …)` shadow the translator `t`.


## ⛔ AGENT HANDOFF — Eli iOS freezes → 443 route, paste-on-iOS-26, build 52 (2026-08-05) — READ FIRST for Displaydex, SIP-over-443, paste reports, voice diag telemetry, or TestFlight builds

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELI_IOS_443_PASTE_2026-08-05.md`**

- **Displaydex is LIVE on SIP-over-443**: nginx `location /sip` on loopcom now
  proxies DIRECTLY to `https://m.connectcomunications.com:8089/ws` (backup:
  `/root/nginx-connectcomms-backup-20260805-0410.conf`); tenant flipped to
  `webrtcRouteViaSbc=true, sipWsUrl=null`. Proven by raw-REGISTER probe → 401.
  Eli must sign out/in (the app never refreshes a cached `sipWsUrl`). Success
  signal: his `PbxEndpointRegistrationEvent.contactUri` = `45.14.194.179` —
  which also means PBX-side contact-IP whois is now MEANINGLESS for this
  tenant; use loopcom nginx logs.
- ⛔ **The `sbc-kamailio` container (loopcom :7443) is an UNFINISHED
  experiment** — dispatches to a nonexistent docker host `pbx`, answers
  `503 PBX Unavailable`, has never carried a call. Never route at it without
  finishing + testing.
- ⛔ **Telemetry traps:** `iceHasTurn:false` in voice diag is meaningless (the
  app never sends the field — server defaults false; RCA "TURN_missing"
  verdicts inherit the lie). A session stuck REGISTERING never heartbeats
  (effect ordering), so `alive:0s` ≠ app died. iOS CallFlightRecorder uploads
  ONE native seed event per call (`deviceId: null` — query by tenant), never
  the JS timeline.
- **Paste broken on Eli's iOS 26.5 but fine on Izzy's older iOS, same build**
  → OS-version incompatibility is the front-runner (permission theory
  retired: menu-paste never needs permission; the Settings row only appears
  after a programmatic clipboard read). Waiting on Eli's long-press
  observation; candidate fix = RN 0.81.5→0.81.6 in build 53 (re-lock pnpm).
- **Build 52 submitted** (launch-screen picker, paste explainer + Deny-wedge
  detector, keyboard-inset commit), attached to "Loopcom Testers",
  WAITING_FOR_REVIEW. Pipeline recipe + `asc-release-52.mjs` pattern in the
  handoff §6. Bump `buildNumber` in **app.config.ts**; `npx --yes eas-cli`
  (plain `eas` not installed on loopcom).
- **QSR prefix route**: dialer only shows routes with a per-user permission
  row. It was assigned to Yehuda by mistake — now Eli-only (not default). A
  duplicate QSR route sits in the QSR tenant itself as clutter.

## ⛔ AGENT HANDOFF — CDR silent loss + live-call sync (2026-08-04) — READ FIRST for "calls missing from history", stuck/vanishing Active Calls, BLF sync, or ANY CallStateStore / CdrNotifier / ARI-poller work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CDR_LIVESYNC_2026-08-04.md`**

- **Calls were being permanently ERASED from call history** (~100–200/day since
  ~June, all tenants — found via "RelaxTires ext 101 sees no calls today").
  The live-call tracker force-evicted live calls off a blind ARI snapshot;
  evictions filed nothing; the 30s retention ate the late Cdr events; api
  deploys ate whatever ended during the restart. Fixed + deployed:
  `5060032f` (4-layer CDR protection incl. orphan-CDR net + Redis retry queue
  `telephony:cdr:retry:v1`) · `2f0850e7` (orphan net skips queue fork legs —
  else one phantom "missed call" PER AGENT per queue ring) · `aa3115d4`
  (live-sync rewrite). 332 lost calls Aug 1–4 backfilled; pre-Aug-1 NOT.
- ⛔ **Liveness = ARI's RAW /channels list (`rawChannelIds`), NEVER the
  qualifying-bridge list.** A queue/RG call is two half-bridges, each with one
  non-Local leg — `computeBridgedActiveCalls` excludes both BY DESIGN. Judging
  liveness by bridge membership is what killed live calls for months. Same
  trap in reverse: the WS page-load snapshot must stay the UNION of the AMI
  store + ARI-only bridges, never either/or.
- ⛔ **Never remove call channels by exact name string.** Asterisk masquerade
  renames (`<ZOMBIE>`) don't match; resolve the recorded name via uniqueid.
  A call with zero live channelIndex entries is OVER that second.
- ⛔ **Every eviction/cleanup path MUST emit `callEvicted`** (→ CdrNotifier).
  A cleanup that only emits `callRemove` silently erases the call's record.
- Backfill recipe gotchas: seed-post `disposition:"unknown"` first (else the
  ingest push-notifies stale missed calls); patch inbound direction post-hoc
  (PBX trunk legs write no cdr row); PBX local-time strings are ~4h skewed —
  derive times from the linkedId epoch. ~63 phantom rows from the first hour
  are HIDDEN via `isForwarded=true`, not deleted.
- Tenant isolation on the live feed: a mid-call tenant correction now
  broadcasts `callRemove` first so the wrong company's screens clear
  instantly. Null-tenant records go to admins only (verified).

## ⛔ AGENT HANDOFF — ElevenLabs "didn't play" + pipeline hardening (2026-08-04) — READ FIRST for ElevenLabs, IVR Studio recordings, or any "audio didn't play in the browser" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELEVENLABS_PLAYBACK_2026-08-04.md`**

- **"Didn't play" was Izzy's CHROME, not the product.** His Chrome's media
  pipeline wedged globally: every `<audio>`/`<video>` stalled at `readyState 0`
  with no error, `play()` pending forever — while `decodeAudioData` worked and
  the server had delivered valid WAV with 200s all four times. Same probe in a
  second browser on the same machine played instantly. Fix = full Chrome
  restart (**unconfirmed at handoff — ask first**); next suspect is his filter
  extension. ⛔ Run the silent-WAV probe (handoff §1) before shipping ANY fix
  for a "didn't play" report.
- Hardening shipped as `16f05d2d` on `feat/ivr-migration-takeover`; **ALL
  THREE HALVES DEPLOYED as of 2026-08-05**: api (container at `9b521176`),
  portal (hardening markers grep-verified inside the live `.next` build), and
  agent (manual compose rebuild 2026-08-05 ~00:30 ET under Izzy's explicit
  permission — the deploy queue has NO agent service, agent is always a manual
  `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml build
  agent && up -d agent`; new container verified healthy with both fixes).
  Highlights: visible preview player + 4s playing-event watchdog + honest
  stall message; timeouts on every modal fetch; 30s server-side read cache +
  single read retry; 12/min per-IP + 4-concurrent synthesis guards; client
  faults 400 not 502; agent hot-reload was missing the ElevenLabs key (saved
  keys were invisible until restart — fixed).
- **2026-08-05: the generate route had never worked** — it selected `slug`
  from Tenant, and **the Tenant model has NO slug column**, so every
  `POST /voice/ivr/prompts/generate` died in PrismaClientValidationError (and
  the portal dialog rendered the raw Prisma dump to the customer). Fixed
  `9b521176`, deployed + live-verified same day. ⛔ `TenantPbxPrompt.tenantSlug`
  is ALWAYS derived from `Tenant.name` via the `toIvrSlug` normalisation
  (lowercase, non-alnum → `_`) — a differently-formatted slug makes rows
  invisible to the prompt list and PBX prefix matching. Handoff doc §5.
- ⛔ **Never retry a synthesis POST** (double-bills characters) and **never
  stress-test against prod** (real money; the offline fake-provider suite in
  `elevenLabsRoutes.stress.test.ts` IS the stress test). 49/49 tests green via
  `node --experimental-test-module-mocks --import tsx --test` in apps/api.
- **`elevenLabs.test.ts` had never run** — it imported vitest, which apps/api
  doesn't install (suite runs node:test via tsx). Rewritten. Same disease
  still in `dependencyHygiene.test.ts`; `smsSharedInbox.test.ts` has one
  pre-existing failure. Both have task chips filed.
- Two status routes look alike: `/api/voice/elevenlabs/status` (API — IVR
  Studio modal) vs `/agent-api/voice/elevenlabs/status` (agent — owner
  settings page). Don't conflate them.

## ⛔ AGENT HANDOFF — voicemail playback wedge / phantom Telecom call (2026-08-04) — READ FIRST for "voicemail shows playing but no audio" or any Telecom Connection work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_WEDGE_2026-08-04.md`**

- **"Plays but no audio until APK reinstall" = a phantom Telecom call.** A ghost
  ring (cancel push racing past the ring push) answered by the user flips a
  Connection ACTIVE that no SIP session ever owns; Android then refuses ALL
  media playback, and the FGS keeps the process (and the phantom) alive through
  everything short of reinstall/force-stop. RSBK101 lived this for days.
- Fixed 2026-08-04: merge `0cd7119b` (`fix/ring-cancel-race` `88d405a7`) +
  four backstops `065bce23` (120s ring self-destruct, stale-aware Telecom
  sweep, dead-invite answer teardown, voicemail playback-stall watchdog with
  self-heal). APK `1.0.0+20260804-202642` published to the download page.
- ⛔ **`telecomTerminateStale` may ONLY be called after verifying zero live SIP
  sessions** — its age gates cannot distinguish a leaked ACTIVE ghost from a
  real hour-long call. Both existing call sites assert this; any new one must.
- `resetCallAudioStateIfIdle` skips while ANY Connection is registered — a
  leaked Connection disarms it. That is WHY the stale sweep exists; never
  "simplify" the sweep away in favor of the reset alone.
- Interim advice for customers on old builds: Settings → Apps → Connect →
  **Force stop**, reopen — equivalent to their reinstall ritual.

## ⛔ AGENT HANDOFF — one tenant per paid sign-up (2026-08-04) — READ FIRST for onboarding billing / tenant work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_SINGLE_TENANT_2026-08-04.md`**

- **FIXED + DEPLOYED (`1f215755` on feat/ai-agent):** paid sign-ups used to create
  TWO tenants — invoice/card/autopay on the checkout tenant, phone system on a
  second one, so month-2 autopay would have charged an empty orphan. The PBX
  build's `ensureConnectTenant` now adopts `submission.createdTenantId`; if the
  background auto-sync raced it, billing is auto-moved to the live tenant and
  the bare orphan deleted (`onboardingBillingAdoption.ts`).
- Historic splits: `apps/api/scripts/backfill-onboarding-split-tenants.ts`
  (dry-run default, `--fix` applies, refuses non-bare orphans). Prod run
  2026-08-04: **0 splits** — wiped test tenants cascade-delete their invoices,
  so an empty result after a test wipe is expected, not suspicious.
- ⛔ Never re-introduce a fresh `tenant.create` in the orchestrator path while
  `createdTenantId` is set; the regression tests in `setupOrchestrator.test.ts`
  ("checkout tenant reuse", "auto-sync race") guard this.

## ⛔ AGENT HANDOFF — filtered internet + reading registration data (2026-08-03) — READ FIRST for any "phone drops / didn't ring" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_FILTERED_INTERNET_2026-08-03.md`**

- ⛔ **Content-filtering internet is the NORM across Connect's user base** (confirmed by
  Izzy 2026-08-03), not an edge case. Assume a filter is in the path until disproven.
- **The one command that settles it:** take the device's contact IP from
  `PbxEndpointRegistrationEvent.contactUri` and **`whois` it**. Datacenter/colo block =
  filtering proxy. Residential ISP = their line. Cellular carrier = genuinely moving.
  Luxure ext 101 on 2026-08-02: **128 of 129 registrations came through one filter**
  (Cologuard `192.157.80.0/20`, Old Bridge NJ) rotating across six addresses; exactly
  **one** went direct over his real ISP. "Unstable Wi-Fi" and "the tablet leaves the
  house" were both concluded — and both wrong — before the whois was run.
- ⛔ **Never report a raw reconnect count as instability. Split it first.** 80 of 128
  reconnects were **under 5 seconds** (lease renewal, invisible to callers); only 33 were
  ≥30 s. 55 sessions sat at a clean **~840 s / 14-minute metronome — a fixed interval is a
  timer, not weather.** Real outages arrive in *clusters* (proxy); a moving device gives
  isolated single drops.
- **The wake-and-wait work (`PLAN_PUSH_AND_WAIT_SIMON.md` Phase 3) is CONFIRMED WORKING** —
  wake→ready measured **0.9 s / 2.0 s / 0.2 s** vs the original 28 s, and the endpoint was
  already REGISTERED at all five calls. **The transport is the bottleneck now, not the wake.**
- Top open items: **WSS/TURN on port 443** (`webrtcRouteViaSbc`) is the platform fix and
  the highest-leverage item; a **241 ms `ANSWER_TAPPED {DECLINE}`** that no human could
  produce; `UI_SHOWN` **3.75 s** after the invite (and absent entirely on another call);
  **outbound app calls produce no `ConnectCdr` row**; voicemail ingest wrote nothing Aug 1–3.
- ⛔ Ext 104 dials Simon's cell but **nothing routes to it — that is deliberate, per Izzy.
  Do not add it to a ring group.**

## AGENT HANDOFF — Voicemail greeting upload + Call-to-Record (2026-08-04) — READ FIRST for greeting work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_VM_GREETING_2026-08-04.md`**.

- **VERIFIED WORKING by Izzy 2026-08-04** on T21 "Landau Home" ext 101 (desktop +
  Android rang simultaneously; greeting saved on the PBX). Fix commits: api
  `707820cb` (instant-originate) + `b6034b7b` (UI push restore), helper
  v2026.08.04.2 `1f216a80` (ring-all contacts).
- ⛔ **The Android ring screen is PUSH-DRIVEN.** A bare SIP INVITE renders NO
  incoming-call UI — the synthetic `INCOMING_CALL` push (inviteId `vmr-<jobId>`)
  must be sent for every mobile device on every vm-record path. Only the WAKE
  push is skipped (it forces a SIP reconnect and churns the shared AOR mid-ring,
  which is what broke answering).
- ⛔ **Dial CONTACTS, not endpoints.** `Dial(PJSIP/<endpoint>)` creates one
  channel even when the AOR holds several registrations. The vm-greeting
  dispatch context expands `PJSIP_DIAL_CONTACTS(base)` + `(base_1)` at dial
  time. The dispatch dialplan lives in THREE synced copies: helper py + two
  embeds in `install-vitalpbx-inbound-route-helper.sh`.
- PBX rollback backups: `/root/helper-backup-20260804-141045.py` and
  `/root/vm-dialplan-backup-20260804-141045.conf` on the PBX.

## ⛔ AGENT HANDOFF — cross-tenant leak + iOS modal keyboard trap (2026-08-02) — READ FIRST for CDR tenant attribution, contacts, or any iOS modal

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CROSS_TENANT_LEAK_2026-08-02.md`**

- ⛔ **Calls were being written into OTHER COMPANIES' call history.** PBX-verified
  over 7 days: 3,517 matched records, **116 filed under the wrong company (3.3%)**,
  11 real customers, both directions — recordings ride along on the record.
  100% came through `tenantResolutionSource = telephony_connect_tenant_id`, which
  **trusted a caller-supplied tenant id outright**. Fixed `05952fb5` + `d6c657ff`
  (API) and `bfaed99e` (telephony). 116 records corrected; reversal at
  `loopcom:/root/cdr_refile_backup_2026-08-02.json`.
- **THE PBX IS THE SOURCE OF TRUTH.** Asterisk stamps the owner into the call
  (`dcontext T102_cos-all`, `PJSIP/T102_101_1-…`) and it cannot be forged.
  Attribution order: **PBX marker → the DID the PBX routed on → the claim (last
  resort only)**. A claim that disagrees is REJECTED. Conflicting markers resolve
  to NOTHING rather than picking a side. **Fail closed** — unattributed is
  recoverable, wrong-company is not.
- ⛔ **A React Native `<Modal>` is its own view hierarchy — this bit 3× in one
  session.** A screen-level `KeyboardAvoidingView` cannot reach inside it (every
  bottom-anchored sheet with an input needs its OWN, iOS-only). A ScrollView does
  not save you if the scroll area is itself under the keyboard. And **`showToast`
  is drawn BEHIND a modal** — use `showAppAlert` inside modals, or failures are
  silent by construction (this made "Open SMS thread does nothing" unexplainable
  for two builds).
- **Check the account can do the thing before debugging the app.** "SMS does
  nothing" was `TenantSmsNumber` having no row for the tenant → 400 every time.
  Two builds were spent on real-but-unrelated UI bugs first.
- **Sanity-check every audit query against the table total.** A voicemail check
  joined on extension NUMBER (not unique across tenants), fanned out, and reported
  30,000+ phantom leaks — more rows than the table holds. Voicemail is CLEAN:
  0 of 34,094.
- iOS: the pre-wake was reporting a **second CallKit call** per call (different id
  → different call identity) — that is the green pill / hang-up-twice. Disabled
  `18fedd9d`. Contacts 1,000-row cap + duplicate-that-named-nobody fixed
  `6e07adfe` + `bab31854`. iOS builds this session: 46 → 51.

## ⛔ AGENT HANDOFF — Android keyboard covers the screen (2026-08-04) — READ FIRST for any Android layout that sits above the keyboard

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANDROID_KEYBOARD_INSET_2026-08-04.md`**

- **`adjustResize` is dead on Android 15+.** `d111c179` moved the app to
  targetSdk 36; Android 15 (API 35) enforces edge-to-edge for targetSdk 35+ and
  stops resizing the window for the keyboard. The manifest still says
  `adjustResize` and the system ignores it, so the IME draws ON TOP of every
  bottom-anchored control. Nothing in the chat code changed — the chat screen's
  `KeyboardAvoidingView` is iOS-only and had always relied on the OS resize.
- Fixed at the app root by `apps/mobile/src/components/AndroidKeyboardInset.tsx`
  (wraps the navigator in `App.tsx`). Two rules inside it must not be
  "simplified": it applies **only on API 35+** (Android 12–14 still resize
  themselves — padding on top of that shifts every screen up twice), and it pads
  by **`keyboardHeight + insets.bottom`** because RN measures the keyboard from
  the top of the gesture bar, so its number is short by exactly that inset
  (45 px / 15 dp on the S24 — this is what left the composer clipped).
- **A React Native `<Modal>` is its own native window** — the root fix cannot
  reach inside it. Modals with inputs need their own `KeyboardAvoidingView`,
  now `behavior="padding"` on BOTH platforms (`NewChatModal` done;
  `ContactPicker` still has none).
- **Measure, do not eyeball.** Screenshot with `adb exec-out screencap -p` and
  scan the pixels; a by-eye adjustment shipped a build that was still 15 dp low.
- ⛔ **Build with `scripts/android-ship.ps1 -SkipJunction`** — Metro cannot
  resolve the entry file through the `.connect-mobile-build` junction.
- Verified on device: `1.0.0+20260802-143118` (the `20260802` stamp is the build
  shell's slow clock, not a stale build).

## ⛔ AGENT HANDOFF — contacts 1,000-cap + ghost call screen (2026-08-02) — READ FIRST for contacts, Android builds, or any "can't save" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CONTACTS_GHOSTCALL_2026-08-02.md`**

- **"Can't save contacts" was TWO bugs.** `GET /contacts` cut at `take: 1000`, so
  Displaydex's 247 contacts past "Sruly Goldberger" never reached the phone —
  invisible AND unsearchable (the tab filters locally). He then kept re-adding
  people from that invisible tail, the server correctly said `duplicate_phone`,
  and the app named nobody. **16 of 16 iOS saves failed; zero contacts created
  since the 31 Jul import.** Fixed: opt-in `limit`+`cursor` paging (no `limit` =
  the exact legacy 1,000-row response, so the unvirtualized portal is untouched),
  mobile `getContacts()` walks all pages behind the same signature, and the 409
  now names the existing contact. Over the cap: Relax Tires 4,010, Create A Box
  2,002, Displaydex 1,247.
- ⛔ **A call-path fix whose premise is not proven from the DEVICE gets reverted.**
  The first ghost-call fix (`a99caa15`) assumed a lingering dead SIP session;
  logcat showed the session was removed cleanly (`sessions:0`) before the app was
  backgrounded. It also made `listSessions()` mutate state and emit events from
  seven call sites. Reverted in `5076f24f`. **Get logcat first.**
- **Real cause:** Android hands a relaunched activity the SAME intent that started
  the task, so `Linking.getInitialURL()` replayed a 19-second-old
  `incoming-call?action=answer` link. The dedupe Set lived in a `useRef` inside
  the provider — destroyed with the tree — and is cleared on every call-idle. Now
  **module scope**, applied only to the `launch` path so a live tap is never
  refused. Cannot affect iOS (that link is Android-native only; iOS uses CallKit).
- ⛔ **Build Android with `scripts/android-ship.ps1 -SkipJunction`** — the path
  junction breaks Metro's entry-file resolution; the MAX_PATH problem it existed
  for is already fixed by the pnpm patches.
- **Build 47 was never uploaded to App Store Connect.** TestFlight held only
  45/35/32, which is why Eli sat on build 45. **Build 48** (commit `63a01a65`) is
  live to "Loopcom Testers", beta review APPROVED.
- **Verify authenticated API routes from nginx logs, not by minting a token**
  (credential reads are blocked). `Loopcom/NN` = iOS build NN, `okhttp` = Android,
  `Mozilla` = portal.
- **Acceptance test still outstanding:** a second `/api/contacts` request carrying
  `cursor=` from Eli's phone — that request IS his missing 247 contacts arriving.

## ⛔ AGENT HANDOFF — iOS CallKit zombie call + TestFlight release (2026-08-02) — READ FIRST for iOS call teardown or any EAS build

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IOS_CALLKIT_TESTFLIGHT_2026-08-02.md`**

- **iOS build 44 (`3d8103af…`, commit `695a53e6`) is VERIFIED ON DEVICE by Izzy.**
  Its twin **build 45** (`27387fbe…`, commit `ecb6071f`, ios-prod) is on TestFlight,
  beta review **APPROVED**, live to the external group "Loopcom Testers".
- **Any deferred call action must re-verify its precondition at FIRE time.** The
  12s deferred decline from build 43 outlived the answer and declined a CONNECTED
  call (proven twice in `voiceDiagEvent`); a ring rejection cannot tear down a
  confirmed dialog, so the SIP session AND the CallKit call both survived → stuck
  green pill + a lock-screen call that had to be hung up by hand. Fixed `4640a04d`.
- **`sip.callState` inside the CallKeep handlers is a STALE render closure.** Ground
  liveness checks in the module-scope SIP singleton (`confirmedAtMs != null`) or refs.
- `nativeCallEndedCleanup` was Android-only — iOS had **no last-session-ended safety
  net** at all. It now ends orphaned CallKit calls, re-verifying no session is live
  after a 1.2s settle.
- ⛔ **`EAS_NO_VCS=1` uploads the WORKING TREE, not the commit — a green EAS build is
  NOT proof the committed tree builds.** A stale `pnpm-lock.yaml` (declared 4
  `patchedDependencies`, locked 1) made every clean checkout unbuildable; fixed
  `0e5207d7`. Re-lock whenever patches change.
- EAS build logs are **brotli**, not gzip. Poll builds by **explicit id**, never
  "newest" — that misreads the previous build and reports phantom failures.

## ⛔ AGENT HANDOFF — Android SDK 54 build + PBX push-and-wait (2026-08-01) — READ FIRST for Android builds or "calls don't ring"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANDROID_SDK54_PUSHWAIT_2026-08-01.md`**

- **The PBX already had push-and-wait and it was dead code.** `[send-mobile-push]`
  in the baseplan is bypassed by an unconditional `Goto` in `[parse-dial-string]`;
  Connect's own `[connect-wake-core]` was allowlisted for T5_101 but structurally
  unreachable. The killer: `PJSIP_DIAL_CONTACTS()` resolves **once** — no contacts
  means `cause 3` in milliseconds and the ring timer never runs. A longer ring
  timer fixes nothing. Live on **Luxure T5 ext 101 only** via
  `[connect-mobile-wake-dial]`; rollback is one `database put`.
- **The Android toolchain was a generation behind** after the SDK 51→54 upgrade
  (iOS builds on EAS hid it). Gradle 8.13 / Kotlin 2.1.20 / SDK 36 / NDK 27.1 now
  pinned. `local.properties` needs `cmake.dir=<SDK>/cmake/3.31.6` and is
  **gitignored** — a fresh Windows clone must add it. Windows MAX_PATH (263 > 260)
  is handled by pnpm patches; **never** try to set `buildStagingDirectory` from the
  root build.gradle ("It is too late to set").
- **Always build with `scripts/android-ship.ps1`** — without `SHIP_BUILD_ID` the
  APK is literally version "1.0.0", which is half of why the whole fleet reported
  that. The app now reports the real OS-level version.
- Published `1.0.0+20260801-231353` **without a two-way call test** (owner's call);
  rollback APK is `connectcomms-v1.0.0+20260730.4.apk`.

## ⛔ AGENT HANDOFF — registration drops & push delivery (2026-07-31) — READ FIRST for any "calls don't ring" report

Full handoff: **`docs/ai-context/AGENT_HANDOFF_REGISTRATION_PUSH_2026-07-31.md`**

- **Before diagnosing ANY "extension doesn't ring" report, pull the 10-day
  `PbxEndpointRegistrationEvent` history first** (exact query in the handoff §1).
  Diagnosing from a single day produced the wrong root cause and a wasted fix round.
  A healthy device shows ~1200 REGISTERED events per 10 days; Luxure T5_101_1 showed 153.
- **The Expo→direct-FCM migration is HALF DONE.** `apps/api` has `fcmDirect.ts`;
  **`apps/worker` has none** and pushes every call ring / wake / cancel over the Expo
  relay. Only **6 of 16** active Android devices have a `nativeFcmToken`, so the other
  10 fall back to the relay even from the API. Keep `expo-notifications` the library
  (that is how the FCM token is obtained); eliminate `exp.host` sends.
- A device that ignores a **direct-FCM** wake is powered off / force-stopped / in
  Samsung "Deep sleeping apps" — **no server or app code can revive it.** Stop
  engineering and check the physical device.
- Live in prod (`cdd5bbdd`): device-registration watchdog sends recovery wake pushes,
  and ALL alerts email `tod10950@gmail.com`.

## AGENT HANDOFF — iOS parity engagement (2026-07-30) — READ FIRST for iOS work

Full handoff: **`docs/ai-context/AGENT_HANDOFF_IOS_PARITY_2026-07-30.md`**
(branch `feat/ai-agent`). Read it before touching iOS call/push/audio code,
the Recents/Contacts swipe rows, voicemail playback, or the iOS build pipeline.

Session-critical facts (details, commits, and evidence in the handoff doc):
- **iOS build 25 (`f8035997…`, commit `d30c60af`, ios-test profile) is VERIFIED
  WORKING by Izzy — the iOS release candidate**, twin of the restored Android
  build `64930350`. Servers run `602de2b3` (VoIP cancel pushes + iOS-visible
  push envelope live on api+worker).
- iOS lock-screen chain is fixed end-to-end: server-driven VoIP cancel pushes
  (stop-ringing on hangup/voicemail/answered-elsewhere/desk-answer), buffered
  cold-start answer-tap replay (`didLoadWithEvents` — MUST stay the FIRST
  listener on BOTH RNCallKeep and RNVoipPushNotification), ring-time SIP
  prewarm, and a `didActivateAudioSession` gate before the mic opens.
- **Never call WebRTC `getUserMedia` outside the immediate dial/answer path on
  iOS** — a launch-time permission probe killed ALL call audio (build 22).
  Permission prompts use expo-av only. Audio changes ship ALONE, one per build,
  with a supervised two-way call test.
- iOS push notifications require the top-level title/body/sound envelope
  (platform-split in `packages/shared/src/expoMobilePushFormat.ts`) — data-only
  pushes render NOTHING on iOS. Android stays data-only.
- Row swipes are react-native-gesture-handler PanGestureHandler — PanResponder
  loses a native race to the FlatList scroll recognizer on iOS. Voicemail list
  fetch stays capped (`maxPagesPerFolder: 2`).
- Builds: Metro needs `--offline` (Izzy's filtered line), dev client connects
  via Tailscale IP `http://100.92.168.53:8081`, EAS builds submit from loopcom
  (`/tmp/connect-ios-build`, `gh` remote, `EAS_NO_VCS=1`), delete-before-install
  + bump `ios.buildNumber` every build.

## ⛔ AGENT HANDOFF — Mobile audio / incoming calls (2026-07-30) — READ FIRST

Full handoff: **`docs/ai-context/AGENT_HANDOFF_MOBILE_AUDIO_2026-07-30.md`**
(branch `feat/ai-agent`). Read it before touching `apps/mobile` SIP/audio,
`preferOpusSdp`, the Telecom anchor, or CDR dispositions.

- **UNRESOLVED at handoff: Izzy reports incoming calls not answering.** First
  action: confirm which APK his phone actually runs — `1.0.0+20260730.2` is a
  broken no-connect build; `.3` (commit `64930350`) is the restored one.
- **⛔ NEVER force opus on INBOUND calls from the app.** Both routes are proven
  harmful: opus-only LOCAL ANSWER → dead mic / one-way audio (JsSIP applies
  createAnswer's ORIGINAL to setLocalDescription; only the wire copy is munged);
  opus-only REMOTE OFFER → libwebrtc rejects it, 488, inbound calls never
  connect. Inbound HD is a PBX-side change only, under an explicit mandate.
- **Acceptance test for ANY audio change**: the call CONNECTS *and* the PBX
  `pjsip show channelstats` transmit counter climbs while the user talks.
  "I can hear them" tests only half the pipe — that is how one-way audio shipped.

## AGENT HANDOFF — Audio/Reliability/Notifications engagement (2026-07-29)

The full handoff for the July 29 all-day session (mobile audio saga, push
notification rebuild, wire-truth SIP liveness, ghost-registration fix, PBX
FEC + wake-rb removal mandates) is committed at
**`docs/ai-context/AGENT_HANDOFF_AUDIO_RELIABILITY_2026-07-29.md`** on branch
`feat/ai-agent`. Read it AND `docs/ai-context/NOTIFICATION_RELIABILITY.md`
BEFORE touching mobile SIP/audio code, push notifications, TURN/relay config,
or the PBX codecs.conf.

Session-critical facts (details + evidence in the handoff doc):
- Published fleet build = `1.0.0+20260729.6` (commit `a0eb96bf`). A `.7`
  candidate (volume-hush + serialized register, commit `a4524f6c`) is built,
  verified on Izzy's phone, and **explicitly NOT published — never publish
  without Izzy's word.**
- Three suspended features need a SUPERVISED incoming-call re-proof, ONE at a
  time (both mic-dead incidents rode builds carrying them): opus-only ANSWERS,
  earpiece loudness boost, presence Equalizer.
- JsSIP discards UA-level pcConfig — per-call `callPcConfig` is the fix; TURN
  creds expire in 24h — `/voice/ice-servers` + register-time overlay keeps
  them fresh. Never regress either.
- PBX mandates live: `[opus] fec=yes, packet_loss=5` (never 10 — it muffles);
  the cowork wake-rb dialplan intercept on T21_101 is DISABLED (backup in
  /root on the PBX).
- The TURN relay (coturn on loopcom) works but is in FRANCE vs the PBX in
  St. Louis (+150ms) — a US relay VPS is the pending purchase/decision.
- One change per build; supervised USB+logcat test before anything
  audio/mic-related reaches Izzy's phone; his sign-off gates every publish.

## Task-dashboard signature routing (ALWAYS APPLY)

Every task I add to the jacob-dev-orchestrator task dashboard MUST carry a routing
**signature** in its title and detail. The signature tells a specific Cursor agent
which tasks are his; he only claims tasks that carry his signature and ignores all
others. This prevents the wrong agent from picking up a task.

Rules:
- Never create a dashboard task without a signature. No exceptions.
- Put the signature in BOTH the title (e.g. `[SIG::CURSOR-CONNECT-01] ...`) and as the
  first line of the detail (`ROUTING SIGNATURE: SIG::CURSOR-CONNECT-01 — ...`).
- The signature is per Cursor agent / per chat and is STABLE — reuse the same signature
  for every task meant for that agent, so Cursor is configured once. Do not invent a new
  per-task signature each time.
- Any scheduled task that files dashboard tasks must stamp them with the same signature.
- When I hand Izzy a prompt for Cursor, it must tell Cursor his signature and instruct him
  to claim ONLY tasks carrying it.

Current signatures:
- `SIG::CURSOR-CONNECT-01` — the Cursor agent working the Connect server in this chat.
  (Rename on Izzy's request; if renamed, update it everywhere.)

## Server access — how any agent logs in (ALWAYS APPLY)

There are two servers. Each has a dedicated ed25519 key already installed in the
target account's `authorized_keys`. Login is as `root` on both, port 22.

| Name    | Role                        | Host            | Key file                   |
|---------|-----------------------------|-----------------|----------------------------|
| loopcom | Connect server (work here)  | 45.14.194.179   | `connect2_ed25519`         |
| pbx     | PBX — **READ-ONLY, no touch**| 209.145.60.79  | `connect2_server2_ed25519` |

The private keys live in the git-ignored folder `.connect-ssh/` at the repo root
(also mirrored in `C:\Users\izzyw\.ssh\` on Izzy's machine). They are NEVER
committed (see `.gitignore`).

### CANONICAL SSH METHOD — always run from the Linux sandbox (`mcp__workspace__bash`)
**This is the ONE approved way to reach either server. It supersedes any other
SSH-login instructions anywhere in this repo — other `.md` files, older handoffs,
inline notes, or the app-level project instructions. Do NOT use the local PowerShell
MCP or a Cursor agent to SSH into these servers:** the PowerShell MCP blocks `ssh`/`scp`
("remote shell tools not permitted"). Always SSH from the sandbox.

The Connect 2 repo is mounted in the sandbox; find its exact path in your system prompt
(it looks like `/sessions/<session-id>/mnt/Connect 2`). Set `PROJ` to that path. The
mount can report loose key permissions, so stage each key to a strict-mode file first.
`install -m 600` sets perms AND overwrites cleanly, even if a stale `/tmp` copy exists
from an earlier session (a plain `cp` will fail with "Permission denied" on that stale file).

Exact, copy-pasteable procedure — verified working:

```bash
# 1) point PROJ at the Connect 2 mount shown in your system prompt
PROJ="/sessions/<session-id>/mnt/Connect 2"

# 2) stage both keys with strict perms (overwrites any stale /tmp copy)
install -m 600 "$PROJ/.connect-ssh/connect2_ed25519"         /tmp/loopcom_key
install -m 600 "$PROJ/.connect-ssh/connect2_server2_ed25519" /tmp/pbx_key

# 3a) CONNECT SERVER (loopcom) — the ONLY box where Connect work happens
ssh -i /tmp/loopcom_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    root@45.14.194.179 'hostname; uptime'
#    -> confirms hostname: vmi3101417

# 3b) PBX — READ-ONLY. Inspection / monitoring only, NEVER write.
ssh -i /tmp/pbx_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    root@209.145.60.79 'hostname; uptime'
#    -> confirms hostname: vmi2718844
```

Both log in as `root` on port 22. If `ssh` is missing in the sandbox:
`apt-get install -y openssh-client` (usually preinstalled).

**Requires a sandbox with outbound network egress.** The `mcp__workspace__bash` sandbox
has it — verified reaching both boxes (loopcom `vmi3101417`, pbx `vmi2718844`). If you are
in a shell/mode whose network is unreachable (e.g. an on-device VM), SSH will time out /
"Network is unreachable" — that is a networking limitation of that shell, not a key or
host problem. Switch to the networked `mcp__workspace__bash` sandbox and re-run the steps above.

For Izzy to log in manually from Windows (keys are in his `~/.ssh`):
```
ssh -i C:\Users\izzyw\.ssh\connect2_ed25519 root@45.14.194.179          # loopcom
ssh -i C:\Users\izzyw\.ssh\connect2_server2_ed25519 root@209.145.60.79  # pbx
```

### Guardrails on server access
- **loopcom (45.14.194.179)** is the only box where Connect work happens, and even
  there: deploy/restart only via the deploy queue; no `git add -A`.
- **pbx (209.145.60.79) is strictly READ-ONLY.** Inspect and report only. Never take
  write actions on the PBX — this is a hard guardrail.
- Never touch payments or pension from either box.

## Other standing rules
- Read-only monitoring runs never take write actions on the Connect server, PBX,
  payments, or pension — report only.
- Hard guardrails on all Connect work: Connect server only; never touch payments,
  pension, or the PBX; deploy/restart only via the deploy queue; no `git add -A`.

## B Visible engagement (2026-07-17 → 07-22) — where the handoff lives

The full agent handoff for the B Visible work done from this chat is committed in the
B Visible repo: `C:\dev\projects\B Visible\docs\AGENT_HANDOFF.md` (commit `1ea222d`,
branch `feat/premium-estimate-editor-workspace`). Read it before touching B Visible.

Session-critical facts for THIS environment:
- Reaching the B Visible server (`deploy@212.56.32.136`) works from the Linux sandbox
  (`mcp__workspace__bash`), key staged from `.connect-ssh/cursor_bvisible` to
  `/tmp/bv_key` with mode 600 (re-stage after sandbox resets — you'll see
  "Permission denied (publickey)"). The local PowerShell MCP blocks any command
  containing the word "deploy" and gates `git push` / recursive deletes behind
  `approved:true`.
- Builds/git for B Visible run ONLY on Windows via the `.agent-run.cmd` batch pattern
  (set PATH **and PATHEXT**; poll `.agent-build.log`; never `-Wait` on long jobs;
  PowerShell needs `-LiteralPath` for paths containing `[id]`).
- A Cursor agent edits the B Visible repo in parallel — `git status` before every
  edit, re-copy current file versions before modifying, never commit their WIP,
  never `git add -A`.

## AGENT HANDOFF — Shammes AI agent / PBX M-capabilities engagement (2026-07-26 → 07-28)

The full handoff for the AI-agent work (DND, hold music, LLM-first parsing,
chat uploads, and the M3/M4/M10 native PBX capabilities) is committed at
**`docs/ai-context/AGENT_HANDOFF_SHAMMES_PBX_MS.md`** on branch `feat/ai-agent`.
Read it before touching `apps/agent`, the `/internal/agent/*` API doors, or
`scripts/pbx/vitalpbx-inbound-route-helper.py`.

Session-critical facts (details + evidence in the handoff doc):
- **VitalPBX's REST `apply_changes` is broken on this build** — returns success
  without regenerating tenant conf files. The PBX helper therefore **bakes**
  changes directly into `/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf`
  (guarded patch: backup + scope check + atomic replace + dialplan reload).
  Never assume a DB write or REST apply reached live routing — verify the baked
  file / `dialplan show`.
- PBX helper deployed at `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py`
  (v2026.08.04.2 as of the vm-greeting engagement, in sync with the repo copy).
  Its `audit.jsonl` is **61 GB** — never grep it whole.
- PBX writes happened ONLY under Izzy's explicit mandates (`dnd-2026-07-26`,
  `moh-2026-07-26`, `pbxcfg-2026-07-28`). The default PBX read-only guardrail
  still stands for anything outside those mandates.
- M3 (inbound routing) + M10 members are live-proven end-to-end through real
  chat on Landau's tenant (T21). M4 (IVR) is built but unproven — the test
  tenant has no IVR, and IVR writes still need the same bake treatment.
- In THIS Cursor environment ssh/scp run directly from PowerShell with the keys
  in `C:\Users\izzyw\.ssh\` — but NEVER pipe file bytes through PowerShell to
  ssh (corruption); always `scp` + remote `py_compile` before installing.

## AGENT HANDOFF — Onboarding automation engagement (2026-07-26 → 07-28)

The full handoff for the automated onboarding work (wizard → VoIP.ms number +
subaccount → VitalPBX tenant build → Connect sync → invite emails, plus the
stress-test wipe procedure) is committed at
**`docs/ai-context/AGENT_HANDOFF_ONBOARDING_AUTOMATION.md`** on branch
`feat/ai-agent`. Read it before touching `apps/api/src/onboarding/`, the
portal wizard, or before wiping test tenants.

Session-critical facts (details + evidence in the handoff doc):
- **Deploys ship from branch `feat/ai-agent`**, via
  `bash scripts/deploy-direct.sh api|portal --branch feat/ai-agent` on loopcom.
  Always verify the container commit afterwards.
- Live gates `VOIPMS_AUTO_PROVISION=on` / `ONBOARDING_PBX_AUTO_SETUP=on` are
  wired in `docker-compose.app.yml`; unset = silent dry-run (statuses
  `ready_dryrun` / `dry_run_done`).
- **VitalPBX panel deletes are TWO-STEP** (delete → re-POST the confirmation
  form's hidden inputs, `mode:"deleteConfirmed"`) and must be verified by
  re-listing — the single-step call "succeeds" without deleting (two earlier
  wipes left every trunk/route/ARS behind because of this). Reference
  implementation: `scripts/onboarding/_wipe-round2.mts`. Order: tenants
  (REST) → ars → trunk_group → trunks. REST `deleteTenant` may exceed 20 s —
  poll for absence on timeout.
- **VoIP.ms**: `setSubAccount` is a full update (partial `{id,password}`
  fails); `createSubAccount` `used_username` self-heals by reusing (commit
  `db4453f8`); subaccounts are `344022_<name>` — suffix-match, never prefix
  with the API login email; `device_type 1` = Asterisk (correct), `2` = IP
  phone (wrong); outages return Cloudflare 521/522 HTML — retry with backoff.
- Test numbers are pre-owned STOCK: wipes re-route DIDs to `account:344022`,
  never cancel them. Spare DIDs show first in the wizard ("Ready now");
  the search cache holds only the purchasable list, spares always fresh.
- Reusable stress-test link token: `stress-WBcv2eWu8GzxdIIP2glmd6O2`
  (`/onboarding/test/<token>` spawns a fresh run). Invites only go out for
  emails never used anywhere on the platform (global uniqueness).
- Ezra's test IP `173.212.214.198` is allowlisted in
  `/etc/nginx/connectcomms/allowlist.conf` (nginx auto-ban hit it mid-test).
- In THIS Cursor environment ssh/scp run directly from PowerShell (keys in
  `C:\Users\izzyw\.ssh\`); server scripts run via scp → `docker cp` →
  `tsx` inside `app-api-1`; DB one-liners pipe JS into
  `docker exec -i -w /app/packages/db app-api-1 node -`.

## AGENT HANDOFF — Mobile Android call-reliability engagement (2026-07-27 → 07-28)

Read this whole section before touching `apps/mobile`. It is the handoff from the
Cursor chat that did the July 27–28 reliability push. Owner's bar for this work:
answering a call must be **instantaneous** ("a blink of an eye"), calls must
survive the app being swiped away, and NOTHING that already works may break.

### Environment / workflow facts (verified working)

- **Test device**: Izzy's Samsung over USB ADB, serial `RFCXC0CEZ6V`. It comes and
  goes — run `adb devices` first; `adb wait-for-device` to block until plugged in.
  The phone is on **T-Mobile, an IPv6-only network** (DNS64/NAT64) — this shaped
  several fixes below.
- **Build**: `cd apps\mobile\android && .\gradlew :app:assembleRelease` (≈5 min).
  Output: `apps\mobile\android\app\build\outputs\apk\release\app-release.apk`.
- **Install**: `adb install -r app\build\outputs\apk\release\app-release.apk`, then
  launch and confirm logcat shows `[SIP] Registered successfully` and
  `[IN_CALL_NOTIF] module-scope action listener installed`.
- **Publish to the download page**: `powershell -File scripts/android-publish.ps1
  -Version "1.0.0+<yyyymmdd>" -ReleaseNotes "..."` — uploads to
  `/opt/connectcomms/downloads` on loopcom via the `connect` SSH alias, promotes
  `connectcomms-latest.apk`, writes the JSON manifest, smoke-tests
  `https://app.connectcomunications.com/api/downloads/connectcomms-latest.apk`.
  Last published: `connectcomms-v1.0.0+20260728.apk`.
- **Known pre-existing `tsc` error** (NOT ours, does not block builds):
  `src/delivery/trackingService.ts` — `Cannot find module 'expo-battery'`. Another
  agent's delivery-tracking work. Everything else typechecks clean.
- **Feature flag**: `standingRegistration` must be `true` on the user's
  `MobileDevice` row (Postgres on loopcom, user `connectcomms`) or the app falls
  back to legacy slow-answer behavior. It is INHERITED on push-token rotation now,
  but if a device re-registers from scratch, re-check it.

### The one architectural rule that explains most of this engagement

**A recents-swipe destroys MainActivity and unmounts the ENTIRE React tree, but
the process (and the JsSIP singleton + WebRTC media) lives on** under the
`SipKeepAliveService` FGS. Anything that must keep working while swiped away —
notification button handling, native notification cleanup, Telecom anchor
teardown, SIP registration — must live at **module scope** (imported via
`sipClientSingleton.ts`) or **natively**, never inside `SipContext`/components.
Three separate bugs came from violating this:

1. Notification Hang Up/Speaker/Mute dead after swipe → fixed by module-scope
   listener `apps/mobile/src/sip/inCallNotificationActions.ts` (installed at
   import time by `sipClientSingleton.ts`). `SipContext`'s listener now ONLY
   mirrors UI state — do not re-add client calls there (double-execution).
2. Remote hangup while swiped left a stale in-call notification + phantom
   Telecom call → `nativeCallEndedCleanup()` in `jssip.ts` (fires on last
   confirmed session ended/failed) calls `stopInCallNotification` +
   `telecomTerminateAnchors`; `TelecomBridge.terminateAnchorConnections()`
   tears down `tc-anchor-*` connections natively.
3. Reopening the app mid-call landed on Teams with no way back to the call →
   `SipContext` mount-effect hydration (`[SIP_HYDRATE]` log tag): reads
   `client.listSessions()`, rebuilds callState/remoteParty/hold, replays
   sessions into `CallSessionManager` (which now buckets already-active/held
   sessions and backdates `answeredAt` from `SipSessionInfo.confirmedAtMs` so
   the timer doesn't restart at 0:00).

### Other landmines (do not regress)

- **`react-native-callkeep` used to KILL THE PROCESS in `onHostDestroy`** — that
  was the original "call dies on swipe" cause. Fixed via pnpm patch
  `patches/react-native-callkeep@4.3.16.patch` (wired in root `package.json`
  `pnpm.patchedDependencies`). Never remove that patch.
- **In-call notification uses PLAIN action buttons, not CallStyle.** CallStyle on
  Samsung One UI rendered the Speaker chip white-on-white and silently dropped
  the Mute action. Buttons: Hang up / Speaker / Mute in
  `SipKeepAliveService.buildInCallNotification()`. Hangup rides a
  `PendingIntent.getService` → `ACTION_NOTIF_HANGUP_SVC` → EXPLICIT broadcast to
  `InCallNotificationReceiver` (implicit broadcasts never arrive) → JS event.
  Notification body tap deep-links `com.connectcommunications.mobile://active-call`
  (handled in `RootNavigator`).
- **Audio routing after connect goes through Telecom, not AudioManager.** Once the
  answer-time Telecom anchor flips ACTIVE, `AudioManager.setSpeakerphoneOn` is
  silently overridden. `IncomingCallUiModule.routeViaTelecom()` routes through
  `Connection.setAudioRoute()` first, falling back to AudioManager. `SipContext`
  re-asserts the user's route 600/1800 ms after anchor activation.
- **T-Mobile IPv6 blackhole**: first WSS connect over synthesized IPv6 can hang
  ~10 s. `SipSocketModule.kt` + `nativeSipSocket.ts` (custom OkHttp WebSocket,
  IPv4-first DNS, 6 s connect timeout) fixed cold-start answer from 10 s → ~0.4 s.
  Do not swap SIP back to React Native's stock WebSocket.
- **CGNAT idle kill**: T-Mobile drops idle sockets ≈5 min. Keepalives: JsSIP
  OPTIONS every 45 s foreground; native heartbeat every 4 min
  (`HEARTBEAT_INTERVAL_STANDING_IDLE_MS`) driving a forced REGISTER refresh via
  the headless task even when JsSIP thinks it's registered.
- **Never re-introduce a VitalPBX tenant PUT / any PBX write** — see the ABSOLUTE
  RULE in `AGENTS.md`. PBX is read-only, enforced in code.

### Shipped in the 2026-07-28 builds (user-visible)

- Instantaneous answer paths (in-app, lock screen, floating notification, cold
  start), `iceCandidatePoolSize: 1`, register watchdogs at 12 s/12.5 s.
- Call survives swipe-away; working notification controls; tap → ActiveCall.
- Speaker/Bluetooth work after connect (Telecom routing).
- Add Call button on ActiveCallScreen (hold current + dial second,
  `allowSecond: true`, reuses `TransferModal` with custom label/icon).
- Voicemail: reload much faster (parallel page fetch in `getVoicemails`, respects
  `maxPagesPerFolder`); Download now saves to the PUBLIC Downloads folder via
  `DownloadsModule.kt` (`ConnectDownloads.saveToDownloads`, MediaStore) with
  filename `Voicemail <caller> <date>.wav`.
- Colored person-icon avatars for unknown numbers (Recents/SMS,
  `colorForName` exported from `Avatar.tsx`).
- Removed the unrequested "Delivery driver" row from Settings.
- Implemented missing `reportDndStatus` in `api/client.ts` (another agent's
  import would have crashed at runtime).

### State at handoff / what to verify next

All of the above is installed on the test device and published to the download
page. Awaiting owner verification at handoff time: hangup/speaker/mute from the
notification **while swiped away**, notification tap → ActiveCall with a running
timer, and voicemail download appearing in Files → Downloads. If a regression
surfaces, start with logcat tags: `IN_CALL_NOTIF`, `SIP_HYDRATE`, `CALL_NAV`,
`MULTICALL`, `SIP_KEEPALIVE`, `CONNECT_CALL_UI`.
