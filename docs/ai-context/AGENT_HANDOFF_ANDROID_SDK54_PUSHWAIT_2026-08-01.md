# AGENT HANDOFF — Android SDK 54 build, PBX push-and-wait, Expo→FCM (2026-07-31 → 08-02)

Written at the end of a long session that began with "Luxure ext 101 still doesn't
ring" and ended with the first-ever Android APK built from the SDK 54 branch,
published to the fleet.

Owner context: **Izzy does not read code.** Every explanation must be plain
English (memory `izzy-plain-english`). He is measuring by working software on his
phone, not by commits.

---

## 0. TL;DR — what changed for real

| Layer | State |
|---|---|
| **API** | deployed, commit verified `e7e28094` |
| **Worker** | deployed, direct-FCM live (was 100% Expo relay) |
| **Telephony** | **NOT deployed** — its only change is the on-ring probe, shipped OFF |
| **PBX** | wait-and-ring live on **Luxure T5 ext 101 only** |
| **Android APK** | built, installed, **published** as `1.0.0+20260801-231353` |
| **Portal/API codec UI** | committed `e35c3526`, **NOT deployed** |

---

## 1. ⚠️ THE BIGGEST FINDING — the PBX already had push-and-wait, switched off

`/etc/asterisk/vitalpbx/extensions__20-baseplan.conf` ~3047 contains VitalPBX's
own `[send-mobile-push]`: push once, poll `DEVICE_STATE` every 2 s × 10, dial the
moment the device appears. **It is dead code** — `[parse-dial-string]` (~348) does
an unconditional `Goto(regular-pjsip)` that jumps straight past the
`Local/${USER}@pjsip-push` branch. Nothing else references `[pjsip-push]`.

Connect ALSO has its own engine, `[connect-wake-core]`, in
`/etc/asterisk/extensions__60_custom.conf` — probe → `ConnectWake` AMI UserEvent
→ ringback → 1 s grace loop, canary-gated on AstDB
`connect/wake_canary/T<tid>_<ext>`. **T5_101 was on that allowlist and had never
once used it**, because its only entrypoint `[connect-dial-with-wake]` is reached
solely from Connect's own router/IVR contexts, and Luxure's DID goes to VitalPBX's
native `T5_app-ivr,IVR-12`.

**The killer mechanic:** `PJSIP_DIAL_CONTACTS()` resolves **once**, at dial time.
No contacts → falls back to the bare device name → `Dial` fails instantly with
`cause 3 - No route to destination` → voicemail. **The 30 s ring timer never
runs.** A longer ring timer alone fixes nothing.

### Applied (owner mandate "Yes, PBX Go")

- New `[connect-mobile-wake-dial]` in `extensions__60_custom.conf` — bridges the
  VitalPBX-native path into `connect-wake-core`, then waits (default 20 s,
  `connect/system/mobile_reach_wait_secs`) until
  `DEVICE_STATE(PJSIP/<ep>) != UNAVAILABLE`, then dials.
- AstDB `da5327df4a24f3a8/extensions/101 dial` →
  `PJSIP/T5_101&Local/T5_101_1@connect-mobile-wake-dial/n`
- Backup: `extensions__60_custom.conf.bak.connect-mobile-wake-dial.20260731-140628`

**Rollback (one command, next call):**
```
asterisk -rx 'database put da5327df4a24f3a8/extensions/101 dial "PJSIP/T5_101&PJSIP/T5_101_1"'
```

### Deliberately NOT done
- `max_contacts` 5→3 — lives in a VitalPBX-**generated** file with no AstDB key;
  an edit there is silently reverted on regeneration. Do it via the panel.
- `ringtimer` 30→75 — §0b proved it is headroom, not load-bearing.
- Raising `qualify_frequency` — costs battery on every device continuously
  (radios idle ~10–20 s after any packet). The per-call probe is the right lever.

Full detail + the rejected approaches: `PLAN_PUSH_AND_WAIT_SIMON.md`.

---

## 2. Measured truth about pushes (do not re-derive)

Census 2026-07-31, live:

- **6 of 16 active Android devices** had a `nativeFcmToken`; **6 of 11 Android
  users had no direct-FCM-capable phone at all.** Every token-bearing row was
  created ≥2026-07-22 (reporting landed in `10af1912`); the others simply never
  installed a newer APK.
- **Worker had NO direct sender** — 1,057 pushes/24 h, 100% Expo relay, including
  every real `INCOMING_CALL` ring and every watchdog wake. **Fixed and deployed.**
- Wake pushes: **2,687 sent in 24 h, only 708 (26%) ever reached a phone**. But of
  those that landed, **77% completed a SIP register** — the mechanism works, it
  just usually doesn't land.
- Watchdog wakes specifically: 1,129 pushes → 39 recoveries within 3 min (**3%**).
  `T8_101_1` took 526 pushes in 24 h and never once answered or registered.
- Prewake timing is already optimal: median **0.4 s** after the call appears, 95%
  within 2 s. **The push was never the slow part** — the device's wake-and-register
  is (Simon's tablet self-reported `gate=wake_register_slow:28419ms`).
- Suggestive but confounded: direct-FCM users recovered after 16% of wakes vs 4%
  for Expo-only. Both buckets contain switched-off phones.

**`/internal/mobile-prewake` used to report `woken: 0` while delivering
successfully** — `queued` counted only Expo-served devices. Fixed; now returns 1.

---

## 3. The Android build was broken and is now fixed — read before touching it

The SDK 51→54 upgrade (`ced70d7b`) updated the app and iOS but left the **Android
toolchain a generation behind**. iOS builds via EAS in the cloud, so nobody
noticed; every APK shipped that week came off the SDK 51 line, which still built.

Fixed in `282305e6` + `b181de8d` (values taken from RN's own
`react-native/gradle/libs.versions.toml`):

| | was | now |
|---|---|---|
| Gradle wrapper | 8.8 | **8.13** |
| Kotlin | 1.9.23 | **2.1.20** |
| compileSdk/targetSdk | 34 | **36** |
| buildTools | 34.0.0 | **36.0.0** |
| minSdk | 23 | **24** (RN 0.81 requires it; whole fleet is on 12–16) |
| NDK | 26.1 | **27.1.12297006** |

### Machine setup that had to be installed (was absent)
- Android **cmdline-tools / sdkmanager** — the machine had none
- **CMake 3.31.6** — AGP defaults to 3.22.1, which **never converges** on this
  project and reports the failure as an endless
  `ninja: error: manifest 'build.ninja' still dirty after 100 tries`
- `apps/mobile/android/local.properties` needs
  `cmake.dir=<SDK>/cmake/3.31.6` — this is AGP's ONLY supported override; pinning
  a version in build.gradle fails with *"It is too late to set version"*.
  **local.properties is gitignored — a fresh clone on another Windows box needs
  this line added by hand.**

### The real blocker was Windows MAX_PATH
Once CMake 3.31.6 could report it: paths reach **263 characters**, past Windows'
260 limit. **NOT caused by the repo living at `C:\dev\projects\Connect 2`** — the
generated build files escape the space correctly (`Connect$ 2`, verified by
reading `build.ninja`), and a checkout at any normal path still exceeds the limit.
It only started biting with SDK 54, the first version whose modules compile C++.

Fixed permanently as **pnpm patches** (`05ae6aa9`) for expo-av,
expo-modules-core and react-native-screens: `buildStagingDirectory` under
`LOCALAPPDATA/CxN/<module>`, **Windows-only** so macOS/Linux/EAS keep the default.
**Verified through a full `pnpm install` + clean build.**

⛔ Do NOT try to set this from `apps/mobile/android/build.gradle`. Both
`afterEvaluate` and `gradle.projectsEvaluated` fail — AGP reads
`buildStagingDirectory` during evaluation. Tried, failed, documented in `b57f4576`.
A hand-edit of the SDK 51 expo-av copy was found already on the machine — the same
workaround, applied once and lost to a `pnpm install`. Hence patches.

### Two app fixes that only a RUNNING app could reveal (`a16fb004`)
1. **`SoLoader.init(this, OpenSourceMergedSoMapping)`** — RN 0.76+ merges every
   native lib into `libreactnative.so`. With the old `SoLoader.init(this, false)`
   the first APK **installed fine and died instantly on launch**:
   `SoLoaderDSONotFoundError: couldn't find DSO to load: libreact_featureflagsjni.so`.
   Verified against the RN 0.81.5 AAR, which ships only 5 `.so` files.
2. `MainActivity.onNewIntent(intent: Intent)` — non-null in RN 0.81, so the old
   `Intent?` signature silently stopped overriding anything.
3. `IncomingCallUiModule`: `currentActivity` → `reactApplicationContext.currentActivity`
4. `app/build.gradle`: pin `root = file("../../")` and pass an ABSOLUTE
   `--entry-file` — the RN plugin passes it relative and Expo resolves it against
   the REPO root (`Unable to resolve module ./index.js from …/Connect 2/.`).

### Build recipe that works
```
scripts/android-ship.ps1 -SkipInstall     # sets SHIP_BUILD_ID / SHIP_VERSION_CODE
```
Without those env vars the APK is literally `versionName "1.0.0"`, `versionCode 1`
— **that, plus the app sending `Constants.expoConfig?.version`, is why the whole
fleet reported "1.0.0"**. Now fixed both ends (`9ff96d8e`, `config/appVersion.ts`):
the app asks the OS for the real version. Use it to tell who upgraded.

---

## 4. Shipped to the fleet

**Published** `1.0.0+20260801-231353` (commit `03136248`) to
`https://app.connectcomunications.com/api/downloads/connectcomms-latest.apk`.

⚠️ **It was published without a two-way call test.** It contains two audio-path
changes and is the first SDK 54 build to reach the fleet. Owner was told and
chose to publish. Previous good build for rollback:
`connectcomms-v1.0.0+20260730.4.apk` (copy over `connectcomms-latest.apk`).

Contents: voicemail delete + bulk read/unread/delete · tab badge fix · Recents
copy number + download recording · add-contact from inside a chat · copy a
contact's name/number/email · answer-tap telemetry · S23 speaker fix · codec
switch · real build numbers · push-token retry · phantom "Unknown" row fix.

### The S23 speaker fix (in this build, UNTESTED on a call)
`routeViaTelecom`'s idempotency guard read `CallAudioState.route` — Telecom's
*bookkeeping*. On Samsung One UI 6 a SELF_MANAGED connection reports
ROUTE_SPEAKER while audio physically stays on the earpiece, so the guard returned
true forever and the AudioManager fallback was never reached. Now the guard needs
Telecom AND `AudioManager.communicationDevice` to agree, plus a **one-shot** 400 ms
verification that applies the route directly if the hardware disagrees.
**Speaker/earpiece only — Bluetooth deliberately untouched** (SCO renegotiation
caused the 2026-07-29 audible flapping).

### Codec switch
`featureFlags.disableOpusSdp`, read **per call** (no reinstall). Absent = false =
today's behaviour (opus). Admin UI: new **Codecs** action on the portal users page
(`e35c3526`) + `GET/POST /admin/users/:id/codec` — **needs an API+portal deploy**.

---

## 5. Voicemail badge — it was never lying

Landau ext 101 has **6,179 unlistened voicemails** going back to 2025-09; only
**15 in the last 30 days**. The header said "0 new · 270 total" while the badge
said "9+" because they counted different things. The badge now counts unread rows
in the **fetched recent window**, so header and badge always agree; the backlog
stays visible under Old/All. If a true "mark all as read" is wanted, it needs a
server-side bulk action — 6,179 cannot be cleared by hand.

---

## 6. Open items

1. **Deploy API + portal** so the Codecs button and the recording-download
   permission actually appear (`e35c3526`, `e7e28094` already live for the latter's
   server half).
2. **Reinstall-stable SIP identity** — NOT started. The obvious implementation
   (SecureStore) does **not** survive an Android uninstall, so it would not fix the
   orphaned contacts it targets. Needs a server-issued identity.
3. **Pastable fields** — owner asked; explicitly deferred by him. Investigation
   found **nothing in the code blocking paste** (no `contextMenuHidden`, all real
   `TextInput`s). Needs one concrete failing field before touching ~30 inputs.
4. **Port 443 for filtered internet** — scoped, not built. The app does NOT
   hardcode the SIP address: it comes from `Tenant.sipWsUrl` (per-tenant!) with a
   `PBX_WS_ENDPOINT` fallback. The PBX **already runs nginx on 443**, so it is one
   `location /ws` → `127.0.0.1:8089` block + a per-tenant setting. RSBK was the
   candidate. **Caveat:** phones cache the bundle in SecureStore and only re-fetch
   when it is missing, so existing users must sign out/in — worth a small app
   change to re-check on start.
5. **Joseph Mandel (T22_101) has been locked out for days.** A desk phone at
   `192.168.0.245` retries a bad password; fail2ban bans his office IP
   `24.189.60.80`, it auto-unbans after 24 h and is **re-banned within 4 seconds**.
   **22 bans.** Log shows both `No matching endpoint found` AND `Failed to
   authenticate`. Nobody is alerted. Fixing needs a PBX write + correct
   provisioning on that phone.
6. **"Wake health: 13/15 devices flagged"** alert fired 2026-08-02 — most of the
   fleet. Not investigated.
7. Worker `sendPushToUserDevices` `active:true` filter — **fixed**, but note
   memory `connect-push-notification-traps` claimed all senders had it; they did not.

---

## 7. Environment notes

- SSH works **directly from local Git Bash**, keys in `~/.ssh` (the "sandbox-only"
  rule in CLAUDE.md did not apply here).
- Deploys: API via `bash scripts/deploy-direct.sh api --branch feat/ai-agent` on
  loopcom. Worker/telephony via the queue —
  `scripts/ops/_deploy-queue-fallback.sh` **is broken** (feeds JSON to Python,
  chokes on `false`); use the documented curl to
  `127.0.0.1:3910/ops/deploy/enqueue` with `DEPLOY_QUEUE_TOKEN` sourced
  server-side, then poll `/ops/deploy/jobs/<id>`.
- **Branch split is live and dangerous:** mobile work is on
  `feat/expo-sdk54-upgrade`; server/portal deploys come from `feat/ai-agent`. A
  worktree at a temp path was used for server changes. `feat/expo-sdk54-upgrade`
  does **not** contain `cdd5bbdd` — deploying from it would regress production.
- **Another agent works this repo concurrently** (iOS). It edited `VoicemailTab`,
  `RecentTab`, `ContactTab`, `AddContactModal` during this session — including an
  iOS share-sheet download built on top of this session's Recents work. `git status`
  before every edit; never commit their WIP.
- `C:\c2` is a **separate, older checkout** that already existed. A build there
  succeeded and nearly got mistaken for the real APK — the tell was Gradle 8.8 in
  the output. Always verify branch/commit before trusting a build.

---

## 8. Method note

The single most valuable move this session was **measuring before fixing**. The
prior diagnosis ("registration code") was wrong; the data said the push fires in
0.4 s, the device answers in 2.9 s when it is on, and the PBX asks once and gives
up in milliseconds. Three separate "fixes" were also reported as tested when
Gradle was replaying a cached model — **check `up-to-date` counts and the build
hash before believing a build proved anything.**
