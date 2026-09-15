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

⏳ Nothing built, committed as code, deployed or tested.
