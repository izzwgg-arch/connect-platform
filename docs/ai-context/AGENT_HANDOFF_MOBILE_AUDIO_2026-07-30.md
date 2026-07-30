# AGENT HANDOFF — Mobile audio / incoming-call engagement (2026-07-29 → 07-30)

Owner: Izzy. Plain English only in anything user-facing — he does not read code.
Branch: `feat/ai-agent`. Read this BEFORE touching `apps/mobile` SIP/audio,
`preferOpusSdp`, the Telecom anchor, or the CDR disposition path.

## ⛔ STATE AT HANDOFF — READ FIRST

**Izzy's last report: incoming calls still not answering. UNRESOLVED.**
He is (rightly) furious: three builds shipped in ~12h touched incoming-call
audio, two of them broke calls fleet-wide. Assume nothing below is "fine" until
re-verified on his phone.

| Build | State | Notes |
|---|---|---|
| `1.0.0+20260730.1` | BROKEN | opus-only LOCAL ANSWER → dead mic / one-way audio |
| `1.0.0+20260730.2` | BROKEN | opus-only REMOTE OFFER → inbound calls don't connect |
| `1.0.0+20260730.3` | **CURRENT published** (commit `64930350`) | codec handling restored to the pre-HD state (offers opus-only, answers reorder-only) |

**UNVERIFIED**: nobody has confirmed `.3` on Izzy's phone. His phone was NOT on
USB at publish time (`adb devices` empty), so he may still be running `.2`
(no-connect build). **FIRST ACTION for the next agent: confirm which build his
phone runs before diagnosing anything.** A `.2` phone reproduces "not
answering" no matter what the server does.

## ⛔⛔ INBOUND HD AUDIO — DO NOT ATTEMPT FROM THE APP AGAIN ⛔⛔

Motive was real: `CallQualityHourly` shows inbound PCMU legs at ~2% loss with no
FEC — that is the "hiss" Izzy hears. Outbound (opus) sits near 0%. But BOTH
app-side routes are proven harmful:

1. **opus-only LOCAL ANSWER** (`preferOpusOnlyOffer` on `e.type === "answer"`):
   JsSIP applies createAnswer's ORIGINAL output to `setLocalDescription` and
   only sends the munged copy on the wire (verified in
   `apps/mobile/node_modules/jssip/lib/RTCSession.js`). libwebrtc keeps sending
   PCMU while the PBX — told "opus only" — drops every mic packet as an unknown
   payload type. **Result: one-way audio fleet-wide, both platforms** (shared
   JS). PBX signature: `pjsip show channelstats` rx climbing, tx≈1 toward the
   far leg, ZERO codec/translate errors.
2. **opus-only REMOTE OFFER** (munging `originator:'remote', type:'offer'`):
   this IS applied to `setRemoteDescription` (mechanically correct), but
   libwebrtc rejects the edited offer → JsSIP replies 488 → answer never
   confirms → caller hears ringing until the 30 s dial timeout. **Result:
   inbound calls do not connect at all.** Blackbox signature:
   `INBOUND_SESSION_NOT_FOUND_TIMEOUT`, `sipAnswer {sent:true, confirmed:false}`.

**The only correct path for inbound HD: make the PBX offer opus first to app
endpoints** (endpoint codec prefs / transcode config on VitalPBX). That is a PBX
WRITE — requires an explicit Izzy mandate (PBX is read-only by default) and its
own supervised test cycle. Do not ship it blind.

**ACCEPTANCE TEST for any future audio change (non-negotiable):**
1. the call **CONNECTS**, and
2. `pjsip show channelstats` **transmit** counter toward the far leg climbs
   while the user talks.
"It connected and I could hear them" tests only half the pipe — that is exactly
how the one-way-audio build shipped.

## Codec state currently in code (`apps/mobile/src/sip/jssip.ts`, bindSession `sdp` handler)

```
offers  -> preferOpusOnlyOffer(sdp)   // opus-only. Proven for months. KEEP.
answers -> preferOpusInSdp(sdp)       // REORDER ONLY. Never strip.
remote  -> log only. NEVER munge.
```

## What shipped and was VERIFIED GOOD on 2026-07-29 night (keep these)

All in `1.0.0+20260729.10` / `20260730.1`+, commits `5ae4ead0`, `547e4289`,
`3f4328f6`, `86b612a1`, `fd5ef5a3`:

- **Instant answer (76 ms measured)** — inbound answer SDP goes out at the first
  srflx/relay candidate or a NON-resetting 500 ms cap. Outbound/relay keep the
  1.5 s stall cap. See memory `android-answer-ice-fastpath`.
- **Single-owner Bluetooth routing** — dial-time Telecom anchor, idempotent
  `routeViaTelecom`, 3 s activation-window enforcement, 2.5 s settle window. The
  old 9-shot JS re-assert barrage is GONE and must never return (it *was* the
  audible route flapping). Izzy verified: "It's perfect."
- **`ConnectToneModule`** (native AudioTrack) — DTMF / hang-up / voice-note cues.
  expo-av is silent under `MODE_IN_COMMUNICATION`; all short cues must route
  through `playCue()`.
- **Phantom-anchor leak fix + watchdog** — a never-confirmed OUTBOUND call left
  an ACTIVE Telecom anchor pinning `MODE_IN_COMMUNICATION` system-wide, which
  silenced voicemail/media until force-stop. Outbound now always runs
  `nativeCallEndedCleanup`; a keepalive-tick sweep kills any `tc-anchor-*` with
  zero SIP sessions within 45 s.
- **Voicemail**: uncached Play downloads the raw file (~1 s vs 4–5 s transcode);
  tab focus always light-polls so new arrivals preload.
- **`freezeOnBlur`** on tab screens (killed the multi-second topLayout storms).
- **Call-latency debug OFF in release** (`FORCE_ENABLE_IN_RELEASE = false`).
- **Warm notification taps** navigate (voicemail / missed-call / chat).
- **CDR truth (server-side, deployed)**: `/internal/cdr-ingest` DISP_RANK merge
  (disposition only strengthens) + telephony `deriveDisposition` honouring
  `extensionAnsweredAt` over leg-level NO ANSWER. Voicemail-only answers still
  classify missed (9 tests). Live-proven: "blocked missed-downgrade" log lines.
- **Contact-name resolution** in `/internal/mobile-ring-notify` — saved contact
  name replaces carrier CNAM on every ring surface (server-side, all platforms).
- **Floating incoming-call notification dedupe** — each caller fact once.
- **Dialer clipboard paste** — long-press the number display.

## Open / unresolved

1. **INCOMING CALLS NOT ANSWERING (Izzy, last message).** Verify his build
   first. If he is on `.3` and it still fails, the app-side codec code is back
   to the long-proven state, so look elsewhere: the answer pipeline, the
   Telecom anchor changes from `3f4328f6`, or the PBX/Follow-Me path
   (`T21_ext-followme`; his ext 101 forks to `PJSIP/T21_101` +
   `PJSIP/T21_101_1`).
2. **iOS "Answered on another device"** — never wired (chip task
   `task_02aefe94`). iOS also needs a rebuild to pick up any shared-JS fix.
3. **Remaining JS stalls** — cold-start burst (~12 s block, storage churn) and
   voicemail-list scroll (60 `<View>` waveform bars/card). Chip task
   `task_87422c7f`, full measurements inside.
4. **Inbound hiss** — only fixable PBX-side (see above).

## Working rules Izzy enforces (violating these caused today's damage)

- ONE change per build. Supervised USB + live logcat test before anything
  audio/mic-related reaches his phone. **His sign-off gates every publish.**
- Never revert something he told you to keep without saying so explicitly and
  why. (Today: he ordered HD kept; service had to be restored anyway when calls
  stopped connecting — that call was communicated, but he was already burned by
  two bad builds.)
- Don't ask him diagnostic questions when he is reporting an outage. Get the
  evidence from the phone (`adb logcat`), the API DB, and read-only PBX
  commands.
- PBX is READ-ONLY without an explicit mandate. Never `git add -A`.

## Evidence sources that actually work

- Device: `adb logcat` — tags `SIP_SDP`, `CALL_EVENT`, `audio_route`,
  `CONNECT_TONE`, `JS_LAG`, `IN_CALL_NOTIF`, `SIP_KEEPALIVE_PING`.
- API DB (on loopcom): `voiceDiagEvent` (`CALL_QUALITY_REPORT` payload carries
  the inbound-failure blackbox + `diagnosisCategory`), `connectCdr`,
  `callInvite`, `callQualityHourly`.
- PBX (read-only): `asterisk -rx "pjsip show channelstats"` (the transmit
  counter is the mic-liveness truth), `core show channels concise`,
  `pjsip show endpoint T21_101_1`, `/var/log/asterisk/full`.
