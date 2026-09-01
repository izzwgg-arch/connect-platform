# ⛔⛔ AGENT HANDOFF — remote support is IN the real Windows app now, off by default, and there is a test installer nobody has run (2026-09-01)

**Commit:** `ba39900a` on `feat/ivr-migration-takeover`.
**Deploy state: NOTHING PUBLISHED.** No portal deploy, no api deploy, no
migration, no PBX write, no env change, and **the desktop update feed is
untouched** — `app.loopcom.net/desktop/latest.yml` still reads **0.1.16**.
The installer exists only on this workstation.

**Izzy's ask, 2026-09-01:** *"I want to have that app on my PC for testing before
it's being published on the install link."*

---

## 1. First, a correction that matters

The premise going in was "two open-source pieces built into the Windows app."
**No open-source remote-desktop software was ever embedded.** The 2026-08-16
decision was explicitly to build it ourselves rather than take RustDesk or
similar; the screen and every input event ride **WebRTC** (already inside
Electron/Chromium) over the platform's **own coturn TURN relay**, the same one
the softphone uses. `apps/desktop` still declares exactly one runtime
dependency, `electron-updater`.

What actually exists as two things is two **features** built in the same area:

| feature | where it was | where it is now |
|---|---|---|
| Remote support (watch/drive a screen) | api + portal deployed; desktop half stranded in `apps/desktop-support` | **desktop half lifted into `apps/desktop`, this commit** |
| The AI Coworker (bubble + diagnostics) | committed `00699527`, never published | unchanged, rides the same test build |

---

## 2. What this commit did

Lifted the three files that make up the desktop half, unchanged in mechanism:

- `src/remoteSupport/inputInjector.ts` — verbatim copy. The PowerShell +
  `SendInput` helper, its sanitiser and its two documented hard limits (Windows
  refuses input to ELEVATED windows; the helper can only do what the signed-in
  user can do).
- `src/remoteSupport/bannerPreload.ts` — verbatim copy.
- `src/remoteSupport/mainWiring.ts` — copied, **minus** two things:
  - the **LAN scanner**, because `apps/desktop` already has one under
    `phoneSetup/lanScan.ts`. Two scanners in one process is two answers to the
    same question, and the desk-phone wizard owns that one.
  - the `support:minimize` / `support:notification` **stubs**, which existed
    only because the support app had no real window or notification handling.
    This app has both, registered in `main.ts`.

Plus the wiring in `main.ts`, `preload.ts`, `types.ts` described below.

⛔ **`apps/desktop-support` is untouched and still builds.** It was not deleted.
Retiring it is a separate decision and should not happen until a real session has
run through the Connect app.

---

## 3. ⛔⛔ THE GATE — the only genuinely dangerous part of this change

`apps/portal/components/RemoteSupportConsent.tsx` is mounted for **every
signed-in user**, and line 102 decides the whole feature exists by testing:

```ts
const supported = Boolean(bridge?.remoteSupport?.listScreens);
```

Its own comment is emphatic: adding that key to the Connect app's preload
**switches customer-wide polling of `/remote-support/pending` on, every five
seconds, the day the build ships** — *"Do not, until that is the decision being
made."*

That is Izzy's decision, not a side effect of packaging. So the key is published
only when this installation has opted in:

```
DesktopSettings.remoteSupportEnabled     absent = OFF (opt-in from the tray)
  └─> main.ts webPreferences() passes --connect-remote-support=1
        └─> preload.ts publishes the remoteSupport key … or does not
```

⛔ **When off the key is ABSENT, not an object of no-ops.** The portal tests
`remoteSupport?.listScreens`, so a stubbed object would pass that test and start
exactly the polling the gate prevents. The false branch hands over `desktopApi`
itself.

⛔ **Read from `process.argv`, not by asking main.** The key must exist or not at
the instant the bridge is built; a promise resolved later cannot create a key the
portal has already looked for and not found.

⛔ **That is also why the toggle applies at the NEXT LAUNCH**, and its tray label
says so (`"Allow Remote Support (after restart)"`). The alternative is reloading
the window, which tears down the SIP phone — **a support feature must never be
able to drop a call.** A toggle that silently does nothing until later is how
somebody concludes the feature is broken, hence the label.

⛔ **Turning it OFF stops a running session immediately** (`toggleRemoteSupport`
calls `stopRemoteSupport()` on the false branch). Withdrawing permission is not
something a customer should have to restart to mean.

**So: an update changes nothing for anybody who has not asked for it.** If this
code reached the fleet tomorrow, every customer would have `remoteSupportEnabled`
absent, the key would not be published, and the portal would fall through exactly
as it does today.

---

## 4. The other pieces

- **`setDisplayMediaRequestHandler`** is registered **unconditionally** in
  `whenReady`. ⛔ Without it `getDisplayMedia` hangs or rejects with nothing
  useful in the console, and the bug reads as being in the portal, where it is
  not — this is the single easiest piece to leave out. It grants nothing on its
  own: only a consented session ever calls `getDisplayMedia`.
  - The **customer's own screen choice wins** (`getPreferredSourceId()`) over
    Electron's `preferredDisplaySurface` hint, falling back to a whole screen
    rather than an arbitrary window, so a mis-pick is boring rather than
    revealing.
  - ⛔ **Audio is never captured, on every callback path** — support looks at a
    screen; it does not listen to the room the customer is sitting in.
- **`stopRemoteSupport()` on `before-quit`** — a PowerShell helper that can move
  the mouse must not outlive the app that started it.
- The IPC handlers are registered unconditionally beside `registerPhoneSetup`.
  Registering them is **not** switching the feature on: nothing calls them unless
  the preload published the key.

---

## 5. The test build

**`apps/desktop/release/Connect-Setup-0.1.17-rc.1.exe`** — 100,262,547 bytes,
built 2026-09-01 15:14Z.

⛔ **The version is the safety feature, and it was checked with semver rather
than reasoned about:**

| feed says | what happens to the test machine |
|---|---|
| 0.1.16 (live today) | **ignored** — the test build stays |
| 0.1.17 / 0.1.18 / 0.2.0 | **updates** — heals back onto the fleet by itself |

So the test install cannot be dragged backwards by the current feed, and the next
real fleet release adopts the machine automatically. **This is why it is not
`0.99.0`** — the earlier local build at that version would have refused every
real release until the fleet passed 0.99.

⛔ **`appId` is UNCHANGED** (`com.connectcommunications.desktop`), per the
standing rule. Consequence, stated plainly: **this installs OVER the existing
Loopcom app on that machine** — same taskbar identity, same settings, same SIP
phone. That is what makes it a real test of the real app, and it is also why it
should go on a machine whose phone can afford a bad afternoon.

⛔ **`release/` is gitignored**, so the generated `release/latest.yml` (which
reads `0.1.17-rc.1`) **cannot reach the server**. Nothing about publishing has
been touched. Do not upload it.

---

## 6. Proven, and how

- **147/147 desktop tests** (119 before this commit), **typecheck 0**.
- ⛔ `src/remoteSupport/*.test.ts` was **added to the `test` script** in
  `package.json`. The runner names its globs explicitly — an unregistered test
  never runs, which is a trap this repo has paid for repeatedly.
- **The gate guards read SOURCE on purpose** (`fleetGate.test.ts`). The failure
  mode here is a *caller* publishing a key it should not, or `main.ts` forgetting
  the argument — neither is visible to a unit test of any single function.
- ⛔ **Both mutations were run and both went red**, so the guards are not
  decorative:
  - exposing `remoteSupport` unconditionally → **2 failures**
  - passing `--connect-remote-support=1` unconditionally → **1 failure**
- ⛔ **One of my own tests was wrong first and the code was right** — it asserted
  the ordering of `getPreferredSourceId()` against `preferredDisplaySurface`,
  which is read into `wanted` *above* the block being sliced, so the pattern
  matched nothing and the assertion was meaningless. Fixed to compare against
  `=== wanted`, which is what the fallback chain actually uses. **Read the source
  before believing a source-reading guard.**
- **Verified in the ARTIFACT, not the config:**
  - `verify:icon` → 7 RT_ICONs, all ours, nothing foreign.
  - the packed `app.asar` carries `dist/remoteSupport/*` as real modules
    (`asar list`), plus every IPC channel, `--connect-remote-support=1`,
    `setDisplayMediaRequestHandler` and `SendInput`.
  - exe properties read `FileVersion 0.1.17-rc.1`, `CompanyName Loopcom LLC`,
    `ProductName Loopcom`.

---

## 6b. ✅ INSTALLED ON IZZY'S WORKSTATION — 2026-09-01 15:26Z

Installed silently (`/S`, exit 0, 20.4 s) at his explicit request. Verified from
the machine, not from the exit code:

- `Loopcom.exe` → `FileVersion 0.1.17-rc.1`, `CompanyName Loopcom LLC`.
- The uninstall registry entry now reads **0.1.17-rc.1**.
- The installed `app.asar` carries every marker: the IPC channels,
  `--connect-remote-support=1`, `setDisplayMediaRequestHandler`, the tray label,
  and the coworker bubble.
- Log banner `=== log start v0.1.17-rc.1 win32 ===`, user agent
  `Loopcom/0.1.17-rc.1`, **zero error lines** on that launch.

⛔⛔ **THE GATE IS PROVEN OFF ON THE LIVE PROCESS, NOT INFERRED.** Electron puts
`additionalArguments` into each renderer's command line, so it can be read from
outside the app: of **6 running Loopcom processes, 0 carry
`--connect-remote-support=1`**, while `--connect-window-kind=full` IS present on
the renderer. That second half is the non-vacuity control — it proves argv is
readable, so the flag's absence is the gate working rather than an empty
command line. His `settings.json` (which predates the key entirely) still has no
`remoteSupportEnabled`, which is exactly the shape every customer's file has.

**What the install replaced, and this matters:** his machine was running
**0.99.0** — the leftover local build from 2026-08-31, whose asar had the
coworker bubble and **zero** remote-support markers. ⛔ Its uninstall entry still
read `0.1.16` while the exe read `0.99.0`, so it had been put there by copying
rather than by running an installer. That machine could never have auto-updated
(0.1.16 < 0.99.0); **this install fixed that wedge as a side effect** and the
registry is consistent again.

⚠️ **Also found installed: "Loopcom Support 0.0.2"** — the separate
`apps/desktop-support` app really is on that machine (not running). So the
statement "no installer anywhere contains the remote desktop" was **wrong for
this workstation**; what was true is that it was never in the CONNECT app and
was never published to customers.

⚠️⚠️ **PRE-EXISTING AND NOT CAUSED BY THIS BUILD: the softphone logs
`[SipPhone][conn] init-failed` on startup and repeatedly afterwards.** Checked
against the previous launch before reporting: the **0.99.0** launch at 03:38Z
shows the identical pattern (init-failed at +4 s, then again at 03:39:50,
03:41:54, 03:45:41). ⛔ Do not read this as a regression from the remote-support
lift. The documented cause is almost certainly the account fact already recorded
in CLAUDE.md — the SUPER_ADMIN login (`izzywgg@gmail.com`) sits on
`connect-admin-tenant-v1`, which has **no PBX link and no extension**, so it
structurally cannot register; his phone identity is the separate Landau Home
login. **Confirm which account that window is signed into before treating it as
a fault.**

⛔ **The silent install did NOT relaunch the app** — `/S` closed Loopcom and left
it closed, so the phone was down until it was started by hand. Budget for that,
or launch it explicitly, when installing on a machine somebody is using.

---

## 7. ⏳ NOT PROVEN — and this is the whole remaining gap

**Remote support has still never been switched on, and no session has ever taken
place between two machines.** The build is installed and the OFF state is proven;
not one pixel of a shared screen has crossed a wire through the Connect app.

**Acceptance test, and it needs TWO machines:**

1. Install `Connect-Setup-0.1.17-rc.1.exe` on the test machine.
2. Tray → **Allow Remote Support (after restart)** → quit Loopcom fully (tray
   included) → reopen.
3. From a second machine, signed in as a technician, request a session against
   that user.
4. On the test machine the consent dialog appears: the reason verbatim, the
   capability rows, the screen picker.
5. Allow, with control ticked. Expect: the red always-on-top banner, the
   technician sees the screen, the mouse moves.
6. **The negatives, which matter more:**
   - Press **Stop sharing** on the banner → sharing ends immediately.
   - ⛔ On a machine where remote support was **never turned on**, the consent
     dialog must **never appear** and there must be **no `/remote-support/pending`
     traffic at all**. That is the fleet gate doing its job and is the single
     most important thing to confirm.
   - Make a phone call during a session → the picture should soften and the
     banner note should say why (rule 15, `callInProgress`).
   - Ask for the clipboard mid-session → the question appears in the banner.

⛔ **Expect antivirus noise on step 5.** The injector is PowerShell calling
`SendInput`, which is genuinely what malware looks like; the app is not
code-signed. This is documented in `inputInjector.ts` and is the piece most
likely to need replacing with a small signed native addon.

⛔ **UAC prompts and the login screen will look frozen** to the technician.
Windows refuses injected input to elevated windows. Not a bug — fixing it needs a
service running as SYSTEM, which this version deliberately does not ship, and the
consent dialog already draws that row as unavailable.

---

## 8. Still open

- **`apps/desktop-support` is not retired.** Leave it until a real session has
  run through the Connect app.
- **The customer-wide decision has not been made** and this commit deliberately
  does not make it. Making it = defaulting `remoteSupportEnabled` on, or removing
  the gate — at which point every customer polls every five seconds, and that
  polling cost should be looked at first.
- **Nothing is published.** Publishing means uploading to
  `/opt/connectcomms/downloads/desktop/` and updating `latest.yml`, which
  auto-updates the whole fleet. That is Izzy's call and should wait for the
  acceptance test above.
