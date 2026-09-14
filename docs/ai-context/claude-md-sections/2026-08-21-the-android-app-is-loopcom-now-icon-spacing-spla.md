# ⛔⛔ AGENT HANDOFF — the Android app is Loopcom now (icon spacing, splash, 31 strings) and it is on NO PHONE (2026-08-21) — READ FIRST before touching the mobile launcher icon or splash, before renaming ANY notification channel id, before publishing an APK, or for "the native splash didn't change"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANDROID_LOOPCOM_REBRAND_2026-08-21.md`**
(`apps/mobile` only — no server, no PBX, no migration, no deploy, no customer
account touched. Release APK built end to end to prove the resources and bundle
compile; **deliberately NOT published**.) Izzy, 2026-08-21, picking from the
mockups (<https://claude.ai/code/artifact/5060e8a7-2aac-410c-9cc2-fb891c9e5a04>):
*"Option A for both, and use Loopcom."*
Memory: [[android-app-rebranded-but-not-published]].

- ✅✅ **PUBLISHED 2026-08-21 on Izzy's explicit instruction** — `connectcomms-latest.apk`
  is **`1.0.0+20260821-064521`, 142,381,803 bytes**, live and smoke-tested 200 on
  both hostnames; `/api/mobile/android/latest` reports it with
  `publishedAt 2026-08-21T11:49:41Z`. The prior published build was
  `1.0.0+20260812-215020` (147,508,699 b) — **the size drop IS the check** that
  the new one really went out.
  ⛔⛔ **SO EVERY CUSTOMER'S HOME SCREEN RENAMES ITSELF FROM "Connect" TO
  "Loopcom", WITH A NEW ICON, THE MOMENT THEY TAKE THIS UPDATE** — it is an
  in-place update on the sideload signature, so there is no opt-in and no
  staged rollout. ⏳ **At the time of writing NOBODY HAS BEEN TOLD.** If a
  customer rings saying their app vanished, this is why: tell them to look for
  the blue infinity mark. ⛔ Nothing pushes it — a phone only changes when its
  user installs from the download page or an invite link, so the fleet turns
  over gradually, not at once.
- ⛔⛔ **THE FINDING THAT OUTRANKS THE REBRAND: `drawable-*/splashscreen_image.png`
  IS DEAD — five identical 1.2 MB files, 6.0 MB of the APK, referenced by
  nothing.** `expo-splash-screen` is in **neither `pnpm-lock.yaml` nor
  `node_modules`**, and `drawable/splashscreen.xml` is a layer-list holding only
  `@color/splashscreen_background`. So the ONLY splash a user sees is
  `src/screens/SplashScreen.tsx`, drawn over a flat `#040810`.
  ⛔ **Grep `android/app/src`, NOT `android/`** — `android/app/build/` is full of
  stale merge-artifact references to that filename that read exactly like real
  ones. ✅ They were **replaced, not deleted, on purpose**: replacing is correct
  whether or not the dead-asset analysis holds, removes the Connect artwork
  either way, and took the APK down 5.4 MB. Deleting them (and the two dead
  `expo_splash_screen_*` strings) is a real ~0.6 MB follow-up, **not done**.
- ⛔ **The icon decision is ONE NUMBER and it now lives in code:**
  `MARK_SCALE = 0.70` in **`scripts/mobile-loopcom-android-assets.py`**, which
  regenerates every density from the brand kit. The 2026-08-20 pass generated
  them by hand at **0.85** and recorded the scale only in prose, so nobody could
  tell afterwards what it had been. **Why 0.85 was wrong, in numbers:** an
  adaptive icon is a 108 dp canvas of which Android shows only the central
  **72 dp**, and the mark's ink is ~80% of its own PNG, so ink-vs-visible is
  `scale × 108 ÷ 72 × 0.80` — **102% at 0.85** (glow clipped on every circular
  mask), **84% at 0.70**. ⛔ The legacy `ic_launcher*.png` are rendered from the
  SAME geometry (build the 108 canvas, crop to 72, bake `#0C1218`), or old and
  new Android show differently-proportioned marks on one fleet.
- ⛔⛔ **THREE THINGS KEEP THE OLD NAME AND EACH COSTS SOMETHING TO CHANGE:** the
  package id `com.connectcommunications.mobile` (permanent once on Play);
  **every notification channel id** (`connect-calls`, `connect-messages`,
  `connect-voicemail`, `connect-missed-calls`, `connect_bg_keepalive_v2`,
  `connect_in_call_v2`) and the ringtone id `connect-default` — **rename a
  channel id and Android creates a NEW channel, silently resetting every
  customer's ringtone and vibration while their old channel keeps the
  settings**; and the internal Kotlin class / asset names. Only the
  human-readable `CHANNEL_NAME` changed.
- ⛔ **Two latent bugs fixed in passing.** `assets/adaptive-icon.png` held **a
  copy of the old Connect SPLASH** (1376×768) — a prebuild would have destroyed
  the launcher icon; and `app.config.ts`'s `adaptiveIcon.backgroundColor` still
  read `#1d4ed8` (Connect blue) while the native `colors.xml` already said
  `#0C1218`, so a prebuild would have regressed the icon background too.
- ⛔ **Two artwork traps, both of which produce plausible-looking wrong output:**
  `Image.getbbox()` does **NOT** find this mark's ink — the brand PNG carries
  near-zero-alpha dust to the edges, so it returns the whole square and the crop
  silently does nothing (the mark rendered ~20% small); and PIL per-glyph text
  must anchor on the **baseline (`"ls"`)** — anchoring by glyph top staircases
  the word, which shipped in the first draft of "Loopcom". Hence
  `assets/loopcom-mark.png` is **ink-cropped and therefore WIDE (640×302)**:
  `LoopcomMark` takes a **width** and derives height. `ConnectIcon.tsx` is
  deleted (one call site).
- ⛔ **Found in passing, and it is a credential exposure:**
  `apps/mobile/android/app/play-upload.keystore.superseded-connectcomms` and
  `keystore.properties.superseded-connectcomms` were **untracked and NOT
  ignored** — `.gitignore` had `*.keystore` and `keystore.properties`, and a
  `.superseded-connectcomms` suffix slips past both, so one `git add -A` would
  have committed the Play upload key and its password. Fixed with
  `*.keystore.*` / `*.jks.*` / `keystore.properties.*`; `git check-ignore` now
  matches both. ⛔ The files themselves were NOT touched — they are the only
  copies on the machine and **still need backing up off-machine.**
- ⛔ String edits here must be **CRLF-normalised on read** — the working tree is
  CRLF under Izzy's global `core.autocrlf=true`, and a multi-line LF pattern
  matches nothing and reads as "the string isn't there"
  ([[source-reading-tests-must-normalise-crlf]]).
- ✅ **Proven:** `tsc --noEmit` **0 errors**; `--check` mode of the generator
  finds all 23 assets; the generated round icon matches the approved mockup to a
  **mean channel diff of 1.35**; every string replacement asserted to match
  exactly once before writing; and a full `assembleRelease`, which is what
  actually validates the PNGs through `aapt` and the new `require()` — a
  typecheck sees neither. ⛔ **`android-ship.ps1` dirties TWO TRACKED FILES every run** —
  `res/values/strings.xml` (`expo_runtime_version`) and
  `apps/mobile/ship-proof.json`. Both record the PUBLISHED build, so a
  verification-only build must revert them, or the repo claims a build no
  customer has. Both were reverted here. The APK measured **142,381,803 bytes
  vs 147,508,699** published — 4.9 MB smaller, which is the dead splash coming
  out.
- ⏳ **NOT PROVEN: nobody has looked at the app.** No home screen shows the icon,
  no human has watched the splash animate. **Acceptance is one install** — the
  launcher shows the infinity mark labelled *Loopcom* with the glow clear of the
  mask edge, the splash springs the mark in with *Loopcom* sliding up beneath,
  Settings → Incoming Ringtone reads *Loopcom Default*, sign-in header reads
  *Loopcom*. ⛔ **The negative that matters most: after updating over an existing
  build the customer's ringtone and vibration choices must be UNCHANGED** — that
  is the check that the channel ids really were left alone.
- ⚠️ Noticed, NOT changed: the notification tint is still `#1d4ed8`, the old
  Connect blue, rather than the brand's `#22A8FF`. ✅ **iOS is untouched and
  already correct** (renamed 2026-07-30); it picks up the corrected shared
  strings at its next TestFlight build.
