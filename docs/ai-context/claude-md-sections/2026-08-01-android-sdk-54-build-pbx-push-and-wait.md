# ⛔ AGENT HANDOFF — Android SDK 54 build + PBX push-and-wait (2026-08-01) — READ FIRST for Android builds or "calls don't ring"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


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
