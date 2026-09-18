# ⛔ LOOPCOM COMPUTER CONTROL — one Local Worker process now controls real Windows programs by name, with a signature-stamped input fallback and a cross-tool resource policy (2026-09-18, `3960a256`) — READ BEFORE touching `apps/desktop/src/coworker/computerControl/`, `apps/desktop/src/coworker/screenControl/`, `apps/desktop/src/coworker/runtime/index.ts`'s gate section, or `apps/agent/src/coworker/toolDiscovery.ts`

Full detail: `docs/ai-context/AGENT_HANDOFF_COMPUTER_CONTROL_2026-09-18.md`. Supersedes
`AGENT_HANDOFF_COWORKER_SCREEN_CONTROL_2026-09-15.md` for the program/screen layer (that file's
one-process-per-call design and the 220 ms timing heuristic are both gone).

## What a person can now ask for

- **Press a real button or menu item by name, in a real program, with no cursor movement** —
  `computer_windows_*` tools read a window's controls (buttons, checkboxes, dropdowns, tabs, menus,
  trees, tables) through Windows UI Automation and act on them by name or reference: invoke, set a
  value (with the value read back to confirm), select, toggle, expand/collapse, scroll, focus, walk
  a menu path like File → Save As.
- **Open a program by name** (`computer_app_launch`) and get back which window appeared.
- **See the screen when reading controls is not enough** (`computer_screen_look`) — a downscaled
  picture the model itself looks at, for things UI Automation cannot describe (a custom-drawn
  control, a game, a picture).
- **Fall back to a real mouse/keyboard click** when there is no named control to invoke
  (`computer_screen_click`/`_type`/`_key`/`_scroll`/`_move`), with a blue on-screen frame while it
  runs and Escape to take the screen back.
- **Run a PowerShell command**, with the risk decided from what the script actually does
  (read-only runs at once; anything that changes something follows the person's permission profile;
  anything high-risk always asks, whatever the profile says).

## The rules a future change must keep

- **One resource policy, every tool.** A path, command, or value that is refused for one tool
  (file read, PowerShell, UI Automation `set_value`, app launch, browser upload) must be refused for
  all of them — they all call the same functions in `computerControl/protectedResources.ts`. Never
  add a tool-specific copy of a "is this a secret" check.
- **Ask-once covers the screen/program session only, never a destructive action inside it.**
  `computer_screen_begin` asks once per task; process kill, elevated PowerShell, and anything else
  marked destructive or `alwaysRequireApproval` still ask every time, inside the session.
- **`workerScript.ts` compiles with PowerShell 5.1's C# compiler (effectively C# 5).** No string
  interpolation, no `nameof`, no `out var`. There is no build step catching a mistake here — a
  broken worker just never reaches `ready`.
- **The low-level input hook always calls `CallNextHookEx` and only runs inside an open screen
  session.** Never let it swallow an event, and never install it outside `hook.start`/`hook.stop`.
- **A script piped to `powershell.exe -Command -` must be wrapped `& { … }` with a blank line after
  the closing brace**, or a multi-line block at end-of-input is silently dropped (exit 0, no output,
  no error) — this cost a real debugging session before the wrap-and-blank-line fix was applied
  everywhere a script is piped to PowerShell.
- **`toolGroup()` (desktop, `runtime/index.ts`) and `familyOf()` (agent, `toolDiscovery.ts`) must
  agree on which family a `computer_*` name belongs to** — a mismatch means the model can be offered
  a tool the runtime will refuse.

## Deployed and proven (2026-09-18)

- **agent** rebuilt on loopcom and container-verified (routing work in `d232cf68`); **desktop**
  `0.1.17-rc.21` built from a clean export of the branch tip `b09e735c` and installed on
  DESKTOP-8HUS877, installed `app.asar` hash matched the build byte-for-byte. ⛔ NOT published to
  the fleet feed — that is Izzy's call.
- **Proven on this machine, through the installed app, by ordinary sentences in the chat**: Notepad
  typed + saved through its real Save As dialog; Calculator showing **16,907** with zero positional
  clicks; the acceptance app's text/radio/checkbox/combo/dialog/tab all driven and verified from the
  app's OWN state file; the purple UIA-invisible control clicked via `computer_screen_look` (counter
  0→1); Explorer opened but the folder made with the file tool; a protected file refused on every
  road; an injected instruction summarized not obeyed; the kill switch stopping a live screen task;
  the Local Worker killed mid-task and restarted.
- ⛔⛔ **The acceptance run found a bug nobody had seen: one person with TWO computers signed into
  one account shared ONE queue**, so the model was told about machine A's tools and the call ran on
  machine B (a file appeared on another computer entirely). The session is per COMPUTER now, a task
  stays on the computer it started on, STOP reaches all of them, and reopening Loopcom on the machine
  you are at is what moves new work there. Three computers were linked to this one account.
- ⛔ It also found that an interrupted task **locked the screen for four hours** (`screen_busy` for
  every later task). An idle session now ends itself after three minutes and a new task may take over.

⛔ **The live run's score VARIES (13/17/17/18/18 of 20 across five runs) because the MODEL's choice
of road varies** — the same sentence sometimes gets the file tool and sometimes gets Explorer opened
first. The deterministic layers do not vary: ten consecutive runs of each suite, desktop 68/68 and
agent 41/41, zero failures. Every capability has passed at least once with independent evidence.
Tool SELECTION is guidance; policy, fences, approvals and verification are the mechanisms.

⛔ **Two other computers are signed into this account** and their apps restart often — each restart
makes that machine the one new work goes to, and the Coworker then honestly says it cannot control
the other computer. That is the rule working, not a fault.

## ⏳ NOT PROVEN

- **No human has pressed Allow** — a script answers the native prompt through UI Automation and the
  report says so. Ask the Coworker to open Notepad and type something, press Allow yourself.
- ~~The yield-to-the-person rule~~ is **PROVEN LIVE** (T16: the model drove the real cursor, a
  separate process moved the mouse, the next action came back `paused_by_person`). ⛔ A task driven
  by UI Automation never pauses and never should — it does not touch the cursor. That is the design.
- **Escape** pressed by a person; **elevated (UAC) PowerShell** approved by a person; **multi-monitor
  and DPI scaling** (one display on this machine); **no customer has any of this**.
