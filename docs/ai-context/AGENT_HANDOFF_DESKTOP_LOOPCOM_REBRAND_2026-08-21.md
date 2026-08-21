# AGENT HANDOFF — the Windows desktop app is Loopcom, and the icon that "kept disappearing" was never in the .exe (2026-08-21)

**Commit `f8d4e11c` on `feat/ivr-migration-takeover`, pushed.**
Scope: `apps/desktop` + one new generator script. **No server, no api, no portal,
no PBX, no migration, no deploy, no customer account touched.** The installer was
built end to end and verified — **deliberately NOT published.**

Izzy, 2026-08-21:
> "Let's rebrand the Windows app to LoopCom. Nothing inside the app needs to be
> changed, just the actual Windows app, the notifications, and the icon."
> "The icon keeps disappearing… I never want to see the Electron icon ever, ever,
> ever. I want a safeguard on that."
> "Voicemail notifications right now have a big-ass icon on them… I want them to
> be like the modern notifications: a small icon on top like everybody else."
> "I do not want to see any mention of electron ever. Can we do that?"

---

## 1. ⛔⛔ THE HEADLINE: the icon was never embedded in the executable

`apps/desktop/package.json` carried **`"signAndEditExecutable": false`**.

That flag tells electron-builder to skip **rcedit**, and rcedit is the *only*
thing that writes `assets/icon.ico` (and the version strings) **into the .exe**.
So every installer this app has ever shipped contained **Electron's default atom
icon** inside `Connect.exe`.

**Proven, not inferred.** Extracting the icon from the installed 0.1.6 build:

```
[System.Drawing.Icon]::ExtractAssociatedIcon("$env:LOCALAPPDATA\Programs\@connectdesktop\Connect.exe")
```

→ the Electron atom, beside the repo's blue Connect icon. The verifier (see §3)
run against that same exe reports **4 RT_ICON resources, none of them ours**, and
`the exe's version info does not contain "Loopcom" — rcedit did not run`.

### ⛔ Why that produces "there for a few minutes, then it disappears"

Two different mechanisms feed the taskbar, and only one of them was ours:

| What Windows shows | Where it comes from | State before |
|---|---|---|
| the button while a window is up | `new BrowserWindow({ icon })`, set at runtime | our icon ✅ |
| the button after it is regrouped, the app hides to the tray, the icon cache is re-read, a pinned entry resolves, **and the toast notification header** | the **executable's embedded icon**, via the Start Menu shortcut and the AppUserModelID | Electron's atom ❌ |

So the app painted the right icon at startup and Windows quietly replaced it with
the atom the moment it resolved the app from the executable instead of a live
window. **Nothing in main.ts or the renderer could ever have fixed this** — the
bytes have to be in the exe. Every previous attempt was working on the wrong half.

---

## 2. ⛔ Turning the flag on FAILS on this machine, and here is the fix

`signAndEditExecutable: true` makes electron-builder download and extract the
**winCodeSign** toolset (which contains rcedit). Extraction fails:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
  : ...\winCodeSign\<n>\darwin\10.12\lib\libcrypto.dylib
⨯ cannot execute  cause=exit status 2
```

The archive contains two **macOS symlinks**, and creating a symlink on Windows
needs Developer Mode or admin. **This is almost certainly why the flag was set to
`false` in the first place** — and it is why the build had appeared to "work".

⛔ **Do NOT turn the flag back off.** The fix needs no admin and no system
setting: pre-extract the archive yourself into the exact cache directory
electron-builder wants. The two `.dylib` symlinks are irrelevant on Windows.

```bash
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
SZ="<repo>/node_modules/.pnpm/7zip-bin@5.2.0/node_modules/7zip-bin/win/x64/7za.exe"
"$SZ" x -bd -y -o"$CACHE/winCodeSign-2.6.0" "$CACHE/<any-existing>.7z"   # exits 2, that is fine
ls "$CACHE/winCodeSign-2.6.0/rcedit-x64.exe"                             # must exist
```

The directory name **must** be `winCodeSign-2.6.0` — the numeric directories
already in that cache are abandoned temp dirs from failed attempts (there were
eight), which is why the failure repeated on every build. Once the correctly-named
directory exists the download is skipped entirely and the build succeeds.

---

## 3. ⛔⛔ THE SAFEGUARD — it reads the built artifact, not the config

`apps/desktop/scripts/verify-built-icon.ts`, wired into `pnpm dist`:

```
"dist": "pnpm build && electron-builder --win && pnpm verify:icon"
```

**A config assertion would not have been enough**, and that is the whole point.
Asserting `signAndEditExecutable !== false` only proves what we *asked for* —
rcedit can still fail (a locked file, antivirus), and electron-builder has been
known to warn rather than fail. So the verifier walks the built PE's resource
directory itself (dependency-free: DOS header → PE header → section table →
`.rsrc` → the type/name/language tree) and pulls out every **RT_ICON** resource,
then asserts:

1. every image in `assets/icon.ico` is present in the exe, **byte for byte**
   (rcedit embeds icon payloads verbatim, so this is an exact match, not a score);
2. **nothing else is** — a single foreign RT_ICON fails the build. This is what
   makes "the Electron atom can never come back" a fact rather than a hope;
3. the exe's version info contains `Loopcom` (rcedit writes the strings in the
   same pass, so this corroborates that the pass really ran).

✅ **Proven non-vacuous.** Pointed at the shipped 0.1.6 exe
(`pnpm verify:icon <path>` takes an explicit path for exactly this) it fails with
all nine assertions. Against the new build it passes:

```
verify:icon  exe      release\win-unpacked\Loopcom.exe
verify:icon  icon.ico 7 image(s): 16, 24, 32, 48, 64, 128, 256
verify:icon  exe      7 RT_ICON resource(s)
verify:icon  OK — the exe carries the Loopcom icon and nothing else
```

---

## 4. The icons are generated, and the spacing number lives in code

`scripts/desktop-loopcom-windows-assets.py` — same discipline as
`scripts/mobile-loopcom-android-assets.py`, for the same reason (the 2026-08-20
Android pass generated icons by hand and recorded the scale only in prose, so
nobody could tell afterwards what it had been).

- **`MARK_INK_W = 0.84`** — the mark's **ink** width as a fraction of the square.
  ⛔ Not the source PNG's box width: the brand PNG carries transparent padding and
  its ink is 0.854 of its own width. `ink_crop()` is used, **not
  `Image.getbbox()`** — the brand PNG has near-zero-alpha dust to the edges, so
  getbbox returns the whole square and the crop silently does nothing (this cost
  the Android pass a ~20% undersized mark).
- **Why 0.84 and not Android's 0.70:** an Android adaptive icon is a 108dp canvas
  of which only the central 72dp is shown, so its effective ink-vs-visible is
  `0.70 × 108/72 × 0.854 = 0.897`. **Windows applies no mask**, so 0.84 here is
  deliberately a hair smaller than 0.897 — same apparent size, no mask eating the
  glow.
- **The plate is OPAQUE `#0C1218`** — the same ground the Android launcher icon
  uses, so the two fleets show the same icon. A transparent glowing-blue mark is
  invisible on a light Windows 11 taskbar or a light Start menu.
- ⛔ **Small-size hinting, `SMALL_SIZE_GAIN = 1.35` for ≤32px.** Downsampling thin
  bright strokes onto a dark plate averages them into the plate and the logo goes
  muddy — at 16px, which is the size Izzy looks at all day. Measured against 1.0
  (dim) and 1.7 (washes the brand blue out to cyan).
- ⛔ **Each .ico frame is rendered independently at 4× supersample.** Pillow's
  `save(format="ICO", sizes=…)` downsamples ONE source for every entry, so the
  16px frame would come out of a 256px render and turn to mush.
- ⛔⛔ **Frames below 256 are BMP/DIB; only the 256 is PNG.** PNG-compressed .ico
  entries are only guaranteed at 256 on Vista+, and rcedit plus several Windows
  shell surfaces render a small PNG entry **blank**. An all-PNG .ico opens
  perfectly in an image viewer and ships an empty taskbar icon. The DIB's
  `biHeight` must be written as **double** the real height (the format reserves
  the lower half for the AND mask; 32bpp icons carry alpha and Windows synthesises
  the mask, so no mask bytes are appended — but the doubled height is mandatory or
  every frame renders squashed into the top half of its box).

`--check` verifies without writing. `--preview <path>` writes a side-by-side.

---

## 5. ⛔⛔ The notification: text only, no image, ever

Izzy called the first attempt "that big-ass icon" and pointed at **Claude's own
Windows toast** as the reference: small logo + app name in the **header**, text
underneath, nothing else.

**The bug:** Electron renders a Windows notification's `icon` option as the
toast's **inline image** — a full-width picture filling the body. There is no
Electron option to shrink it. The only way to get the standard layout is
**`toastXml`**, which supersedes `title`, `body` and `icon` entirely on Windows.

**What ships** (`src/notificationToast.ts`, a pure module importing nothing from
electron so it is testable and can be handed to Windows' own parser in a probe):

```xml
<toast><visual><binding template="ToastGeneric"><text>New voicemail</text><text>Sender Weiss</text></binding></visual></toast>
```

⛔⛔ **DO NOT ADD AN `<image>` BACK, IN ANY PLACEMENT.**
`placement="appLogoOverride"` renders a ~64px square left of the text — that was
the first attempt and is the thing this pass was asked to remove.
`placement="hero"` or a bare `<image>` is worse. Windows already draws the app
logo small in the header; an image is a **second copy of the same logo**.

⛔ Dropping the image also removed a trap that would have shipped broken:
`assets/` is packed **inside `app.asar`**, and Windows' toast renderer is a
separate OS process that cannot read inside an asar archive. `fs.existsSync`
answers **true** for such a path (Electron shims fs for the app's own process), so
the image would have rendered fine in development and silently not at all in the
shipped build. The old code got away with it because *Electron* read the file and
handed Windows a copy; with `toastXml` we are responsible.

⛔ **The header icon and name are not set by us and cannot be.** Windows reads
both from the Start Menu shortcut carrying the AppUserModelID: the name is
`nsis.shortcutName`, the icon is the shortcut's target executable's own embedded
icon. **That is exactly why §1 matters** — the atom in the toast header *was* the
atom in the exe.

Failure direction: a toast whose XML Windows refuses never appears and logs
nothing, so `note.on("failed")` falls back to a plain `new Notification({title,
body})` (no `icon`, so still the small-header layout) and records why.

**Proven live**, before the image was removed: the real toast XML was loaded by
`Windows.Data.Xml.Dom.XmlDocument` (Windows' own toast parser) — `PARSED OK` — and
shown via `ToastNotificationManager::CreateToastNotifier`. The captured screenshot
is what settled the diagnosis: header read **atom + "Connect"** (the old exe icon
and old shortcut name), body carried the oversized square.

---

## 6. "No mention of Electron, ever" — the honest ledger

✅ **Everything a person sees is clean**, verified on the built app:

| Surface | Now |
|---|---|
| exe filename | `Loopcom.exe` |
| ProductName / FileDescription / InternalName | `Loopcom` |
| CompanyName | `Loopcom LLC` (was **`GitHub, Inc.`** — Electron's default; fixed by adding `author` to package.json) |
| LegalCopyright | `Copyright (c) 2026 Loopcom LLC` |
| taskbar / Start / alt-tab / tray / window / installer / uninstaller / toast header icon | the Loopcom mark, byte-verified |
| window titles | Loopcom, Loopcom Mini Dialer, Loopcom Phone Engine |
| tray tooltip + menu | Loopcom |
| updater dialogs | Loopcom |
| Add/Remove Programs | Loopcom |
| user agent | Electron token stripped |

⛔ **The user agent is TRANSFORMED, never hardcoded** (`src/userAgent.ts`). The
`Chrome/<version>` token must stay truthful — sites and our own portal
feature-detect off it, and pinning a stale version breaks them as Electron is
upgraded. And **the product token is load-bearing, so it is replaced not dropped**:
the desktop fleet is identified in nginx access logs by it (the install census and
the per-machine triage in the softphone-lockout and mini-dialer handoffs). Installs
up to 0.1.6 say `Connect/0.1.6 … Electron/41.x`; from 0.1.7 they say
`Loopcom/0.1.7` with no Electron token — which incidentally makes the two
generations trivial to tell apart in a log.

⛔⛔ **ONE FILE REMAINS AND IT MUST NOT BE DELETED: `LICENSE.electron.txt`** in the
install folder (1,096 bytes). That is Electron's **MIT licence**, and MIT requires
*"The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software."* Removing it is a licence
violation. It never appears in the UI, the taskbar, a notification, Task Manager
or Add/Remove Programs — only if someone browses the install directory.
⏳ **If Izzy wants the word off the FILENAME**, renaming it to
`Third-party licences.txt` via an `afterPack` hook satisfies MIT (the notice is
still included) — **not done: it is a legal file and that is his call**, matching
this repo's convention of not rewriting legal documents unasked.

⚠️ Also in the install folder, not Electron and not touched: `elevate.exe`
("Elevate Application", Johannes Passing) — electron-builder's UAC helper.
`nsis.packElevateHelper: false` would drop it, at the risk of breaking any
installer path that needs elevation. Left alone.

---

## 7. ⛔ What was deliberately NOT changed

- **`appId` (`com.connectcommunications.desktop`) and the AppUserModelID.** NSIS
  keys the uninstall registry entry off appId, and Windows resolves an app's
  taskbar identity, its pinned entry and its notification attribution off the
  matching AUMID. Change it and the next update installs **side by side** with the
  old one instead of upgrading — two tray icons, two SIP phones, a double ring on
  every call — and every existing install's notifications lose their identity.
  The two must stay identical; a guard asserts it.
- **package.json `name` (`@connect/desktop`).** `app.getName()` derives
  `userData` from it (`%APPDATA%\@connect\desktop`). Changing it moves userData →
  every user signed out, mini-dialer bounds and settings lost. Confirmed by
  extracting the shipped `app.asar`'s package.json: electron-builder does **not**
  rewrite `name` from `productName`.
- **`artifactName` (`Connect-Setup-${version}.${ext}`).** The portal sidebar's
  Install link points at `/desktop/Connect-Setup-latest.exe` and
  `apps/portal/lib/loopcomParity.test.ts` pins that exact string. Renaming is a
  portal change (one line, one test line, and a second server-side alias so old
  links keep working) and this pass was scoped to leave the portal alone.
  ⏳ Open follow-up — the downloaded file is still called *Connect-Setup*.
- **The install directory** stays `%LOCALAPPDATA%\Programs\@connectdesktop` (it
  derives from `name`, not `productName`).

---

## 8. The packaging config moved to `electron-builder.yml`

⛔ electron-builder validates its config against a strict schema and **rejects any
unknown key**, so a `"//note": "..."` comment in package.json's `build` block
fails the build outright (it did). Every setting in there is one people have
flipped before without knowing the cost, so the warnings have to sit **on** the
settings — hence YAML. ⛔ electron-builder refuses to start if both the YAML file
and a `build` key exist; there is deliberately no `build` key in package.json any
more, and a guard asserts that.

---

## 9. Proven / not proven

✅ **Proven:**
- The built `Loopcom.exe` carries exactly the 7 frames of `assets/icon.ico` and
  **no foreign RT_ICON**, read out of the PE resource table.
- The same check **fails** against the shipped 0.1.6 exe (9 assertions), so it is
  not decorative.
- Version info on the built exe: Loopcom / Loopcom LLC / Loopcom LLC copyright.
- The installer's own icon is the Loopcom mark (extracted and compared visually
  against the old atom).
- Windows' own toast parser accepts the XML, and a real toast was rendered on
  screen from it.
- 22 guards in `src/branding.test.ts`; **16 fail when replayed against `HEAD`**
  via `DESKTOP_GUARD_ROOT`. The 6 that pass there are pure unit tests of modules
  HEAD does not contain.
- `tsc --noEmit`: 0 errors.
- A full `pnpm dist` end to end, three times.

⏳ **NOT PROVEN — and this is the honest limit:**
- **Nobody has installed 0.1.7.** The taskbar icon, the Start menu icon, the tray
  icon and the notification header have not been seen on a real install. They are
  proven as bytes in the exe and as a rendered toast, not by a human looking at
  a running app.
- **No real voicemail notification has fired from the new build.** The toast
  layout is proven from the XML (there is no `<image>` element to draw) and from a
  real Windows-rendered toast; the header showing *Loopcom* + the Loopcom mark
  follows from the shortcut, which only exists after an install.
- The user-agent override has not been observed in an nginx log.

**Acceptance test (one install, ~2 minutes):**
1. Run `apps/desktop/release/Connect-Setup-0.1.7.exe`.
2. Taskbar, Start menu and tray show the Loopcom infinity mark — **and still do
   after the window is hidden to the tray and reopened**, which is the exact
   moment the atom used to come back.
3. Right-click the tray icon: "Open Loopcom" / "Quit Loopcom".
4. Wait for a voicemail (or a text): the toast reads **Loopcom** with the small
   mark in the header, two lines of text, **no big square in the body**.
5. ⛔ **The negative that matters most:** the app still registers and rings.
   Nothing in this pass touches SIP, but the exe was renamed and the login item
   re-registered, so confirm a call comes through.

---

## 10. ⏳ Publishing is Izzy's call and has NOT been done

`release/Connect-Setup-0.1.7.exe` + `.blockmap` + `latest.yml` are built and
verified, sitting on the workstation. **They have not been copied to the server.**

Publishing (see [[desktop-app-publish-procedure]]) auto-updates every install that
polls the feed, and **the moment it lands every customer's app renames itself and
changes icon underneath them** — the same warning as the Android rebrand. Their
old `Connect.lnk` is replaced by `Loopcom.lnk` and `Connect.exe` by `Loopcom.exe`.

⚠️ One thing to watch on the first real upgrade: NSIS runs the old uninstaller
before installing, so it should remove `Connect.exe` / `Uninstall Connect.exe` /
`Connect.lnk`. If any survives, the user has two entries and the stale one still
carries the atom. Check the install folder after the first upgrade.

⚠️ Installs from the Jul-14 0.1.2 build and the 0.1.3 build have **no updater**
and will never see this — they need a manual reinstall (already recorded in
[[desktop-app-publish-procedure]]).
