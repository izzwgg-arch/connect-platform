# AGENT HANDOFF — iOS parity engagement (2026-07-30)

**Outcome: iOS build 25 (`f8035997-7e70-4abb-afbb-f51eed8d3a97`, commit `d30c60af`,
ios-test profile) is VERIFIED WORKING by Izzy — "working perfectly".** It is the
iOS twin of the restored Android build (`64930350`) and the current iOS release
candidate. Servers (api + worker on loopcom) run `602de2b3`.

This session took iOS from "lock screen rings forever / answer does nothing /
no notifications / dead mic" to full parity with Android. Read this BEFORE
touching iOS call/push/audio code, the swipe rows, or the build pipeline.

---

## What shipped (commit → what it fixed)

| Commit | Fix |
|---|---|
| `263e90e5` | **Endless lock-screen ringing**: server never sent an APNs VoIP cancel push — api+worker now send `cancel="1"` VoIP pushes on leg-cancel, invite-EXPIRED (voicemail timing; previously NO push at all), sibling claim, and PBX ANSWERED (desk phone). Native cancel branch has a CXCallObserver guard: never ends a connected call. **Dead answer taps**: RNCallKeep buffers pre-JS-boot actions and delivers them ONLY via `didLoadWithEvents` — now subscribed (must stay the FIRST RNCallKeep listener), replayed, then `clearInitialEvents()`. Also dev-only ATS exception (`NSAllowsArbitraryLoads`, dev/ios-dev-device profiles). |
| `df6e389d` | **Row swipes** (Recents/Contacts) rebuilt on `PanGestureHandler` (`activeOffsetX ±12`, `failOffsetY ±12`, flick ≥450px/s or 44px pull, tap-through guard) — PanResponder loses a native race to the FlatList scroll recognizer on iOS. **Badge queryFn error storm** fixed (cache-echo queryFns in TabNavigator). **Dial gate removed** — `sip.dial()` self-registers; gating on a `registrationState` snapshot silently ate taps. **Chat opens instantly** (cache-first thread open/compose). **Voicemail**: list fetch capped `maxPagesPerFolder: 2` (was 30×100×3 requests starving playback), preload covers the visible top-10 + newest/unread (30/50/80MB caps), audio-mode switch awaited (was racing playback into the quiet earpiece route), progress-wave finish sequence no longer fights the position glide. **iOS answer prewarm**: SIP register kicks at VoIP-push ring time → warm fast-path. **Caller number on every surface** (pill, ActiveCall, CallKit line). |
| `602de2b3` | **iOS notifications existed for the first time**: every user-alert push was data-only (Android renders natively from data; iOS renders NOTHING). `buildExpoPushV2Item` now takes `platform` — IOS gets top-level `title/body/sound`; Android stays data-only; call-control types unchanged. Server-side fix — live for all builds. Also first-launch mic-permission priming. |
| `a8f833d4` | **Build-22 total audio kill (self-inflicted)**: the mic priming used WebRTC `getUserMedia` at launch → wedged the audio session → next CallKit call had NO audio both ways. Replaced with expo-av `Audio.requestPermissionsAsync()` (permissions-only). **RULE: never call getUserMedia outside the immediate dial/answer path on iOS.** |
| `d706d20c` | **CallKit audio handoff gate**: incoming answers (app not active) await `didActivateAudioSession` (~100-300ms, fail-open 1200ms) before the mic opens. `[MIC_PROBE]` prints per-second track/audioLevel/packetsSent for 15s on every confirmed call. Caller line = "Name · Number" (Apple gives ONE line; the second is hard-locked to the app name — stacking is impossible; owner chose name-first). |
| `e09f771d` + `64930350` *(other agent, shared code)* | **THE actual cross-platform dead mic**: "HD (opus) incoming audio" re-munged the LOCAL ANSWER — the exact suspended-feature failure from July. Final state: **the app never forces HD/opus on inbound** (see the ⛔ block in CLAUDE.md — both munge directions are proven harmful). |
| `5f598e1d` | iOS Recents "Answered on another device" label; RNVoipPushNotification has the SAME didLoadWithEvents trap (first listener in `src/sip/voipPush.ts`, replays ONLY cancel payloads). |

## Debugging environment (hard-won, use as-is)

- **Izzy's line is content-filtered and blackholes connections.** Metro MUST run
  `npx expo start --dev-client --offline` (manifest requests hang forever
  otherwise — every device "times out"). Expo tunnel (ngrok) is blocked. EAS
  uploads from this PC die with `ECONNRESET`.
- **EAS builds submit from loopcom**: `/tmp/connect-ios-build` clone with `gh`
  remote (github URL from the app repo), `git fetch gh feat/ai-agent`, checkout
  the exact SHA, `pnpm install --frozen-lockfile`, then in `apps/mobile`:
  `EAS_NO_VCS=1 npx --yes eas-cli@21.4.0 build --platform ios --profile ios-test
  --non-interactive --no-wait`. Auth = `/root/.expo/state.json` (copied from
  Izzy's `%USERPROFILE%\.expo\state.json`). Upload takes 1 second there.
- **iPhone dev client connects via Tailscale IP** `http://100.92.168.53:8081`
  (Tailscale ON on the phone; requires the dev-build ATS exception). Home Wi-Fi
  extender blocks phone→PC TCP; MagicDNS name didn't resolve on the phone.
  Tailnet HTTPS is enabled (`tailscale serve` works) if ever needed.
- **iPhone UDID registered**: `00008110-001A34A10113801E`. Profiles: `ios-dev-device`
  (dev client), `ios-test` (standalone + `EXPO_PUBLIC_CALL_FLOW_DEBUG_OVERLAY`).
- **Always DELETE the installed app before installing a new build** and bump
  `ios.buildNumber` every build — same number = iOS may silently keep the old binary.
- **Deploy trap**: after an api deploy, `deploy-worker.sh` self-skips
  ("no worker-relevant paths"); force with
  `DEPLOY_COMMIT=<sha> DEPLOY_FORCE_RESTART=1 bash scripts/deploy-worker.sh`.

## Hard rules distilled this session (violations caused real outages)

1. **Never call WebRTC `getUserMedia` outside the immediate dial/answer path on
   iOS** (build-22 killed all audio). Permission prompts = expo-av only.
2. **Anything touching call audio ships ALONE in its own build** with a
   supervised two-way call test. Never bundled with features.
3. **Never force HD/opus on inbound from the app** — either munge direction
   breaks calls (see CLAUDE.md ⛔ block).
4. **didLoadWithEvents must be the FIRST listener** on BOTH RNCallKeep
   (callkeep.ts) and RNVoipPushNotification (voipPush.ts). Reordering silently
   discards cold-start answer taps / cancel pushes.
5. **Row swipes = react-native-gesture-handler only.** PanResponder cannot win
   against the iOS FlatList scroll recognizer.
6. **Dev client ≠ release build for timing bugs**: debug builds are slow enough
   to mask races (the CallKit audio handoff race never reproduced in dev).
   Release-only behavior must be proven on ios-test builds.
7. Release proof beats theory: the decisive evidence twice came from Izzy's
   minimal A/B tests ("outbound works / incoming doesn't", "Android too").
   Design the discriminating test before writing the fix.

## Open items

- **iOS in-call speaker loudness tuning** — untouched (voicemail loudness IS
  fixed). If pursued: own build, supervised, one change (rule 2).
- `ios-test` carries the debug overlay flag; a true production/TestFlight
  profile is still ahead (plus App Store review considerations for VoIP).
- iOS Local Network permission quirk (dev-client LAN connects) — unresolved,
  bypassed via Tailscale.
- The `[MIC_PROBE]`/`[DIAL]`/`[SWIPE]` logs are intentionally still in — they are
  the black-box for the next audio incident. Console-only, cheap.
