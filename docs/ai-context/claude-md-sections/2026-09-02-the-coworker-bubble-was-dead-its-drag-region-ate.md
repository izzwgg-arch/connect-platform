# ⛔⛔ AGENT HANDOFF — the Coworker BUBBLE was DEAD: its drag region ate every click, its chat was the OWNER CONSOLE, and any new desktop window kind ran a SECOND SIP PHONE (2026-09-02) — READ FIRST before touching `apps/desktop/src/coworkerWidget/`, `coworkerWidget.html`, before adding ANY `DesktopWindowKind`, or before making anything in Electron both draggable and clickable

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


- ✅✅ **SUPERSEDED FOR THE HANDS (same day, later): the hands ARE built now — see the
  section at the top of this file and handoff §10.** Every "the hands are NOT built" /
  "cannot act on the computer" line below this point is the morning's history.

Full handoff: **`docs/ai-context/AGENT_HANDOFF_COWORKER_BUBBLE_DEAD_2026-09-02.md`**
(`3a52c370` on `feat/ivr-migration-takeover`. ✅ **portal DEPLOYED and container-verified 2026-09-02**: `app-portal-1`
`.build-commit` = `3a52c370`, 0 restarts, `.next/server/app/desktop/coworker` present,
`fa-docked` + `coworker-chat` in the shipped chunks, `/desktop/coworker` **200 on both
hostnames**.
Desktop: **`Connect-Setup-0.1.17-rc.2.exe` INSTALLED ON IZZY'S WORKSTATION 2026-09-02
11:45Z at his request** (`/S`, exit 0; registry + exe read `0.1.17-rc.2`; it closed the app
and it was restarted by hand) — ⛔ **NOT published, feed still 0.1.16**.) Memory:
[[app-region-drag-swallows-clicks]], [[desktop-window-kinds-run-a-sip-phone-by-default]].
Izzy, 2026-09-02: *"The widget is dead. It doesn't do anything. Plus, it doesn't
have the real Loopcom logo. For the co-workers."*

- ⛔⛔ **THE CAUSE, and it was on his machine before any code was read: the bubble
  had been DRAGGED (settings held a saved position) but its log had ZERO coworker
  lines.** The bubble was an `-webkit-app-region: drag` handle with a mousedown/
  mouseup click detector ON THAT SAME ELEMENT. On Windows a drag region is the window
  CAPTION — the renderer never receives the press — so dragging worked and clicking
  reached nothing. **Not fixable in the renderer.** The drag is now driven by MAIN:
  the renderer reports press/release only (no coordinates), main reads
  `screen.getCursorScreenPoint()` on a 16 ms timer (⛔ a timer, not renderer
  `pointermove` — a window moving under the pointer sees few move events), clamps to
  the display under the cursor so it crosses monitors, and `isClick` decides on
  release. A click while the chat is open CLOSES it (`BLUR_CLICK_GRACE_MS` — the
  blur-hide fires before the release). Both coworker windows now log their console.
- ⛔⛔ **THE CLICK WOULD HAVE OPENED `/assistant` — the SUPER_ADMIN OWNER CONSOLE
  inside the full sidebar shell — in a 400px popover.** `CHAT_ROUTE` is
  **`/desktop/coworker`** now: a new portal page docking the SAME `FloatingAssistant`
  every page carries (`docked` prop: starts open, no corner bubble, fills the window,
  Minimize hides the window via `window.coworkerWidget.closeChat()`). Under `/desktop/`
  the portal treats it as a PASSIVE window (AuthGate waits for the token, no /login
  redirect). ⛔ `?widget=1` was read by nothing.
- ⛔⛔ **AND `isDesktopProxyWindow()` WAS `windowKind === "mini"` — EVERY OTHER
  DESKTOP WINDOW KIND RAN A FULL SIP ENGINE.** The chat popover would have registered
  a SECOND PHONE on the same extension and rung inside a chat window. It now lists
  `"mini" || "coworker-chat"`; `DesktopWindowKind` carries `coworker-widget` +
  `coworker-chat` on both sides. ⛔ **Any new window kind that loads the portal must
  be added to that check in the same commit** (source-guarded), and proven live with
  `pjsip show endpoint T<t>_<ext>_1` not growing a contact.
- ✅ **THE LOGO IS THE REAL ONE**: the Blue 2B tile (the app icon's own artwork) cut
  to a 128px circle and embedded as a data URI by
  `scripts/desktop-coworker-bubble-asset.py` (`--check` pins it to the brand kit).
  The hand-drawn SVG glyph is gone and a guard fails if `<svg` returns. Rendered in
  headless Chrome and LOOKED AT: round, transparent corners, the white infinity band.
- ✅ **Proven:** desktop 160/160 (13 new, **ALL 13 fail replayed against HEAD** —
  the html guards strip HTML *and* JS comments, because the file quotes the rule it
  forbids), typecheck 0; portal 487/489 (the 2 documented pre-existing), typecheck 0,
  4 of 5 new guards fail against HEAD; asar of the built exe carries the data-URI
  html, `desktop/coworker`, `getCursorScreenPoint` and the drag verbs.
- ✅✅ **PROVEN ON THE REAL SCREEN 2026-09-02 11:45Z**: the log reads `bubble shown at
  2639,857` → `chat panel opened` 17 s later (a real press) → the coworker-chat window
  loaded the portal → three `bubble click closed the chat` lines. Re-shows of an
  existing chat window were SILENT in that build (`9237f53e` adds `chat panel shown
  again`, rides the next build) — so a log of one open + N closes is the toggle
  WORKING, not failing. ⏳ Still unproven: the no-second-registration negative —
  his SUPER_ADMIN login has no extension, so it cannot register at all; check it on a
  tenant login with `pjsip show endpoint T<t>_<ext>_1`. Acceptance is §5 of the handoff: install rc.2 (`/S` closes the app and does
  NOT relaunch it — phone down until started by hand), see the round logo, drag it
  across monitors, **click → the assistant panel opens, not a sidebar**, click again
  → closes; the negative that matters: the endpoint's contact list must NOT grow.
  ⛔ The bubble stays opt-in (tray); Izzy's is ON. The badge is wired to nothing yet.
- ⛔⛔ **THE FIRST QUESTION THROUGH THE BUBBLE WAS "Can you organize files on my
  computer?" AND THE ANSWER IS STILL NO (2026-09-02, `a6fc0dbc`).** The Coworker has NO
  desktop hands: nothing can open/organize/change files, run programs or change settings
  on the customer's PC — the 08-31 handoff §8 lists it as unbuilt, and the approval /
  permissions screens that would gate it are still mockups. What shipped is AWARENESS,
  not ability: `engine.ts` `COWORKER_CHAT_PATH` — when `viewingPath` starts with
  `/desktop/coworker` the viewing block says "you are talking through the Loopcom
  Coworker on their Windows computer", what that window can do (this chat) and cannot
  (files/programs/settings); BOTH prompts carry a THE LOOPCOM COWORKER paragraph (exists,
  how to switch it on, never claim a computer task was done, customers: pass the exact
  request to the Connect team — phrased so `ESCALATION_RE` catches it and texts Izzy);
  `docs/agent-knowledge/system.md` has a customer section + a staff-only note ("a
  feature request to record, not a fault to investigate"). ⛔ **The api image BAKES
  `docs/agent-knowledge/`, and a knowledge-only edit was `skip=unrelated_paths`** —
  `deploy-common.sh` now lists it for api (takes effect from the NEXT deploy after this
  one). ⛔ **The server's `origin` is `/root/connect-mirror.git`, a LOCAL mirror the
  clone cannot refresh from GitHub itself (https, no credentials)** — a push to GitHub is
  invisible to `deploy-direct.sh` until the mirror is refreshed; `skip=no_changes` seconds
  after a push IS that. Recipe: `git bundle create x.bundle <old>..<branch>` → scp →
  `git fetch /root/x.bundle <branch> && git push origin FETCH_HEAD:refs/heads/<branch>`.
  ✅ **DEPLOYED AND VERIFIED 2026-09-02 12:10Z**: api `app-api-1` at `a6fc0dbc` (0 restarts,
  health 200 both hostnames) and the published `AgentKnowledgeDoc` system row updated
  12:10:21Z carrying the Coworker section + the staff note; **agent REBUILT** (manual
  compose, container healthy, 0 restarts, 0 error lines, both prompt paragraphs +
  `COWORKER_CHAT_PATH` grepped inside it). ⏳ NOT PROVEN: nobody has asked the rebuilt
  assistant through the bubble yet — acceptance is one more "can you organize my files?"
  in the bubble: it must name the Coworker, say it cannot do that on the computer yet, and
  the reply must land as an escalation text (the `pass … to the Connect team` phrasing).
  ⏳ **What "run a task on my computer through the Coworker" needs, and it is Izzy's
  decision, not a build to start quietly:** (1) approve the approval + permissions
  screens (mockups: <https://claude.ai/code/artifact/4f37d49b-0c9b-4bde-a990-a6063a1df0d6>);
  (2) a `coworker_task` tool the agent gets ONLY inside the bubble window; (3) a desktop
  executor with a fixed task allowlist gated by `packages/shared/src/coworker/policy.ts`
  (`decideToolCall`, NEVER_AUTO_DOMAINS, call protection) and an approval card in the
  popover; (4) verified results back to the agent. ⛔ A separate session was mid-build
  on `apps/*/src/remoteDesktop/` + migration `20260902120000_remote_desktop` at the time
  — check whether that IS the hands before designing them twice.
