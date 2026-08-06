# Handoff — RSBK ext 101: in-call audio flapping (speaker ⇄ earpiece)

Prepared 2026-07-31 ~05:50 UTC. All findings below were verified against prod
and the repo; nothing here is inferred from `ship-proof.json` (see warning).

## The report

The owner of RSBK ext 101 reported that during a live call the audio kept
switching between speakerphone and earpiece — back and forth, unstable. It
recurred on a call around 00:20 EDT on 2026-07-31.

## Identifiers

| Thing | Value |
|---|---|
| Tenant `RSBK` | `cmqtgxtwr1rhgmk130kw0ustz` |
| Extension 101 ("Appointments") | `cmqtgxud21rhkmk13za6a5mi0` |
| Owner user | `cmqtgxugw1rhomk13njp7c3o5` (sh9673@gmail.com) |
| Main DID | 8453050203 |

Devices on ext 101 (all Android, all report `appVersion: "1.0.0"`, all have
`featureFlags.standingRegistration = true`):

- `mobile-android-ms59dphn-hct0u6qr` — SM-S918U (S23 Ultra), Android 14,
  install created 2026-07-28T23:00:03Z, **nativeFcmToken present**
- `mobile-android-mrbavcl4-05lguyes` — SM-S911U, Android 16,
  created 2026-07-07T23:48Z, no nativeFcmToken
- `mobile-android-mqjvs5eh-335euzr9` — SM-S918U, Android 14, created
  2026-06-18, last seen 2026-07-28 (stale row, likely pre-reinstall)

## Prime suspect

`apps/mobile/src/audio/audioRouteManager.ts`. Its own class comment documents
this exact symptom: while a Telecom anchor owns call audio,
`AudioManager.isSpeakerphoneOn` is stale, so the 1.5 s in-call device poll
re-applied routing every tick and fought Telecom — audibly flipping the user's
speaker on and off mid-call. Annotated in-code as "reported live 2026-07-28".

Fixes that landed (UTC):

| Commit | When | What |
|---|---|---|
| `f2117f2f` | 2026-07-27 23:46 | standing SIP registration + Telecom anchor — **introduces the mode this bug lives in** |
| `8810ae3b` | 2026-07-28 23:25 | stop re-applying route on `speakerphoneOn` changes; async device poll |
| `9bab4b63` | 2026-07-29 17:09 | speaker route enforcement via `getCommunicationDeviceType` |
| `5ae4ead0` | 2026-07-30 02:23 | settle windows (`SETTLE_WINDOW_MS = 2500`), single-owner Bluetooth (`bt_deferred_to_anchor`) |

## What the live download build actually contains — VERIFIED

The APK currently served by the Connect download page:

- Served from `/opt/connectcomms/downloads/connectcomms-latest.apk` on loopcom
  (45.14.194.179), bind-mounted into `app-api-1` at `/var/lib/connect/downloads`
  (`APK_DOWNLOAD_DIR`), route `/mobile/android/download`
- Published as `connectcomms-v1.0.0+20260730.4.apk`, promoted to `latest`
  at **2026-07-30 10:21:07 EDT**
- SHA-256 `7c664cc9debf98b1217a455ab07201e03e08b46f8cb478b3d676f1d93ea21f4b`
  — byte-identical to the local build at
  `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`,
  built 2026-07-30 09:42:42 EDT
- Its JS bundle **contains** `device_change_ignored_settling`,
  `verify_skipped_settling`, `drift_detected`, `bt_deferred_to_anchor`,
  `getAudioDevicesAsync`, `getCommunicationDeviceType`

**So the live build has all three audio fixes.** It does *not* contain
`cdd5bbdd` / `20ca197b` (registration-drop hardening, ~20:50 UTC Jul 30) or
`228c88de` (Jul 31 05:19 UTC) — all cut after the build.

> **WARNING:** `apps/mobile/ship-proof.json` is **stale** — it still reads
> `20260727-204900`. Do not use it to determine what shipped. Use the server
> download directory plus `sha256sum`.

## The blocking unknown

**We cannot determine which build is physically on his phone.**

- `MobileDevice.appVersion` is `"1.0.0"` for all 86 Android devices, because
  the register payload sends `Constants.expoConfig?.version` — the static JS
  config value — not the native `versionName` carrying `+<shipId>`.
  See `apps/mobile/src/context/SipContext.tsx:395` and
  `apps/mobile/src/context/NotificationsContext.tsx:4917`.
- `keepAliveSnapshot` keys all date to May/June, so they don't discriminate.
- No adb access to the device (owner is remote).

## Why the symptom is invisible server-side

Every routing decision logs through `console.log('[audio_route] …')` — logcat
only. None of it is uploaded. **No `CallFlightSession` will ever show the
flapping**, so this cannot currently be diagnosed remotely at all.

## Telemetry state as of 2026-07-31 05:46 UTC

- Last call: `connectCdr` 2026-07-31T04:20:42Z, incoming 3477421231 →
  8453050203, answered, 28 s
- **No `CallFlightSession` was uploaded for it.** System-wide there was exactly
  one flight session in 6 h, belonging to Luxure (`cmnlgryob001cp9pafjjqyc99`)
- His flight-session uploads appear to have stopped after ~2026-07-30T21:34Z —
  worth investigating on its own
- `MobileDevice.lastSeenAt` only updates on full `/mobile/devices/register`;
  the wake-register path does not bump it. The device *was* alive
  (`DEVICE_REGISTER_COMPLETE` at 04:20:49Z)
- CallInvites to ext 101: 5 in 8 h, all `CANCELED`

## The fork that decides the next move

If his phone runs `20260730.4`, the flapping is a **regression in the new
routing code** — his 2026-07-30 problem calls ran 16:38–17:34 EDT, roughly six
hours after that build went live at 10:21 EDT. If he's on something older, it's
simply a stale install. Resolve this before choosing between "ship a build" and
"debug the fix".

## Recommended next steps

1. **Make it observable.** Emit `[audio_route]` transitions as
   `CallFlightSession` events — `AudioRouteManager` already tracks everything
   needed (`currentRoute`, `userOverride`, `lastSnapshot`, `drift_detected`,
   settle-window skips).
2. **Fix version telemetry.** Send the native `versionName`
   (`Constants.nativeAppVersion`, or the shipId explicitly) in the register
   payload so "what build is this phone on" is answerable from the admin console.
3. Investigate why flight-session uploads stopped for his device after
   2026-07-30T21:34Z.
4. Only then decide rebuild vs. regression hunt.
5. If it is a regression, suspect: `verifyAndEnforce` drift correction racing
   Telecom anchor ownership; `SETTLE_WINDOW_MS = 2500` being too short on
   Samsung One UI; the `btAnchorDeferUsed` one-shot on outbound calls.

## Access notes / gotchas

- SSH: `ssh -i ~/.ssh/connect2_ed25519 root@45.14.194.179` (loopcom, prod)
- DB: pipe JS into `docker exec -i -w /app/packages/db app-api-1 node -`
  using `PrismaClient`
- Schema gotchas hit during this investigation:
  - `User` has no `name` field — use `displayName` / `firstName` / `lastName`
  - `CallWakeEvent` uses `occurredAt` (not `createdAt`) and `details` (not `detail`)
  - The CDR model is `connectCdr`
- Repo was on branch `feat/expo-sdk54-upgrade` throughout; no code was modified
  during the investigation (read-only: git history, prod queries, APK hashing)
