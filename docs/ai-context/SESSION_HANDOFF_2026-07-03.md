# Session handoff — 2026-07-03 (Cowork/Claude session with owner Izzy)

> Purpose: full context transfer so any agent (or future session) can continue
> without re-deriving state. Read `docs/ai-context/CURSOR_START_HERE.md` and
> root `AGENTS.md` before acting on anything below.

## Who you're working with

- Owner: Izzy (izzywkg@gmail.com). Communication preference: **plain English,
  no jargon, concise.** Often uses voice input — expect transcription noise
  (e.g. "Purser"/"torser" = Cursor, "Play Store" sometimes means App Store).
- Wants automation with minimal human-in-the-loop. Frustrated by copy-paste
  shuttling between tools. Likes seeing visual mockups BEFORE building UI.
- Runs Cursor agents on multiple projects in parallel with this repo.

## Hard constraints observed this session (do not violate)

1. PBX (VitalPBX at 209.145.60.79) is READ-ONLY for agents. No config
   mutations ever without explicit owner permission per operation (AGENTS.md).
2. No ad-hoc deploys; direct blue/green scripts for api/portal, deploy queue
   fallback. Never touch `/opt/connectcomms/env/`, nginx, firewall.
3. **Android call flow must not break while iOS work proceeds.** This is the
   owner's #1 stated fear. See "Android isolation rules" below.
4. Mobile OTA updates are disabled by owner directive (app.config.ts) — ship
   only via new builds.
5. Owner's PBX SSH key is deliberately restricted/read-only. Do NOT advise
   creating a full-access key; loosen per-command only if diagnostics need it.

## State of work

### 1. Wake canary + mobile (reviewed, no changes made this session)
- `connect-wake-core` dialplan wake/grace engine, canary-scoped to T2/110 via
  AstDB `connect/wake_canary/T<tid>_<ext>=1`, default-closed (e08e62a5, Jun 30).
- July 2 follow-ups: answered-channel ringback during wake grace (e8f23d73);
  mobile DND published to AstDB to skip wake grace (7451bcda) — fails open,
  72h TTL, best-effort app reporting.
- Canary is platform-agnostic (keyed on endpoint, not device OS). Platform
  split happens in worker push fan-out: iOS = APNs VoIP push (call-only,
  CallKit), Android = Expo/FCM. Dedupe by callId.
- Rollout widening = adding AstDB allowlist keys per endpoint. Not started.
- History warning: Jun 28 iOS cold-answer fix broke Android and was reverted
  (1f5b0766). Treat telephony requeue/CallStateStore as shared arteries.

### 2. iOS production readiness (planned, not yet executed)
Verified already DONE in repo:
- Bundle ID com.connectcommunications.mobile; iOS purpose strings; voip/
  remote-notification/audio background modes (app.config.ts).
- PushKit+CallKit native AppDelegate patching via plugins/withIosVoipPush.js
  (reports CallKit natively before JS boots; deterministic UUID in lockstep
  with src/sip/callkitUuid.ts). Explicitly no-op on Android.
- Worker APNs VoIP sender: packages/shared/apnsVoipPush.ts (APNS_* env vars;
  APNS_PRODUCTION toggles sandbox vs production host).
- eas.json profiles incl. production (autoIncrement buildNumber).
- Phase 7b verification (0141aa2d, Jun 22): cold-killed CallKit ring verified
  on real iPhone. Owner confirms Apple dev account + keys exist, notifications
  and calls work on device.

Remaining TODO (owner approved direction, plain-English framing used):
1. Privacy manifest (PrivacyInfo.xcprivacy) — NOT in repo (grep confirmed).
2. Encryption export declaration (ITSAppUsesNonExemptEncryption) — NOT set.
3. APNS_PRODUCTION flip for TestFlight/App Store builds (server env — owner
   must apply; agents can only prepare the value).
4. Demo account/extension for Apple review (must actually ring; use an
   iOS-only test extension, e.g. enroll in wake canary separately).
5. Store listing: screenshots, description, privacy policy URL, then
   eas submit. App Store (iOS) — owner already on Play Store for Android.
6. Pre-submission dual-platform call regression pass.
7. A readiness checklist doc was offered but NOT yet created.

### Android isolation rules (agreed with owner)
- iOS changes only in iOS-only plugins/modules or Platform.OS==='ios' branches.
- No shared dependency/version bumps justified by iOS work without a separate
  deliberate decision.
- No un-scoped edits to ConnectWakeConsumer, CallStateStore,
  normalizeCallEvent, invite requeue logic.
- Server-side iOS behavior gated on device.platform === "IOS" (existing
  pattern in worker fan-out).
- Gate every change: telephony + mobile pure-logic test suites, plus manual
  Android cold-call smoke before ship.

### 3. Server diagnostics tooling (BUILT this session)
- `scripts/diagnostics/collect-connect-report.ps1` — SSHes (default target
  alias `connect`) and writes read-only health report to
  `_server_reports/connect-report.txt`. `-EverySeconds N` = loop mode.
- `scripts/diagnostics/collect-pbx-report.ps1` — same for PBX (default
  `root@209.145.60.79`), report at `_server_reports/pbx-report.txt`.
- `scripts/diagnostics/watch-both-servers.ps1` — opens both in 60s loop mode.
- `_server_reports/` added to .gitignore.
- Status: owner had NOT yet run them at session end. Next step: owner runs,
  agent reads reports and gives plain-English health summary. If PBX report
  sections are empty, the restricted key likely can't run `asterisk -rx` —
  loosen those specific read commands only.
- NOTE: agent sandbox cannot SSH out (verified: port 22 unreachable). Reports
  are the bridge. web_fetch for HTTPS works.

### 4. Automation discussion (context, no build)
- Owner wanted agent to drive Cursor GUI (paste prompts / press send).
  Explained: typing into IDEs is blocked at tool level; clicking allowed.
  Refused building a mouse/keyboard robot to bypass it.
- Legit alternative offered (not built): file-based prompt queue + PowerShell
  watcher invoking Cursor CLI (`cursor-agent`) per project; agent writes
  prompts/reads results via files. Owner didn't commit yet.
- Preferred split: this agent works Connect 2 directly; Cursor handles other
  projects.

### 5. Dashboard mockups (chat-only, no files saved)
- Rendered in-chat: light concept, faithful dark replica of the real Connect
  desktop dashboard (Gesheft workspace), and a redesign proposal (single
  accent color, trend chips, quick actions, better zero-states). Owner has
  NOT picked a direction. No portal code was changed.

## Task list state
Tasks #1-6 all completed (repo exploration, docs, canary review, platform
split mapping, iOS inventory, diagnostics scripts).

## Sensible next actions (in rough priority)
1. Owner runs watch-both-servers.ps1 → read both reports, summarize health.
2. Create iOS readiness checklist doc + PrivacyInfo/encryption config
   (iOS-scoped, zero Android surface) after owner go-ahead.
3. Confirm APNs production-vs-sandbox plan before first TestFlight build.
4. Optional: build Cursor CLI watcher loop if owner returns to it.
