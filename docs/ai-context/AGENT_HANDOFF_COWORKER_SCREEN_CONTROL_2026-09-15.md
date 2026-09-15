# ⛔ AGENT HANDOFF — the Coworker can CONTROL THE REAL DESKTOP SCREEN (buttons-first UI Automation + cursor fallback), with a blue edge frame, Escape-to-stop, ask-once-then-flow, and admin PowerShell — Phase 1 BUILT AS CODE, OFF by default, live leg unproven (2026-09-15)

Read first: `AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md` (the hands this extends), the summary
`docs/ai-context/claude-md-sections/2026-09-15-coworker-desktop-control-research.md`, and `remoteSupport/inputInjector.ts`
(the SendInput helper this reuses). Mandate: Izzy, 2026-09-15 — *"Build it all: end-to-end, production-ready, rock hard…
Do not stop until you have proof, 100% stress-tested."* Decisions locked via AskUserQuestion: **buttons-first** (UIA click
by name, cursor only as fallback) and **ask once, then flow**. Mockup APPROVED: https://claude.ai/artifact/MG6Myf27kDKhyp1iYHneCR

## Why the decision core is what got proven, and the live leg did not

Everything that decides SAFETY is a pure function or a runtime gate, and all of it is unit/stress-tested in this
environment (31 new tests, 110 coworker+remoteSupport green, `tsc -p` clean). The part that moves a real cursor and
captures a real screen is Electron + PowerShell that only runs against a live Windows desktop — the same position
remote support's injector has always been in ("built, never proven on a real machine"). Reporting the live leg as
proven from green tests would be the exact lie CLAUDE.md forbids. So: the gate is proven; the I/O is staged behind an
OFF-by-default opt-in and needs a human.

## Files

| File | What | Proven? |
|---|---|---|
| `screenControl/session.ts` | PURE: state machine, `ScreenControlSession` (single-owner, ask-once), `screenArgsToCommand` (via remote-support `sanitizeCommand`), `shouldYieldTo`, `STATE_FRAME`, ceiling/idle constants | ✅ unit |
| `screenControl/controller.ts` | PURE interface `ScreenController` + `RunElevatedPowerShell` — the runtime talks to this, never Electron | ✅ (typed) |
| `toolCatalog.ts` (+) | 9 `computer_screen_*` tools; `computer_powershell` gains `elevated` | ✅ unit |
| `runtime/index.ts` (+) | the gate: per-machine opt-in check, ask-once session gate (`screenPreApproved`), admin-elevation spec variant, 9 runtime cases | ✅ unit/stress |
| `screenControl.test.ts` | 13 tests incl. the 500-action ask-once stress and admin/denylist | ✅ |
| `screenControl/screenController.ts` | ELECTRON: capture (`desktopCapturer`), input (reused `PowerShellInputInjector`), UIA read/Invoke (PowerShell), overlay wiring, yield+Escape hook | ⏳ needs human |
| `screenControl/overlay.ts` + `assets/coworkerScreenOverlay.html` | the blue click-through edge frame, one window per display, receive-only preload bridge | ⏳ needs human |
| `screenControl/elevatedShell.ts` | UAC `Start-Process -Verb RunAs`, output via temp files | ⏳ needs human |
| `hands.ts`, `main.ts`, `preload.ts`, `types.ts` (+) | wiring: construct the controller + elevated runner, pass into runtime deps, `desktopCapturer` dep, `coworkerScreenControlEnabled` setting + tray checkbox, overlay bridge | tsc ✅, live ⏳ |

## The security model (unchanged shape; nothing weakened)

- `desktop.active` was ALREADY a `NEVER_AUTO_DOMAIN` and deferred-during-call in `packages/shared`. The shared policy
  core needed NO change — screen tools just declare `category:"COMPUTER_USE"`, `domains:["desktop.active"]`.
- **Ask once, then flow:** `computer_screen_begin` is `alwaysRequireApproval` → asks. On approval the runtime opens the
  pure session (`ScreenControlSession.begin(taskId)`); subsequent `computer_screen_*` actions pass `approved:true` to
  `decideToolCall` **only** when `screen.isApprovedFor(taskId)` — so the desktop.active `ask` is satisfied without
  re-asking, but a denied override, a call, or the kill switch still deny FIRST (their checks run earlier). The risky
  sub-actions (delete/pay/send/admin) are SEPARATE tools with their own domains and still ask.
- A screen action with **no open session is refused outright** (`screen_not_started`) — the mouse never moves by
  surprise, and consent never leaks across tasks (per-task id).
- **Admin PowerShell:** `elevated:true` makes the runtime evaluate a spec variant `{risk:"HIGH", alwaysRequireApproval:true}`
  so it always asks; the `SHELL_DENY_PATTERNS` denylist is applied to the elevated script too, BEFORE the UAC helper runs.

## ⛔ What a future session MUST keep

- Keep the pure core pure (no Electron in `session.ts`/`controller.ts`) — the runtime tests import them.
- Never let a screen action run without an approved session for THAT task. Never pass `approved:true` for `begin`.
- The overlay window loads a LOCAL file and is click-through/non-focusable — never point it at the portal (a portal
  window with an unknown kind runs a SIP phone by default; the kind `coworker-screen-overlay` is registered in
  `DesktopWindowKind` and loads `assets/coworkerScreenOverlay.html`).
- OFF by default: `begin` refuses unless `coworkerScreenControlEnabled === true`; the tools are hidden from the manifest
  when no controller is wired.

## ⏳ The proof a human must produce (acceptance)

1. Turn on the tray "Let the Coworker control the screen". Ask the Coworker to do something on the real screen.
2. See the **blue frame** on every monitor + the status strip; the approval prompt names the reason.
3. Approve once → it reads controls (`computer_screen_read`), clicks a real button by name (no cursor jump), types.
4. **Move your mouse** mid-run → frame goes **grey**, it pauses; stop → after ~2.5 s it resumes (blue).
5. Press **Escape** → it stops and the frame drops. Confirm Escape still worked in the underlying app (the LL-hook
   non-swallow claim). If it did NOT reach the app, that is gap (1) — decide swallow-vs-passthrough with Izzy.
6. Ask for an admin command → Windows' own UAC prompt → Yes → output returns; No → `declined_uac`.
7. Negative: turn the tray toggle OFF mid-session → it stops at the next action.

## Known follow-ups (documented, not built)

- **Model pixel-vision (Phase 2):** a bounded screenshot into the model's eyes needs a cross-provider transport (the
  agent router JSON-stringifies tool results and `desktopLink` caps at 60 k chars; images need an image content block on
  Anthropic and a following user image on OpenAI). Today the UIA control tree is the eyes (buttons-first).
- **Signature-stamped injector:** replace the 220 ms timing heuristic with a `dwExtraInfo` signature so the yield hook
  distinguishes our events exactly. Requires a screen-control injector variant (don't touch remote support's).
- **Escape passthrough:** confirm the non-swallowing LL hook lets Escape reach apps; else reconcile with the mockup.

## Deploy state

Desktop-only; nothing to deploy to a server. Committed to `feat/ivr-migration-takeover` (by explicit pathspec, after the
concurrent `connect-2-62` session's git-tools/webmail commit landed — shared-worktree hazard was live and coordinated).
No installer built, not published, OFF by default.
