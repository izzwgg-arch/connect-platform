# ⛔ AGENT HANDOFF — the Coworker BUBBLE's chat popover no longer CLOSES ITSELF when the hands ask for approval or open a folder; the approval prompt lands BESIDE the chat (on its monitor), focus comes back to the chat afterwards, and the bubble's badge is finally driven (amber = working, red = finished while hidden) (2026-09-09) — READ FIRST before touching the chat window's `blur` handler, `askApproval`'s placement, `setWidgetBadge`, or for "the Coworker chat disappeared while it was working"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(Ezra, 2026-09-09: *"Check co worker bubble, look for things to fix."* Desktop-only change, no API/agent/portal deploy.
**Commit:** see `git log -1 -- apps/desktop/src/coworkerWidget/widgetWindow.ts`. Read with the section below
(the hands, `336ad19f`) and `docs/ai-context/AGENT_HANDOFF_COWORKER_BUBBLE_DEAD_2026-09-02.md` §2a/§6.)

- ⛔⛔ **THE DEFECT: the chat popover hides on `blur` (it is a popover by design, §2a of the 09-02 handoff), and
  the approval window is `alwaysOnTop` + `focus()` — so in SAFE mode (the customer default) the FIRST write the
  hands attempt raised the approval prompt, the chat lost focus and HID, and the person answered a question
  about a conversation they could no longer see.** The same happened whenever a tool took focus
  (`computer_open_path` opening Explorer). It was invisible on this box because Ezra's profile is AUTONOMOUS
  (nothing asks) and the acceptance harness never opens the popover.
  Fix in `widgetWindow.ts`: `WidgetDeps.holdChatOpen` (main: `hands?.busy()` = an approval pending OR a
  runtime call in flight) — while true the `blur` handler logs `chat kept open on blur (hands busy)` and
  does nothing. Ordinary blur still hides; a bubble click while it shows still closes it (`chatIsShowing()`
  branch of `toggleChatPanel`).
- ⛔ **The approval window went to the PRIMARY display's bottom-right corner — on top of the chat it was asking
  about (the bubble's home is that corner) and on the wrong screen when the bubble lived on a second monitor.**
  `approvalWindow.ts` now takes `anchor()` (main → `chatPanelBounds()`) and places the prompt with the pure,
  tested `approvalPositionFor()`: LEFT of the chat, bottom-aligned, 12px gap; right when no room; centred
  over it when neither; clamped to the work area of `screen.getDisplayMatching(chat)`. No chat showing →
  the old corner. `onSettled` → main `restoreChatPanel()` re-focuses the chat if it is still showing (never
  re-shows a hidden one). Log line: `approval: shown for <tool> (<id>) at x,y beside the chat`.
- ✅ **The badge is wired now (§6 "wired to nothing" is closed):** `RuntimeDeps.onActivity(n)` fires on every
  call start/finish/cancel → `hands` → main `coworkerActivity()`: `n>0` → `working` (amber pulse); `n→0`
  debounced 1.5 s → `unread` (red) if the chat is hidden, else `none`; opening the chat (first show and
  re-show) clears it. ⛔ The debounce is deliberate — one turn is a chain of 2-second calls and the dot would
  flip red/amber between them. "Unread" means "the hands finished something while you were not looking";
  the assistant's text reply itself is not signalled (that would need the portal page to call the bridge —
  a portal change, not done).
- ⛔⛔ **SECOND DEFECT, found from Ezra’s screenshot the same hour (“Why does it always pop up?”): the AGENT gave up on a call
  after the tool’s own timeout (60 s for a delete, 10–30 s for other file tools) while the person was still reading
  the approval prompt.** The model was told `desktop_timeout`, asked again, a SECOND prompt appeared (journal
  18:18:52 `asked`, 18:19:57 `asked` again, same task), and the first answer “arrived late (not accepted)”. For a
  SAFE customer that is a new prompt every 10–60 s until they answer inside the window. Fix: the desktop now POSTs
  `/agent-api/coworker/progress {callId, state:"awaiting_approval"}` right before it shows the prompt
  (`RuntimeDeps.onAwaitingApproval` → `DesktopLinkClient.progress()`), and the agent’s `DesktopLink.extend()` pushes
  that call’s deadline out by `APPROVAL_WAIT_MS` (5 min + 30 s, the prompt’s own lifetime) — once, bounded, and an
  unanswered prompt still expires. Agent tests 12/12 (extend + the `/progress` route: 200/extended, unknown id →
  false, bad state → 400, no JWT → 403); desktop 73/73. ⛔ The agent container must be rebuilt for this
  (see the deploy bullet); an old desktop against the new agent simply never posts progress (old behaviour), a new
  desktop against an old agent logs `link: progress … → 404` and the prompt still shows.
- ✅ **DEPLOYED + container-verified 2026-09-09 19:10Z (by session connect2-ef, folded into its rc.10 run):** `app-agent-1`
  started 19:09:48Z from an image built 19:09:34Z at `bab5323d`; the container runs the TS source and
  `/app/apps/agent/src/coworker/desktopLink.ts` inside it carries `APPROVAL_WAIT_MS` + `extend()`; through nginx
  `POST /agent-api/coworker/progress` → 403 without a token while an unknown route → 404 (the route is live);
  0 restarts. The installed rc.10 asar carries the desktop half. Its packaged acceptance suite then read 58/58.
- `hands.ts` header comment lied ("the link runs only … the Coworker is enabled (the bubble setting …)") —
  the link runs whenever the app is signed in, bubble or not. Comment fixed; behaviour unchanged.
- ✅ **Proven:** desktop typecheck 0; `src/coworkerWidget/*.test.ts` + `src/coworker/*.test.ts` **72/72**
  (new: `approvalWindow.test.ts` 6 placement cases; `coworkerHands.test.ts` "activity 1 → 0 around every
  call, 1 while the approval is pending, a throwing listener never breaks the call"; two source guards in
  `widgetWindow.test.ts` for the hold-on-blur wiring and the badge wiring). ⏳ **NOT PROVEN on a screen:**
  needs a SAFE-profile turn through the popover — the prompt must appear LEFT of the chat, the chat must stay
  visible, Enter must return focus to the chat, and with the chat hidden the dot must go amber then red.
  ⛔ Do NOT run that on this box while another session's dev `electron .` and acceptance harness are up
  (they were, 2026-09-09 17:46Z→): the dev app holds the single-instance lock and the harness's results
  would be confused by a second driver. It rides the next desktop build (rc.10 is the other session's).
- ⛔ Traps this session hit: the takeover tree is MIXED — `widgetWindow.ts`, `main.ts`, `CLAUDE.md` are CRLF,
  `hands.ts`/`approvalWindow.ts`/`runtime/index.ts` LF; git-bash `grep $'\r'` LIES (text mode) — check from
  node. Exact-anchor patch scripts must normalise (memory `takeover-worktree-crlf-patching`). A bash heredoc
  carrying a JS file with backticks fails to parse in this harness — write scripts with the Write tool.
