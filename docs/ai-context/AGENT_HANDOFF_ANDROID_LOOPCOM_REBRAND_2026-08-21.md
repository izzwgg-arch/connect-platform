# AGENT HANDOFF — the Android app is Loopcom now: icon spacing, splash, and 31 strings (2026-08-21)

Izzy, 2026-08-21: *"We need to change the Android app from Connect to LoopCom …
I want to see the mockup before you build it … Everywhere in the app where
Connect is mentioned, it should be changed to LoopCom."*

Mockups he chose from:
<https://claude.ai/code/artifact/5060e8a7-2aac-410c-9cc2-fb891c9e5a04>.
His picks, in-chat: **"Option A for both, and use Loopcom"** — i.e. the roomier
launcher-icon spacing, the mark-plus-wordmark splash, and the lowercase-c
spelling that the rest of the platform already ships.

**Scope: `apps/mobile` only.** No server, no PBX, no migration, no deploy, no
customer account touched. Nothing here reaches a phone until a new APK is built
and published — see §7.

---

## 1 · What was already done, and what was not

The 2026-08-20 Play-Store commit (`b338064d`) had already renamed the launcher
and generated a Loopcom icon set. **It had never reached a phone** — no APK has
been published since 2026-08-04 — so the whole fleet still shows "Connect" with
the blue phone icon.

| | Before this work | After |
|---|---|---|
| Launcher label | `Loopcom` ✅ | unchanged |
| Launcher icon | Loopcom, mark at **85%** — glow clipped by circular masks | Loopcom, mark at **70%** |
| `assets/adaptive-icon.png` | ⛔ a copy of the old Connect **splash**, 1376×768 | the real 1024 foreground |
| `adaptiveIcon.backgroundColor` in `app.config.ts` | ⛔ `#1d4ed8` (Connect blue) | `#0C1218`, matching the native res |
| Native splash artwork | Connect, April 2026, **6.0 MB** | Loopcom, **0.6 MB** |
| In-app splash screen | `ConnectIcon` + "Connect" | `LoopcomMark` + "Loopcom" |
| User-visible "Connect" strings | 31 | 0 |

---

## 2 · ⛔⛔ THE FINDING THAT MATTERS MOST: the native splash image is DEAD

`drawable-*/splashscreen_image.png` — five identical 1.2 MB files, **6.0 MB of
the APK** — **is referenced by nothing.**

- `expo-splash-screen` is **not a dependency**: it appears nowhere in
  `pnpm-lock.yaml` and nowhere in `node_modules`. The `expo_splash_screen_*`
  entries in `strings.xml` and the `splashscreen_image` drawables are leftovers
  from an SDK-51-era prebuild that the app has since moved past.
- `drawable/splashscreen.xml` is a layer-list containing **only**
  `@color/splashscreen_background` (`#040810`). It does not reference the image.
- Grep across `android/app/src`, the Gradle files, `src/` and `app.config.ts`
  for `splashscreen_image`: **zero hits.** (⛔ Grep `android/app/src`, not
  `android/` — `android/app/build/` is full of stale merge-artifact references
  that read like real ones and sent this session down a false trail once.)

**So the only splash a user actually sees is `src/screens/SplashScreen.tsx`,**
drawn after the JS bundle mounts, over a flat `#040810` window background.

⛔ **They were REPLACED, not deleted, on purpose.** Deleting is only correct if
the analysis above is right; replacing is correct either way, removes the
Connect artwork from the APK regardless, and shrinks it by 5.4 MB. Deleting the
five files (and the two dead `expo_splash_screen_*` strings) is a real ~0.6 MB
follow-up — **Izzy's call, not done here.**

---

## 3 · The icon: one number, now in code

`scripts/mobile-loopcom-android-assets.py` regenerates every launcher asset from
`docs/brand/loopcom/app-icons/android-dark-512.png`.

⛔ **`MARK_SCALE = 0.70` is the whole decision** and it lives in exactly one
place. The 2026-08-20 pass generated the icons by hand and recorded the scale
only in prose, so afterwards nobody could tell what it had been — it was 0.85,
and that was too much.

**Why 0.85 clipped, in numbers:** an adaptive icon is a 108 dp canvas of which
Android guarantees only the central **72 dp** is visible. The mark's ink is
about 80% of its own PNG's width, so ink relative to the visible frame is
`scale × 108 ÷ 72 × 0.80`. At 0.85 that is **102%** — wider than the circle it
sits in, so the outer glow is cut on every Pixel/Motorola launcher. At 0.70 it
is **84%**, which has margin on both mask shapes.

⛔ **The legacy (pre-API-26) `ic_launcher.png` / `ic_launcher_round.png` are
rendered from the SAME geometry** — build the 108 dp canvas, crop to the central
72 dp, then bake `#0C1218` and (for the round one) a circular mask. Sizing the
legacy icons independently is how old and new Android end up showing
differently-proportioned marks on the same fleet.

Proven: the generated `ic_launcher_round.png` differs from the approved mockup
render by a **mean of 1.35 / 255 per channel** (the max of 127 is the
antialiased mask edge, where the two supersampling paths differ).

---

## 4 · The splash: two renders of one composition

`SplashScreen.tsx` (what users see) and `assets/splash.png` + the five
`splashscreen_image.png` (what nothing currently loads) are the same layout:
gradient → mark → `Loopcom` → `The AI communications platform`.

⛔ **Keep them in step.** The numbers live in the `SPLASH_*` constants of the
generator script and are mirrored, with a comment saying so, in the component.

Two traps paid for while rendering the static version — both produced artwork
that looked plausible and was wrong:

- ⛔ **`Image.getbbox()` does NOT find the mark's ink.** The brand PNG carries a
  scatter of near-zero-alpha pixels right out to the edges, so `getbbox()`
  returns the whole square and the crop silently does nothing — the mark
  rendered ~20% smaller than the config said. `ink_crop()` thresholds the alpha
  at 24 first. The same trap applies to any layout that measures this artwork.
- ⛔ **PIL's per-glyph text drawing must anchor on the BASELINE (`"ls"`).**
  Letter-spacing means placing glyphs one at a time; anchoring by the glyph top
  (`"lt"`) aligns cap-height letters with x-height letters and the word visibly
  staircases. "Loopcom" shipped that way in this file's first draft.

⛔ **The mark asset is CROPPED TO ITS INK and is therefore WIDE (640×302,
≈2.12:1), not square.** `LoopcomMark` takes a **width** and derives its height.
Giving it the untrimmed square would put a large invisible gap under the mark
and make it read far smaller than the number suggests — which is exactly what
the first render did.

`ConnectIcon.tsx` (a hand-drawn vector of the old blue phone-in-a-rounded-square
icon) is **deleted**. It had one call site.

---

## 5 · The 31 strings

Every user-visible "Connect" in `apps/mobile` is now "Loopcom": the sign-in
header, nine permission prompts, the battery/background nags, the ringtone
label, the ongoing-call notification, the phone-account name in the system
dialler, the contacts-import copy, the QR-provisioning error.

⛔ **Three things deliberately keep the old name, and each would cost something
real to change:**

1. **The package id `com.connectcommunications.mobile`.** Permanent once a Play
   upload exists; changing it makes every installed phone treat the update as a
   different app.
2. **Every notification channel id** (`connect-calls`, `connect-messages`,
   `connect-voicemail`, `connect-missed-calls`, `connect_bg_keepalive_v2`,
   `connect_in_call_v2`) and the ringtone id `connect-default`. Rename a channel
   id and Android creates a *new* channel, silently resetting every customer's
   sound and vibration choices while their old channel keeps the settings. Only
   the human-readable `CHANNEL_NAME` changed.
3. **Internal code names** — file names, Kotlin classes (`ConnectConnectionService`,
   `ConnectToneModule`), storage keys, and the bundled ringtone assets
   (`assets/connect-default-ringtone.caf`). Invisible to customers; renaming the
   ringtone files means touching the three iOS config plugins that bundle them.

⚠️ Left alone and worth a decision: `notification_icon_color` /
`expo-notifications` `color` is still `#1d4ed8`, the old Connect blue, rather
than the brand's `#22A8FF`. Cosmetic tint on the status-bar icon.

---

## 6 · ⛔ Found in passing: two signing-credential files were one `git add -A` from being committed

`apps/mobile/android/app/play-upload.keystore.superseded-connectcomms` and
`apps/mobile/android/keystore.properties.superseded-connectcomms` were sitting
**untracked and NOT ignored**. `.gitignore` had `*.keystore` and
`keystore.properties`, and a `.superseded-connectcomms` suffix slips past both.
That is the Play upload key and its password.

Fixed by adding `*.keystore.*`, `*.jks.*` and `keystore.properties.*` to
`apps/mobile/.gitignore`; `git check-ignore` now matches both files. ⛔ The files
themselves were **not** touched — they are not this session's to delete, and
they are the only copies on the machine. **They still need backing up
off-machine** (§1 of the Play handoff already says so).

---

## 7 · What reaches a phone, and what does not

✅ **PUBLISHED 2026-08-21**, on Izzy's explicit in-chat instruction
(*"publish it to the connect download page"*). `connectcomms-latest.apk` is now
**`1.0.0+20260821-064521`, 142,381,803 bytes**, HEAD 200 on both hostnames, and
`/api/mobile/android/latest` reports it with `publishedAt 2026-08-21T11:49:41Z`.
The previous published build was `1.0.0+20260812-215020` at 147,508,699 bytes —
⛔ **that size difference is the honest check that a publish really happened**;
the download page's own date is served from the manifest and is easy to misread.

⛔⛔ **Every customer's home screen renames itself the moment they take this
update**, and **nobody had been told at the time of publishing.** Nothing pushes
it, so the fleet turns over gradually as people install from the download page
or an invite link.

⛔ `apps/mobile` is in no deploy queue and `deploy-direct.sh` takes `api|portal`
only. The two commands are:

```
powershell -File scripts/android-ship.ps1 -SkipJunction
powershell -File scripts/android-publish.ps1 -Version "1.0.0+<yyyymmdd>" -ReleaseNotes "..."
```

⛔⛔ **That publish is the one that changes every customer's home screen.** The
whole fleet is on sideloaded builds showing "Connect" with the blue icon; the
next in-place update renames the app and swaps the icon underneath them. Tell
them before it ships, or "my app disappeared" becomes a support call. The
announcement and the publish want to happen together, and both are Izzy's call.

⛔ **`android-ship.ps1` dirties TWO TRACKED FILES on every run** — it stamps
`expo_runtime_version` into `android/app/src/main/res/values/strings.xml` and
rewrites `apps/mobile/ship-proof.json`. Both record the **published** build, so
a verification-only build must revert them (this session did). Committing them
without publishing makes the repo claim a build that no customer has. Same class
as the tracked `apps/portal/tsconfig.tsbuildinfo`.

For the record, the verification build measured the APK at **142,381,803 bytes
vs 147,508,699** for the last published one — **4.9 MB smaller**, which is the
dead Connect splash artwork coming out.

⛔ **iOS is untouched and already correct** — renamed Loopcom on 2026-07-30.
Some of the swept strings are shared, so iOS gets the corrected wording at its
next TestFlight build; nothing regresses in the meantime.

---

## 8 · How it was proven, and what is NOT proven

**Proven:**
- `tsc --noEmit` on `apps/mobile`: **0 errors**.
- `scripts/mobile-loopcom-android-assets.py --check`: all 23 assets present.
- Generated round icon vs the approved mockup: mean channel diff **1.35**.
- Every string replacement asserted to match **exactly once** before writing
  (⛔ CRLF-normalised on read — the working tree is CRLF under Izzy's global
  `core.autocrlf=true`, and multi-line LF patterns silently match nothing).
- Release APK built end to end (`assembleRelease`), which is what actually
  validates the PNGs through `aapt` and the `require()` of the new mark asset —
  a typecheck cannot see either.

⏳ **NOT PROVEN: nobody has looked at the app.** No human has seen the new
splash animate, no home screen shows the new icon, no permission dialog has been
read. **Acceptance is one install:** the launcher shows the infinity mark
labelled *Loopcom* with the glow clear of the mask edge; opening it plays the
mark springing in with *Loopcom* sliding up beneath; Settings → Incoming
Ringtone reads *Loopcom Default*; and the sign-in header reads *Loopcom*.

⏳ **The negative that matters most:** after installing over an existing build,
the customer's ringtone and vibration choices must be **unchanged** — that is
the check that the notification channel ids really were left alone.
