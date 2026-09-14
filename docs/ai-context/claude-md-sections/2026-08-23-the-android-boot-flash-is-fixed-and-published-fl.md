# ⛔ AGENT HANDOFF — the Android boot flash is FIXED and PUBLISHED: fleet APK 1.0.0+20260823-152650, 63 MB arm64-only (2026-08-23) — READ FIRST for ANY "flash when opening the app", before touching the boot shield in RootNavigator, the SplashScreen entry fades, or before "restoring" the universal-ABI APK size

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`fca10c32` splash + `097563da` ABI filter + `6e1af21d` stamps on
`feat/ivr-migration-takeover`, pushed. **apps/mobile only — no server, no api,
no migration, no PBX write. PUBLISHED on Izzy's explicit "Publish it"** —
`connectcomms-latest.apk` = **1.0.0+20260823-152650, 63,420,722 bytes**,
smoke-tested 200 + manifest `publishedAt 2026-08-23T19:33:31Z` on both
hostnames. Izzy watched the fix live on his own phone and approved.)

- ⛔ **THE FLASH WAS MEASURED, NOT GUESSED — screenrecord a cold start and read
  the frames** (recipe: `screenrecord` + ffprobe `signalstats` YAVG per frame +
  1×1-scaled crops for exact RGB). The chain was: native splash window
  `#040810` (system-theme guess) → **unshielded first JS frames** (the
  NavigationContainer/login while SecureStore still loads the theme + token;
  `showSplash` gates on `themeReady && !!token`, both false at frame 1) → a
  **hard cut** to the splash gradient `#10203a`. With the in-app theme LIGHT on
  a system-DARK phone (Izzy's exact config that day) the cut was navy→white.
- ✅ **The fix is three JS parts, native splash untouched** (all in
  `RootNavigator.tsx` + `SplashScreen.tsx`): (1) a **boot shield** — an opaque
  cover in the native splash window color (`useColorScheme()` guess, matching
  `values`/`values-night` `splashscreen_background`) rendered from the very
  first JS frame, zIndex 998 under the splash's 999, dropped 700 ms after the
  splash mounts; (2) the splash's first frame is a **flat base color equal to
  the native window color** for its theme (`#040810` dark / `#f2f7fd` light)
  with the gradient **blooming in over 600 ms**; (3) the splash **fades in over
  the shield** — 220 ms when in-app theme == system theme (identical colors,
  invisible), **500 ms when they differ**.
- ⛔ **The one transition that CANNOT be removed: the OS paints the pre-launch
  window in the SYSTEM theme, always** — no app code runs before it. When the
  in-app theme disagrees, dark→light is inevitable; the 500 ms cross-fade IS
  the design answer. Do not chase a "still one theme change" report into
  native-side theme persistence — the starting window can't read it.
- ⛔ **The boot shield FAILS TOWARD COMING DOWN** — instant drop for any
  active-call UI, drop when boot resolves with no splash (signed-out → login),
  and an unconditional 6 s cap. A stranded shield is a blank app, which is
  worse than any flash. Keep every drop path when editing.
- ⛔ **`baseColor` in SplashScreen and `bootShieldColor` in RootNavigator must
  stay byte-equal to the native `splashscreen_background` values** — drift
  reintroduces the flash. If the native colors ever change, change all four.
- ⛔ **The fleet APK is arm64-only now (63 MB, was 143 MB) — another session's
  `build.gradle` `ndk.abiFilters` work, committed as `097563da` because Izzy
  approved the size on-device ("63 is perfect")**. The filter derives from
  `reactNativeArchitectures`, so `android-play-bundle.ps1`'s explicit
  armeabi-v7a+arm64 list keeps the Play AAB's 32-bit coverage. ⛔ The old
  APK's armeabi-v7a slice was BROKEN anyway (missing built-from-source libs) —
  do not "restore" universal packaging to help 32-bit phones; it never did.
- ⛔ **The dialpad `*`/`#` report that came in the same session was ALREADY
  fixed** (`3ac07f1f`, `dialDisplay.ts`) — the working tree just carried a
  STALE pre-fix copy of `KeypadTab.tsx` (the worktree-older-than-HEAD trap
  again); a parallel session's reset restored HEAD content mid-session.
- ⏳ **NOT PROVEN: no customer has installed this build** (fleet turns over on
  next install, nothing pushes it) — Izzy's own phone runs it and he approved
  the splash live; the published bytes were smoke-tested, not installed from
  the download page by a human.
