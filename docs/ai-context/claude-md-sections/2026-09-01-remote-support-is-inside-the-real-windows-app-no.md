# ⛔⛔ AGENT HANDOFF — remote support is INSIDE the real Windows app now, OFF by default, and there is a test installer nobody has run (2026-09-01) — READ FIRST before adding ANY key to the desktop preload, before publishing a desktop build, before retiring `apps/desktop-support`, or for "is the remote desktop app deployed?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESKTOP_REMOTE_SUPPORT_TEST_BUILD_2026-09-01.md`**
(`ba39900a` on `feat/ivr-migration-takeover`. **NOTHING PUBLISHED** — no portal
deploy, no api deploy, no migration, no PBX write, no env change, and the desktop
update feed is untouched: `app.loopcom.net/desktop/latest.yml` still reads
**0.1.16**. The installer exists only on this workstation.)
Izzy, 2026-09-01: *"I want to have that app on my PC for testing before it's
being published on the install link."*

- ⛔ **CORRECTION TO A COMMON PREMISE: no open-source remote-desktop software was
  ever embedded.** The 2026-08-16 decision was to build it ourselves rather than
  take RustDesk; screen and input ride **WebRTC** (already in Electron) over the
  platform's **own coturn TURN relay**. `apps/desktop` still declares exactly one
  runtime dependency, `electron-updater`. What exists as "two things" is two
  FEATURES in the same area: **remote support** and **the AI Coworker bubble**.
- ✅ **What shipped as code:** the desktop half (`inputInjector.ts`,
  `bannerPreload.ts`, `mainWiring.ts`) lifted from `apps/desktop-support` — an app
  that has never shipped — into `apps/desktop/src/remoteSupport/`. Mechanism
  unchanged. The api + portal halves have been deployed since 2026-09-01, so the
  whole feature was waiting on this one packaging step.
  ⛔ **Deliberately NOT carried over:** the support app's LAN scanner (this app
  already has one at `phoneSetup/lanScan.ts` — two scanners is two answers to the
  same question) and its window/notification stubs (that app had neither; this one
  has both, for real). Source-guarded.
- ⛔⛔ **THE GATE, AND IT IS THE ONLY DANGEROUS PART OF THIS CHANGE.**
  `RemoteSupportConsent.tsx:102` decides the feature exists by testing
  `bridge?.remoteSupport?.listScreens`, and it is mounted for **EVERY signed-in
  user** — so publishing that key unconditionally makes every customer's app poll
  `/remote-support/pending` **every five seconds**, the day the build ships. Its
  own comment says *"Do not, until that is the decision being made."* **That
  decision is Izzy's and this commit does not make it.** The chain:
  `DesktopSettings.remoteSupportEnabled` (absent = OFF, opt-in from the tray) →
  `main.ts` passes `--connect-remote-support=1` → the preload publishes the key.
  ⛔ **When off the key is ABSENT, never an object of no-ops** — the portal tests
  for `remoteSupport?.listScreens`, so a stub would pass and start exactly the
  polling the gate prevents. ⛔ **Read from `process.argv`**, because the key must
  exist or not at the instant the bridge is built; a promise resolved later cannot
  make a key the portal already looked for.
  ⛔ **Hence the toggle applies at the NEXT LAUNCH and its tray label says so** —
  the alternative is reloading the window, which tears down the SIP phone, and **a
  support feature must never be able to drop a call.** ⛔ But turning it **OFF
  stops a running session immediately**: withdrawing permission is not something a
  customer should have to restart to mean.
  ✅ **So an update changes nothing for anybody who has not asked for it.**
- ⛔ **`setDisplayMediaRequestHandler` is registered UNCONDITIONALLY, and its
  absence is invisible** — without it `getDisplayMedia` hangs or rejects with
  nothing useful in the console and the bug reads as being in the portal, where it
  is not. It grants nothing (only a consented session ever calls it). The
  **customer's own screen pick beats Electron's hint**, falling back to a whole
  screen rather than an arbitrary window so a mis-pick is boring rather than
  revealing, and ⛔ **audio is never captured on any callback path.**
  `stopRemoteSupport()` runs on `before-quit` — a PowerShell helper that can move
  the mouse must not outlive the app that started it.
- ✅ **The test build: `apps/desktop/release/Connect-Setup-0.1.17-rc.1.exe`**
  (100,262,547 bytes). ⛔ **The version is the safety feature, checked with semver
  not reasoned about:** the live **0.1.16** feed will **not** downgrade it, and a
  future **0.1.17+** heals the machine back onto the fleet by itself. **This is why
  it is not the leftover `0.99.0` local build**, which would have refused every
  real release until the fleet passed 0.99.
  ⛔ **`appId` is UNCHANGED**, so it installs **OVER** the existing Loopcom app on
  that machine — same taskbar identity, same settings, same SIP phone. That is what
  makes it a real test of the real app, and why it belongs on a machine whose phone
  can afford a bad afternoon. ⛔ **`release/` is gitignored**, so the generated
  `latest.yml` (reading `0.1.17-rc.1`) **cannot reach the server** — do not upload it.
- ✅ **Proven:** 147/147 desktop tests (119 before), typecheck 0; ⛔
  `src/remoteSupport/*.test.ts` had to be **added to the `test` script** (the
  runner names its globs explicitly — the documented unregistered-test trap); the
  gate guards **read SOURCE** because the failure mode is a *caller*, which no unit
  test of a single function can see; and ⛔ **both mutations were run and both went
  red** (unconditional exposure → 2 failures, unconditional launch flag → 1).
  Verified in the **ARTIFACT**: `verify:icon` 7 RT_ICONs all ours, `asar list`
  shows `dist/remoteSupport/*` as real modules, exe reads `FileVersion
  0.1.17-rc.1` / `Loopcom LLC`.
  ⛔ **One of my own guards was wrong first and the code was right** — it compared
  against `preferredDisplaySurface`, which is read into `wanted` *above* the sliced
  block, so it matched nothing and asserted nothing. **Read the source before
  believing a source-reading guard.**
- ✅✅ **INSTALLED ON IZZY'S WORKSTATION 2026-09-01 15:26Z** (silent, exit 0,
  20.4 s, at his explicit request). Verified from the machine: exe
  `FileVersion 0.1.17-rc.1`, registry entry now `0.1.17-rc.1`, every marker in
  the installed asar, log banner `v0.1.17-rc.1`, **0 error lines**.
  ⛔⛔ **THE GATE IS PROVEN OFF ON THE LIVE PROCESS, NOT INFERRED** — Electron
  puts `additionalArguments` in each renderer's command line, so of **6 running
  Loopcom processes, 0 carry `--connect-remote-support=1`** while
  `--connect-window-kind=full` IS present (that second half is the non-vacuity
  control: argv is readable, so the flag's absence is the gate working).
  ✅ **It replaced the wedged 0.99.0** — that build's asar had the coworker
  bubble and ZERO remote-support markers, and its uninstall entry still read
  `0.1.16` while the exe read `0.99.0` (copied in, never installed), so it could
  never have auto-updated. Fixed as a side effect.
  ⚠️ **"Loopcom Support 0.0.2" is ALSO installed on that machine** — so "no
  installer anywhere has the remote desktop" was wrong for this workstation;
  what is true is that it was never in the CONNECT app and never published.
  ⚠️⚠️ **PRE-EXISTING, NOT FROM THIS BUILD: `[SipPhone][conn] init-failed` on
  startup and repeatedly after.** Compared against the previous launch before
  reporting — **0.99.0 shows the identical pattern** (03:38, 03:39, 03:41,
  03:45). ⛔ Do not read it as a regression; the documented cause is that the
  SUPER_ADMIN login sits on a tenant with no PBX link and no extension, so it
  structurally cannot register. **Check which account the window is signed into
  first.** ⛔ And `/S` does NOT relaunch the app — it closed Loopcom and left it
  closed, so the phone was down until started by hand.
- ⏳ **NOT PROVEN, and it is the whole gap: remote support has never been
  switched on, and no session has ever taken place between two machines.**
  Acceptance needs TWO machines and is in §7 of the handoff. ⛔ **The negative that matters most: on a
  machine where remote support was never turned on, the consent dialog must NEVER
  appear and there must be ZERO `/remote-support/pending` traffic** — that is the
  fleet gate doing its job. ⛔ Expect **antivirus noise** (PowerShell calling
  `SendInput` on an unsigned app) and ⛔ **UAC prompts will look frozen** (Windows
  refuses injected input to elevated windows — not a bug; it needs a SYSTEM
  service this version deliberately does not ship).
- ⏳ **Still open:** `apps/desktop-support` is **not retired** (leave it until a
  real session has run); the customer-wide decision is unmade; and **publishing**
  (upload + `latest.yml`, which auto-updates the whole fleet) is Izzy's call and
  should wait for the acceptance test.
