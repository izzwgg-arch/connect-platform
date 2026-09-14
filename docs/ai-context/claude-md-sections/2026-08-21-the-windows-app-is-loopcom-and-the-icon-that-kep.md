# ⛔⛔ AGENT HANDOFF — the Windows app is Loopcom, and the icon that "kept disappearing" was NEVER IN THE .EXE (2026-08-21) — READ FIRST before touching `apps/desktop`, before setting `signAndEditExecutable`, before adding ANY image to a Windows notification, or for "the Electron icon is back"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESKTOP_LOOPCOM_REBRAND_2026-08-21.md`**
(`f8d4e11c` on `feat/ivr-migration-takeover`, pushed. **apps/desktop only** — no
server, no api, no portal, no PBX, no migration, no deploy. Installer built and
verified; ⏳ **deliberately NOT published.**)
Memory: [[desktop-icon-was-never-in-the-exe]], [[windows-toast-has-no-body-image]].
Izzy, 2026-08-21: *"I never want to see the Electron icon ever, ever, ever. I want
a safeguard on that"*, *"a small icon on top like everybody else"*, and *"I do not
want to see any mention of electron ever."*

- ⛔⛔ **THE CAUSE, and it is one build flag: `signAndEditExecutable: false` skipped
  rcedit, which is the ONLY thing that embeds `assets/icon.ico` into the .exe. So
  every installer ever shipped carried ELECTRON'S DEFAULT ATOM ICON inside
  `Connect.exe`** — proven by extracting the installed 0.1.6 exe's icon.
  ⛔ **That is exactly why it "showed for a few minutes and then disappeared":**
  `new BrowserWindow({ icon })` paints the taskbar while a window exists, but
  Windows re-resolves the app from the **EXECUTABLE** whenever the button is
  regrouped, the app hides to the tray, a pinned entry resolves or the icon cache
  is re-read — **and for the toast notification header**. **No renderer-side or
  main-process code can fix it; the bytes must be in the exe.** Every earlier
  attempt was working on the wrong half.
- ⛔⛔ **TURNING THE FLAG ON FAILS ON THIS MACHINE AND THAT IS PROBABLY WHY IT WAS
  OFF.** It makes electron-builder fetch **winCodeSign** (which contains rcedit),
  whose archive holds two **macOS symlinks**; creating a symlink on Windows needs
  Developer Mode or admin, so 7za exits 2 and the build dies. ⛔ **Do NOT set the
  flag back to false.** Fix with no admin: pre-extract the `.7z` yourself into
  **`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`** (the
  numeric dirs already there are abandoned temp dirs from failed attempts — the
  NAME is what makes electron-builder skip the download). Recipe in handoff §2.
- ⛔⛔ **THE SAFEGUARD READS THE ARTIFACT, NOT THE CONFIG — and that distinction is
  the point.** `apps/desktop/scripts/verify-built-icon.ts` runs inside `pnpm dist`,
  walks the built PE's `.rsrc` tree and asserts every **RT_ICON** is byte-identical
  to a frame of `assets/icon.ico` **and that nothing else is embedded**, plus that
  the version info says Loopcom (proving rcedit ran). A config assertion only
  proves what we ASKED for — rcedit can still fail on a locked file or antivirus.
  ✅ **Proven non-vacuous: pointed at the shipped 0.1.6 exe (`pnpm verify:icon
  <path>`) it fails with 9 assertions and names the 4 foreign icons.**
- ⛔⛔ **A WINDOWS TOAST CARRIES NO IMAGE AT ALL — never add one back.** Electron
  renders a notification's `icon` option as the toast's **full-width INLINE
  image**; that was the "big-ass icon" on every voicemail, and there is no option
  to shrink it. The only way to the standard layout is **`toastXml`**, which
  supersedes `title`/`body`/`icon` on Windows. What ships is two `<text>` nodes and
  nothing else — Windows already draws the app logo **small in the header** beside
  the name (Izzy pointed at Claude's own toast as the reference). ⛔
  `placement="appLogoOverride"` was tried first and rejected as the same big icon;
  `hero` or a bare `<image>` is worse.
  ⛔ **Dropping the image also dodged a trap that would have shipped broken:
  `assets/` is inside `app.asar`, and Windows' toast renderer is a separate OS
  process that CANNOT read inside an asar — while `fs.existsSync` answers TRUE.**
  It would have looked perfect in dev and rendered nothing in the shipped build.
  ⛔ **The toast's app NAME and header ICON are not set by us and cannot be** —
  Windows reads them from the Start Menu shortcut carrying the AUMID
  (`nsis.shortcutName` + that shortcut's target exe's own icon), which is why the
  atom in the toast header WAS the atom in the exe.
- ⛔⛔ **`appId` / the AppUserModelID / package.json `name` are DELIBERATELY
  UNCHANGED.** appId keys the NSIS uninstall entry and the AUMID keys taskbar
  identity, pinning and toast attribution — change it and the next update installs
  **SIDE BY SIDE** instead of upgrading (two tray icons, two SIP phones, a double
  ring). `name` (`@connect/desktop`) derives `userData`
  (`%APPDATA%\@connect\desktop`) — changing it signs every user out and loses their
  settings. Verified from the shipped asar that electron-builder does NOT rewrite
  `name` from `productName`. Guards assert both.
- ⛔ **The packaging config moved to `apps/desktop/electron-builder.yml`** because
  electron-builder validates strictly and **rejects a `"//note"` comment key** in
  package.json's `build` block — and these settings need their warnings attached to
  them. It refuses to start if both exist, so there is no `build` key any more.
- ⛔ **Icons are GENERATED: `scripts/desktop-loopcom-windows-assets.py`**, one
  number (`MARK_INK_W = 0.84`) as with the Android script. ⛔ Windows applies **no
  mask**, so 0.84 here equals Android's effective `0.70 × 108/72 × 0.854 = 0.897`.
  ⛔ `ink_crop()` not `getbbox()` (the brand PNG has near-zero-alpha dust to the
  edges). ⛔ **Frames below 256 are BMP/DIB, only the 256 is PNG** — rcedit and
  several shell surfaces render a small PNG entry **BLANK**, so an all-PNG .ico
  opens fine in a viewer and ships an empty taskbar icon; and an icon DIB must
  declare **double** its real height. ⛔ Each frame is rendered independently at 4×
  supersample (Pillow's `save(format="ICO", sizes=…)` downsamples ONE source, so
  the 16px comes out of a 256px render and turns to mush), with a **1.35 luminance
  lift at ≤32px** or the thin strokes average into the plate and read as a smudge.
- ✅ **"No mention of Electron" is TRUE for every surface a person sees** — exe
  name, ProductName/FileDescription/InternalName, CompanyName (was **`GitHub,
  Inc.`**), copyright, every icon, window titles, tray menu, updater dialogs,
  Add/Remove Programs, and the **user agent** (Electron token stripped).
  ⛔ **The UA is TRANSFORMED, never hardcoded** — `Chrome/<version>` must stay
  truthful, and the product token is **replaced, not dropped**, because the desktop
  fleet is identified in nginx logs by it. Old installs say `Connect/0.1.6 …
  Electron/41`; 0.1.7+ says `Loopcom/0.1.7`.
  ⛔⛔ **ONE FILE REMAINS AND MUST NOT BE DELETED: `LICENSE.electron.txt`** —
  Electron's MIT licence, which MIT **requires** be shipped. It appears in no UI,
  only in the install folder. ⏳ Renaming it to `Third-party licences.txt` via an
  `afterPack` hook would satisfy MIT and remove the word from the filename —
  **not done, it is a legal file and Izzy's call.**
- ⛔ **`artifactName` is still `Connect-Setup-*` on purpose** — the portal sidebar
  links `/desktop/Connect-Setup-latest.exe` and `loopcomParity.test.ts` pins that
  string. Renaming is a PORTAL change and this pass was scoped to leave the portal
  alone. ⏳ So the downloaded file is still called *Connect-Setup*.
- **Tests: 22 in `apps/desktop/src/branding.test.ts`** (a `test` script now exists
  for this package for the first time). ✅ **16 of 22 fail replayed against `HEAD`**
  via `DESKTOP_GUARD_ROOT`; the 6 that pass are pure unit tests of modules HEAD
  does not contain. Typecheck 0. ⛔ The "no hint-crop" guard **first failed against
  correct code** because it matched the doc comment explaining why there is no
  hint-crop — every negative assertion reads a comment-stripped copy now. Fourth
  time this repo has hit that.
- ⏳⏳ **NOT PROVEN, and NOT PUBLISHED: nobody has installed 0.1.7.** The taskbar,
  Start, tray and notification-header icons are proven as **bytes in the exe** and
  the toast layout as **XML Windows itself parsed and rendered**, never by a human
  looking at a running app. **Acceptance: install
  `apps/desktop/release/Connect-Setup-0.1.7.exe`, hide it to the tray and reopen
  it** (the exact moment the atom used to come back), then wait for a voicemail.
  ⛔ **The negative that matters most: the app still registers and rings** — the exe
  was renamed and the login item re-registered.
  ⛔⛔ **Publishing auto-updates the fleet and renames every customer's app and icon
  underneath them** — Izzy's call, same as the Android rebrand. Watch the first
  upgrade for a leftover `Connect.exe`/`Connect.lnk` the old uninstaller missed.
