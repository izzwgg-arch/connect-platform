# ⛔ AGENT HANDOFF — the Android launcher icon is BLUE 2B from the icon-refinement kit, and the status-bar icon is the infinity silhouette (2026-08-22) — READ FIRST before touching Android launcher/notification icons, before running the icon generator script, or before believing the generator produces what ships

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(Committed on `feat/ivr-migration-takeover` alongside the parallel session's `a7eaf8e7`,
which built the LOGIN and SPLASH to the approved mockups — this section covers only the
ICON half. **apps/mobile only — no server, no deploy; APK built for verification, NOT
published.** Izzy picked **Blue 2B** — the detailed infinity-with-star mark on the bright
blue gradient — from the three options in `Icon refinement options.zip` (now archived at
`docs/brand/loopcom/icon-refinement-2026-08/Icon refinement options.zip` — the copy that
also carries `Login and splash mockups.html`), 2026-08-22 in-chat.)

- ⛔⛔ **THE SHIPPED ANDROID LAUNCHER ICONS ARE HAND-PLACED FROM THE KIT, NOT
  GENERATED — `scripts/mobile-loopcom-android-assets.py` no longer produces what
  ships.** Its generate mode renders the white-tile wordmark icon (the pre-Blue-2B
  fleet look) and would REGRESS the launcher if re-run; its `--check` is
  existence-only and stays green over any bytes. The source of truth is the kit:
  adaptive fg/bg from `blue-2b/android-adaptive-{foreground,background}-432.png`
  resized per density, legacy square = `android-app-icon-512.png` resized
  (proven equivalent to the composite-crop within 2px), round = circle-masked
  square. All 20 mipmap PNGs replaced; `mipmap-anydpi-v26/*.xml` untouched
  (they already reference `@mipmap/ic_launcher_background` as an IMAGE).
  ⛔⛔ **AND THE SHARED WORKTREE CARRIES AN UNCOMMITTED REWRITE OF THAT
  GENERATOR THAT IS EVEN FURTHER FROM WHAT SHIPS — verified 2026-08-24.** It is the
  **W1 “whole logo on white”** design Izzy picked on 08-21, one day before Blue 2B
  superseded it: `ICON_ART` points at `derived/loopcom-wordmark.png` (the WORDMARK,
  not the infinity mark) and `ICON_GROUND` is `((0xFF,0xFF,0xFF),(0xFF,0xFF,0xFF))`,
  a **white** tile. The shipped `ic_launcher_background.png` was read to check: it is
  a blue gradient, **RGBA(34,167,255) → (53,128,255)** — Blue 2B. So running the
  worktree copy repaints the launcher white and swaps the mark for the wordmark.
  ⛔ **Its docstring dates itself to the 08-21 decision, so it reads as current work
  and is not** — judge this file by the ARTWORK it names, never by its comments.
  Left uncommitted deliberately (finish it for Blue 2B or revert it — Izzy's call);
  a copy is in the scratchpad at `worktree-clear-20260824/`.
  ⛔ **It arrived in a bulk file-write at `2026-08-22 21:53` that wrote several
  files IN BOTH DIRECTIONS IN THE SAME SECOND** — this forward edit alongside a
  **stale revert** of the deployed role-snapshot forward-merge feature
  (`platformRolePermissions.ts` byte-identical to `b1f94452^`, plus its test and
  handoff doc deleted). **That is the per-file-direction rule at the top of this
  file, as a real event: one mtime, one operation, two opposite directions.**
- ⛔ **The status-bar notification icon is now `res/drawable-{mdpi..xxxhdpi}/
  notification_icon.png`** — the kit's monochrome `ic_stat_loopcom` infinity
  silhouette (24/36/48/72/96) — and **`drawable/notification_icon.xml` (the old
  stock phone-glyph vector) is DELETED.** The resource NAME is unchanged, so all
  8 `setSmallIcon(R.drawable.notification_icon)` call sites (missed calls,
  message/voicemail alerts, in-call FGS) and the 4 AndroidManifest meta-data
  entries resolve to the PNGs with zero code change. ⛔ **The rule the old
  vector's comment carried still stands: this icon MUST be white-on-transparent**
  — Android renders only the alpha as a tinted silhouette; a colored bitmap masks
  to a blob. And the keep-alive FGS deliberately keeps the separate fully
  transparent `ic_keepalive_silent` — never point it at the real icon.
- ✅ **`notification_icon_color` is `#22A8FF` now** (brand accent; was `#1d4ed8`,
  the pre-rebrand Connect blue, flagged stale since 2026-08-21).
- ✅ **The Expo config can no longer regress the launcher on a prebuild:**
  `assets/adaptive-icon.png` = the Blue 2B foreground, new
  `assets/adaptive-icon-background.png` = the gradient (config uses
  `backgroundImage` — ⛔ a flat `backgroundColor` cannot represent the gradient,
  do not swap back), `assets/icon.png` = the Blue 2B 1024,
  `assets/notification-icon.png` = the white silhouette, plugin color `#22A8FF`.
  All inert on bare `android/` today; they exist so prebuild-day is not a trap.
- ⛔ **Notification channel ids untouched** (renaming resets every customer's
  ringtone — standing rule). Splash state after `a7eaf8e7`: splash gated
  `showSplash = … && !!token` (signed-in only, Izzy re-stated 2026-08-22) and
  stays brand navy in both themes.
- ⛔⛔ **THE LAUNCHER ICON FOLLOWS THE IN-APP THEME NOW (Izzy 2026-08-22:
  "when I change to dark mode, the icon should change to 2a; light → 2b") —
  PROVEN LIVE ON HIS PHONE, full round trip.** Mechanism: the MAIN/LAUNCHER
  intent-filter moved OFF `.MainActivity` onto two activity-aliases —
  `.LauncherBlue` (enabled by default, Blue 2B) and `.LauncherNavy` (disabled,
  Navy 2A, own `ic_launcher_navy*` mipmaps) — and `LauncherIconModule.kt`
  flips which one is enabled; `ThemeContext.setMode` calls it on every toggle
  and once at boot (so a pre-update dark chooser gets navy on first launch —
  that reconcile fired for real on Izzy's phone, whose theme was already dark).
  ⛔ **`.MainActivity` itself must NEVER be disabled** — notifications and deep
  links start it by explicit class, and a disabled activity cannot start; the
  module enables the new alias BEFORE disabling the old (never zero launchers)
  and always `DONT_KILL_APP` (the app's pid survived the switch, verified).
  ⛔ `am start -n <pkg>/.LauncherBlue` answers **Error type 3** on Samsung —
  launch aliases via the LAUNCHER intent (monkey), not bare `-n`. Verify which
  icon is live with `cmd package resolve-activity -c android.intent.category.LAUNCHER
  -a android.intent.action.MAIN <pkg>`. ⛔ iOS deliberately keeps the manual
  Settings row instead (iOS pops a system alert on every programmatic change).
- ⛔ **The LOGIN THEME RULE CHANGED on Izzy's correction (2026-08-22): the
  phone's own dark mode does NOT darken the login any more.** `systemDark ||
  isDark` shipped first and he rejected it — it is **`isDark` only** now
  (light unless the user's in-app theme is dark). Also on his order: **the old
  Welcome screen is DELETED** (`WelcomeScreen.tsx`, its `Welcome` route and
  type — signed out lands straight on Login, which carries both entries), and
  the login's Sign in + Scan QR sit LOWER via two flexGrow spacers
  (`spacerA`/`spacerB`) that split the leftover height instead of leaving one
  blank block at the bottom.
- ✅ **PROVEN ON IZZY'S PHONE 2026-08-22/23** (build `1.0.0+20260823-025839`
  installed via `android-ship.ps1 -SkipJunction`): launcher search shows the
  NAVY icon while the app theme is dark and the BLUE 2B icon after toggling
  light (screenshots taken both ways); `resolve-activity` flipped
  Blue→Navy→Blue→Navy across the boot reconcile + two UI toggles; his theme
  was left on dark, as found. ✅✅ **PUBLISHED TO THE FLEET 2026-08-23 on
  Izzy's explicit "Publish it"** — `connectcomms-latest.apk` is
  **`1.0.0+20260823-113754`, 143,262,559 bytes** (sha256-verified identical to
  the build proven on his phone), live + smoke-tested on both hostnames,
  `publishedAt 2026-08-23T15:46:39Z`. It carries the WHOLE day: theme-following
  launcher icons, deferred alias flip, themed splash with the real light mark,
  the new login, the contact-name fixes and the voicemail button ink.
  ⛔ **Customers update on their next install — each update renames their icon
  to Blue 2B (or Navy on dark themes) AND changes the launcher component, so a
  pinned home shortcut may drop once on some launchers** (it stays in the app
  drawer). A customer saying "the app vanished from my home screen" after
  updating: that is this — re-add from the drawer.**
- ⛔⛔ **THE ALIAS FLIP IS DEFERRED TO THE BACKGROUND NOW (`185cd7b7`) — the
  first build flipped on the toggle and THE APP CLOSED EVERY TIME.** Flipping
  the enabled launcher alias makes Android remove the app's TASK; DONT_KILL_APP
  keeps only the process. `ThemeContext` records the wanted icon and applies it
  when AppState goes 'background' (guarded on `hasActiveSipSession` — never
  disturb a call), with a boot reconcile for missed flips. ⛔ Never "simplify"
  back to an immediate `set()`. Proven live: toggle in Settings → app stays
  foreground and Registered; icon flips the moment it is backgrounded.
- ✅✅ **THE SPLASH FOLLOWS THE IN-APP THEME (`185cd7b7`, superseding "brand
  navy in both themes"), and light mode shows THE ACTUAL LIGHT-MODE LOGO
  (`52885e85`).** ⛔ A first cut substituted the Blue 2B icon's tick-band mark
  and Izzy rejected it outright ("It looks horrible. I want it to be the
  actual logo, just the light mode version. We have a light mode version.
  Check the files.") — **the kit ships light art:
  `docs/brand/loopcom/masters/loopcom-logo-light.png`; never swap icon art in
  for the logo.** No standalone light-infinity file existed, so one was made
  and filed: `docs/brand/loopcom/derived/loopcom-mark-light.png` (the master's
  infinity white-keyed to transparency; recipe in the derived/ README —
  fragments dropped by largest-connected-ink, a plain crop cannot separate
  them). The app ships a 2× LANCZOS copy as `assets/loopcom-mark-light.png`.
  ⛔ `app-icons/ios-light-1024.png` looks like the sibling and is NOT it — the
  pale icon-polarity mark, rejected. Izzy confirmed the master extraction
  on-device: "that's the one". Dark keeps the chrome art. ⛔ The chrome `loopcom-mark.png` was CLEANED: it
  carried an invisible dark haze (~59% of pixels at alpha 3–70) that composited
  as a grey PLATE on light — keyed out by clearing large CONNECTED faint-dark
  regions only (a global threshold ate holes in the ring). ⛔ The glow pad
  ("the ball") and the aurora discs are DELETED — RN has no blur, so the
  mockup's blurred shapes rendered as hard-edged circles. ⛔ RootNavigator
  gates the splash on `ThemeContext.ready`; the native pre-JS window follows
  the SYSTEM theme (`values-night/colors.xml`). Splash screenshots proven
  clean on-device in BOTH themes.
