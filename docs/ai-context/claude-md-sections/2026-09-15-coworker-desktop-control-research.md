# Coworker whole-desktop control + admin PowerShell — RESEARCH ONLY, nothing built (2026-09-15)

Izzy asked: does the Coworker control the desktop screen (mouse/keyboard)? If not, wire in open source; a
Loopcom-coloured edge overlay while it drives; Escape ends it; the agent's mouse separate from the person's.
Follow-up: can the Coworker run PowerShell as administrator, with permission?

## Verified in source (branch `feat/ivr-migration-takeover`, desktop 0.1.17-rc.16)

- ⛔ **NO whole-desktop control exists.** `apps/desktop/src/coworker/toolCatalog.ts` has 31 tools: files, xlsx,
  PowerShell, CIM, diagnostics, MCP and `computer_browser_*`. Every click/screenshot tool drives the Coworker's OWN
  browser (hidden Electron partition / Playwright isolated Chrome profile), never the person's screen.
- `policyCore.ts` already RESERVES the category `COMPUTER_USE` and domain `desktop.active` (in `NEVER_AUTO_DOMAINS`,
  `ask` in every profile, deferred during a phone call) — no tool uses them. A desktop-control tool slots in there.
- Remote support already ships a Windows `SendInput` injector (`apps/desktop/src/remoteSupport/inputInjector.ts`,
  PowerShell P/Invoke) and an ELEVATED helper (UAC "Yes" → `Start-Process -Verb RunAs` → user-SID-locked named pipe,
  one-time token). Reusable pieces; they move the REAL cursor.
- **PowerShell today = NOT elevated.** `runtime/shell.ts` spawns `powershell.exe -NoProfile -NonInteractive` as the
  signed-in user; `shell` asks under SAFE/TRUSTED, allows under AUTONOMOUS; `SHELL_DENY_PATTERNS` refuses Defender /
  firewall / services / accounts / HKLM policy / network / installers / remote access / power / disk / UAC / encoded /
  credentials whatever the profile. `Start-Process -Verb RunAs` is not denylisted, but its output never returns and the
  agent cannot answer the UAC prompt (secure desktop) — so there is no working admin path.
- Admin PowerShell WITH permission is buildable on the remote-support elevated-helper pattern (person clicks Windows'
  own UAC Yes each time; pipe locked to the user SID). ⛔ The denylist must still apply to elevated scripts; elevation
  would need its own NEVER_AUTO domain. Not built.

## Separate mouse — what Windows allows (web-verified)

- Windows has ONE system cursor. `SendInput` / pyautogui-style tools (e.g. CursorTouch **Windows-MCP**, MIT) move it →
  agent and person fight over it.
- Synthetic touch/pen (`InjectSyntheticPointerInput`) is NOT independent: Microsoft notes touch can move the logical
  mouse cursor.
- **UI Automation** (invoke/value/select patterns) acts on controls with NO cursor — the person keeps their mouse —
  but not every app exposes UIA (games, some canvas/Chromium content).
- **True separate mouse+keyboard = a second Windows session.** Microsoft **UFO²** (MIT, Python) describes a
  Picture-in-Picture desktop over RDP loopback: "Mouse and keyboard events generated within the PiP desktop are fully
  scoped to that session". ⛔ Its docs said PiP arrives "in the next release"; no PiP code/mention found in the public
  README. Windows child sessions (`WTSEnableChildSessions`, Win8+) are the native basis; enabling is an admin system
  setting; edition support (Home vs Pro) NOT verified. The agent's session does not show the person's open windows.

## Recommendation given to Izzy (awaiting his call)

1. Mockup first (overlay + approval + consent), matching the Remote Desktop precedent.
2. Phase 1 on the real desktop: UIA-first (no cursor), `SendInput` fallback only while the edge overlay is up; the
   agent YIELDS the moment the person moves their mouse/types; Escape (low-level hook, not a global Esc shortcut that
   would steal Esc from every app) ends the run; screenshots via `desktopCapturer`; tool under `desktop.active`.
3. Phase 2: separate session (child session / RDP loopback) for a genuinely separate mouse.
4. Admin PowerShell: per-call UAC via the existing elevated-helper pattern, denylist kept.

## Izzy's decision (2026-09-15, later same day)

*"The mouse is not that important. One mouse, I'll live with that."* → the separate-session phase (option 3) is
DROPPED. Build = one shared cursor (UIA where available, SendInput otherwise), edge overlay, Escape ends, agent yields
when the person moves the mouse/types, admin PowerShell via UAC. Hard limits still stand: the UAC prompt and the lock
screen cannot be driven; DRM-protected windows capture black.

## Mockup approved-for-review + build decisions (2026-09-15, later)

- **Mockup published** (active-desktop takeover screen): https://claude.ai/artifact/MG6Myf27kDKhyp1iYHneCR — blue edge frame,
  live plain-English status strip, Escape-to-stop hint, agent-click ripple, four frame states (Working blue / You-took-over
  grey / Needs-OK amber / Finished green), the reused approval card, and the behaviour rules incl. the two Windows limits.
  Palette is the SHIPPED `coworkerApproval.html` one (brand #22a8ff / #1e5cff, danger #f06060, warn #f0b655) so it reads as
  real Loopcom. Source in this session's scratchpad `screen-control-mockup.html`.
- **Izzy's build decisions (AskUserQuestion, 2026-09-15):**
  - Cursor: **buttons-first** — press the real control via UI Automation with NO cursor movement; move the shared cursor
    (reuse remote-support `inputInjector.ts` SendInput) only when a control can't be reached that way.
  - Autonomy: **ask once before the first takeover, then flow** — one `desktop.active` approval starts control; after that
    it works the task and only re-asks for the risky domains (delete/pay/send/admin), matching SAFE/TRUSTED/AUTONOMOUS.
  - Izzy: *"Build it all: end-to-end, production-ready… Do not stop until you have proof, 100% stress-tested."*
- **Build plan (reuses proven code):** desktop `coworker/screenControl/` — screen capture via Electron desktopCapturer;
  input via the remote-support `PowerShellInputInjector`/`ElevatedInputInjector` (already built, `SendInput`+UAC pipe);
  UIA click-by-name (no cursor); a transparent click-through always-on-top edge-overlay BrowserWindow per display; a
  low-level yield watch (WH_*_LL hook keyed on our SendInput `dwExtraInfo` signature so our own input never self-pauses);
  a global Escape ends it. New `COMPUTER_USE` tools in `toolCatalog.ts`+`runtime/` under domain `desktop.active`
  (already reserved in `policyCore.ts`, NEVER_AUTO). Vision: screenshots ride back as image content — the agent router
  already maps `{type:"image"}` parts, but ONLY on user turns and tool_result content is JSON-stringified today, so a
  bounded screenshot→model-vision transport is NEW work. Admin PowerShell via the existing elevated helper. Toggles on
  BOTH `/admin/permissions` and `/admin/roles/[id]` (the fourth rule).
- ⛔ HONESTY NOTE for whoever verifies: the deterministic logic (policy gate, input sanitisation, yield decision, capture
  bounds, overlay state machine, vision-transport shape) can be exhaustively unit/stress-tested here. The final leg —
  a real cursor moving on a real screen and a screenshot round-tripping through a live provider — needs a human on a
  Windows box, exactly as remote-support's injector is "built, never proven on a real machine." Do not report that leg
  proven from green tests.

## BUILD — Phase 1 shipped as code (2026-09-15), OFF by default, live leg needs a human

Full handoff: `docs/ai-context/AGENT_HANDOFF_COWORKER_SCREEN_CONTROL_2026-09-15.md`.

**What's built and PROVEN by test here (31 coworker tests green, `tsc` clean, no regression across 110 coworker+remoteSupport tests):**
- **Pure core** `apps/desktop/src/coworker/screenControl/session.ts` — the state machine (idle/working/paused/asking/ended → blue/grey/amber/green), the **ask-once-then-flow** single-owner session, `screenArgsToCommand` (reuses remote-support `sanitizeCommand`), `shouldYieldTo` (our injected input never self-pauses; the person's does; unreadable events fail safe to "hand the mouse back"). Fully unit-tested.
- **8 tools** in `toolCatalog.ts`: `computer_screen_{begin,read,click,type,key,scroll,move,capture,end}` (that's 9 names incl. end), all `COMPUTER_USE` + `desktop.active`; `begin` is `alwaysRequireApproval`. `read` is the **buttons-first eyes** (UI-Automation control list); `click` prefers `target` (Invoke by name, NO cursor) over `x/y` fractions. `computer_powershell` gained `elevated`.
- **Runtime gate** `runtime/index.ts`: begin faces the policy ask; once approved for a task, actions flow with **zero re-asks** (stress-proven: 500 actions, 1 ask); a screen action with no session is refused outright (mouse never moves by surprise); consent never leaks across tasks; a denied `desktop.active` override still wins; a live phone call defers it; screen tools hidden from the manifest when no controller is wired. **Admin PowerShell always asks** (even AUTONOMOUS), honours the denylist, `elevation_unavailable` without the helper.
- **Opt-in** `DesktopSettings.coworkerScreenControlEnabled` (default OFF) + a tray checkbox "Let the Coworker control the screen"; turning it off ends a live session at the next action.

**Built as code, ⏳ NOT PROVEN (needs a human on a real Windows screen):** the Electron surface —
`screenController.ts` (capture via `desktopCapturer`; input via the reused remote-support `PowerShellInputInjector`;
UIA read/Invoke via PowerShell; the yield+Escape low-level hook classifying our events by injection-timing),
`overlay.ts` + `assets/coworkerScreenOverlay.html` (the blue click-through edge frame per display), and
`elevatedShell.ts` (UAC `Start-Process -Verb RunAs`). None of it has driven a real cursor or captured a real screen
here — exactly the position remote-support's injector is in.
- ⛔ **Two honest gaps to confirm with Izzy:** (1) the mockup says "Escape works normally in your other apps" — the
  v1 Escape watcher is a NON-swallowing LL hook, so that holds IF the hook works; unproven. (2) our injected events are
  classified as "ours" by a 220 ms timing window (the reused injector doesn't stamp `dwExtraInfo`), a heuristic — a
  signature-stamping injector is the robust follow-up. (3) **model pixel-vision is Phase 2** (a screenshot into the
  model's eyes needs a cross-provider transport; the UIA control tree is the eyes for buttons-first today).

⏳ Nothing built, committed as code, deployed or tested (as of the research; the BUILD section above is current).
