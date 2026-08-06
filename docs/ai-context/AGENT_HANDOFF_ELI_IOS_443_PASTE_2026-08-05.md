# AGENT HANDOFF — Eli iOS freezes → port-443 SIP route, paste-broken-on-iOS-26, build 52 (2026-08-05)

Session scope: Yossi TestFlight invite, Eli (Displaydex) freeze investigation →
Displaydex moved to SIP-over-443, paste-nowhere report triaged (iOS 26 suspect),
launch-screen picker + paste UX shipped, QSR outbound-route mis-assignment fixed,
TestFlight build 52 submitted end-to-end.

Identities used throughout: Eli = `eli@displaydex.com` (user
`cmnmjhpr40087p96h6azvqucy`, iPhone 17 Pro Max, iOS 26.5.2, device
`cms99cybv02m5nu135dwzzvfq`), tenant Displaydex = `cmnlgryom001fp9paw7le6582`.
Nginx UA check: `Loopcom/48` = iOS build 48.

## 1. Displaydex is LIVE on SIP-over-443 (deployed this session, Izzy-approved)

**Why:** 11 of Eli's 16 app launches over 4 days died stuck `REGISTERING` with
`lastSeenAt == startedAt` (voiceClientSession rows) while HTTPS to the API
worked — the WSS to `m.connectcomunications.com:8089` never connected. Whois of
his 4 egress IPs: Verizon cellular, Verizon FiOS, **Starlink**, Charter — he
roams; no filtering proxy. Port 8089 is the known chokepoint.

**What changed:**
- nginx on loopcom: `location /sip` now proxies **directly** to
  `https://m.connectcomunications.com:8089/ws` (+ `proxy_ssl_server_name on`).
  Prior config backed up at `/root/nginx-connectcomms-backup-20260805-0410.conf`.
- Tenant row: `webrtcRouteViaSbc=true`, `sipWsUrl=null` (the explicit sipWsUrl
  would have overridden the flag — `resolveWebrtcConfig` prefers it).
  `normalizeSipWsUrlHost` only rewrites IP-literal hosts, so
  `wss://app.connectcomunications.com/sip` survives delivery.
- Proven by probe: raw REGISTER over the 443 path → Asterisk `401 Unauthorized`
  (full chain). Probe recipe: node in `app-api-1` +
  `/app/node_modules/.pnpm/ws@8.19.0/node_modules/ws`.

⛔ **The `sbc-kamailio` container (loopcom 127.0.0.1:7443) is an UNFINISHED
experiment.** Its dispatcher targets a docker host literally named `pbx` that
does not exist; it answers `503 PBX Unavailable` and has never carried a call.
The original nginx `/sip` pointed at it — that is why no tenant ever used the
SBC route. Do not route anything at Kamailio without finishing + testing it.

**Still pending:** Eli must **sign out and back in** — the app caches the SIP
address at provisioning and only ever refreshes `iceServers`, never `sipWsUrl`.
Other Displaydex devices migrate lazily (8089 stays open). Success signal:
`PbxEndpointRegistrationEvent.contactUri` shows loopcom's IP `45.14.194.179`.
Tradeoffs: PBX-side contact-IP whois is now meaningless for this tenant (use
loopcom nginx logs); media path unchanged (Starlink loss stays Starlink loss).

## 2. Telemetry traps found while investigating (do not re-diagnose from these)

- **`iceHasTurn:false` in voice diag sessions/heartbeats is MEANINGLESS** — the
  mobile client never sends the field (both callers in NotificationsContext omit
  it); the server defaults false. The CALL_QUALITY_REPORT RCA "TURN_missing"
  verdicts keyed off it are equally unreliable.
- **The 65s diag heartbeat never starts if registration never completes** —
  the effect returns early while `diagSessionIdRef` is null and only re-runs on
  reg/call-state changes. `alive:0s` therefore does NOT mean the app died.
- **CallFlightRecorder on iOS uploads a single native seed event**
  (`IOS_VOIP_HANDLER_INSTALLED`, `result: ios_ring_log`, `deviceId: null`) —
  the JS timeline never flushes on iOS. Also: query iOS flight sessions by
  tenant, not deviceId (deviceId is null).
- CALL_QUALITY_REPORT payloads stamp `platform:"ANDROID"` even for iOS.
- Izzy approved (in principle) the observability plan: fix iOS flight-recorder
  flush → batched console-log shipping with per-device verbose flag → Sentry
  crash/hang reporting. Not built yet.

## 3. Paste broken everywhere on Eli's iPhone — iOS 26 is the prime suspect

- History: **never fixed** — AGENT_HANDOFF_ANDROID_SDK54_PUSHWAIT_2026-08-01 §6.3
  ("Pastable fields") found zero code blockers and Izzy deferred. Re-verified
  this session: no `contextMenuHidden`, plain TextInputs.
- **Permission theory retired:** the "Paste from Other Apps" Settings row only
  exists after an app performs a programmatic pasteboard read; user-initiated
  menu-paste never needs permission. Izzy's older-iOS phone: no row, pasting
  works, no permission ever granted — normal.
- **Same build 48: works on Izzy's older iOS, broken everywhere on Eli's
  iOS 26.5** → OS-version incompatibility is the front-runner (Apple reworked
  the edit menu in iOS 26; RN 0.81.5 predates it).
- **Waiting on Eli:** long-press in any text field — no menu at all / menu
  without Paste (→ framework issue; try RN 0.81.5→0.81.6 bump in build 53,
  re-lock pnpm per the EAS lockfile trap) / Paste appears but inserts nothing
  (→ pasteboard layer) / works (→ field-specific).
- Shipped meanwhile in build 52: first-run iOS paste explainer
  (`usePastePermissionPrompt.ts`, mirrors the battery-prompt pattern) and a
  KeypadTab detector — clipboard `hasStringAsync` true + `getStringAsync`
  empty = the Deny wedge → alert with Open Settings deep link instead of a
  silent no-op.

## 4. Launch-screen picker (build 52)

Settings → Preferences → **Launch Screen**: tap-to-cycle Team (default) /
Keypad / Recents / Messages / Voicemail. Device-local AsyncStorage
(`src/config/launchTab.ts`), feeds `initialRouteName` read once at
TabNavigator mount (one-frame null while AsyncStorage answers). Deep links,
call screens, badges untouched. Same JS on both platforms; no server piece.

## 5. QSR prefix outbound route — was assigned to the wrong user

Dialer shows only routes with a `userOutboundRoutePermission` row for that
user (`GET /me/outbound-routes`). The 2026-07-31 setup created the QSR
(prefix 99) route TWICE — once in the QSR tenant itself (first attempt,
assigned to a QSR user, still there as clutter) and once correctly under
Displaydex, but assigned to **Yehuda**, not Eli. Fixed this session, per Izzy:
Eli granted (enabled, NOT default — his primary line stays default), Yehuda's
permission row deleted. The dialer re-fetches routes on every keypad focus —
no build needed.

## 6. TestFlight build 52 — APPROVED and live to testers

Contents: launch-screen picker, paste explainer + detector, Android-15
keyboard-inset commit (was live-published as APK but uncommitted). Commits on
`feat/ivr-migration-takeover`: `6ff698fa` (keyboard), `3a7686f5` (features),
`97ce7b00` (buildNumber 52). Android APK build explicitly skipped by Izzy.

Working pipeline recipe (all on loopcom):
`/tmp/connect-ios-build` → `git fetch gh <branch>` + checkout the pushed
commit → bump `buildNumber` in **app.config.ts** (there is no app.json) →
from `apps/mobile`: `EAS_NO_VCS=1 npx --yes eas-cli build -p ios --profile
ios-prod --non-interactive --no-wait --json` (plain `eas` is not installed) →
poll by **explicit id** → `eas-cli submit -p ios --id <id>` →
`/root/.appstoreconnect/asc-release-52.mjs` (wait processingState VALID →
attach to betaGroup `fe508ee6-4a3f-49dd-bf53-858839fa2f06` "Loopcom Testers" →
POST betaAppReviewSubmission). EAS build id
`a19589cf-db1e-4644-a5ad-b62aca2855f3`; ASC highest build was 48 (49–51 built,
never uploaded). Yossi@yossiswoodworx.com added as tester + invite email sent
(tester id `8f58ece6-375d-4459-a53d-296a84a83c3a`).

**Beta review: APPROVED** (re-confirmed against ASC later the same day — 52, 48
and 45 all VALID + APPROVED, none expired). Testers get 52 automatically.

### 6a. Inviting testers — the two traps

Roster as of 2026-08-05 evening (group "Loopcom Testers"): `eli.lovi@outlook.com`
INSTALLED, `izzwgg@gmail.com` INSTALLED, `fixupusa1@gmail.com` **INSTALLED**
(accepted this evening after a re-invite — it had sat INVITED since 08-02),
`yossi@yossiswoodworx.com` INVITED, `leibfrankel0999@gmail.com` INVITED
(Leib Frankel, added this evening for Fixup Group's **second** device).

- **Re-send an unclaimed invite**: `POST /v1/betaTesterInvitations` with the
  betaTester + app relationships. Worked for Fixup, who accepted within minutes —
  a stale INVITED row usually just means the original Apple email got buried.
- ⛔ **You cannot re-invite a tester who already accepted** — the same call
  answers **409 `STATE_ERROR.TESTER_INVITE.ALREADY_ACCEPTED`**. One invite is
  consumed by one Apple Account, permanently.
- ⛔ **Therefore "put it on my second phone" has two different answers, and
  guessing wastes an email**: SAME Apple Account → install TestFlight and sign
  in, the app is already listed, **no invite exists to send**; DIFFERENT Apple
  Account → add that address as its OWN betaTester (`POST /v1/betaTesters` with
  the betaGroups relationship — Apple sends the invite itself). Ask which before
  acting. Fixup's second device was the different-account case (Leib).
- Adding a tester needs `firstName`/`lastName`; there is still **no PATCH for
  betaTesters** (a wrong name means delete + re-add, firing a second invite).
  Ad-hoc scripts used: `/tmp/asc-check52.mjs`, `/tmp/asc-reinvite-fixup.mjs`,
  `/tmp/asc-add-leib.mjs` on loopcom (same JWT preamble as
  `/root/.appstoreconnect/asc-tfstate.mjs`).

### 6b. Emailing a customer as support@ — the working route

The Gmail MCP can **draft but not send**. To actually reach a customer from
`support@connectcomunications.com`, insert an EmailJob straight into prod
(`docker exec -i -w /app/packages/db app-api-1 node -`): `tenantId` (required),
`toEmail`, `subject`, `htmlBody`, `textBody`, `status:"QUEUED"`,
`nextRunAt: new Date()`. The `type` is a free string — the api's pump
(`apps/api/src/server.ts` ~1078) takes anything QUEUED regardless of type and
sends within ~1 min. **Verify by polling the row to `SENT`** rather than
assuming. Three went out this way (Fixup setup instructions, Fixup second-device
instructions, Leib invite instructions), all confirmed SENT.
⛔ `User` has **no `name` column** — it is `firstName`/`lastName`/`displayName`;
a `select: { name: true }` dies in PrismaClientValidationError.

## 7. Open items

1. Eli sign-out/in → verify 443 registration (contactUri = 45.14.194.179) and
   whether stuck-REGISTERING launches disappear.
2. Eli's long-press paste observation → decides RN 0.81.6 bump (build 53).
3. iOS speaker-off: no route verification exists on iOS
   (`verifyAndEnforce` is Android-only; `getAudioDevicesSnapshot` returns a
   static fallback) — state desync makes the button look dead. Needs
   instrumentation + fix; VoiceChat mode guardian IS present in build 52.
4. Observability plan (§2) — approved in principle, not built.
5. Duplicate QSR route in the QSR tenant — clutter, awaiting Izzy's call.
6. Kamailio SBC: finish or retire (currently bypassed, running, unused).
7. ~~Beta review approval for build 52~~ — **DONE, APPROVED** (§6).
8. Leib Frankel (`leibfrankel0999@gmail.com`, Fixup Group's second device) is
   INVITED — watch for the flip to INSTALLED. Yossi is still INVITED from the
   morning; if either stalls, re-send per §6a (they have not accepted, so the
   409 does not apply).
