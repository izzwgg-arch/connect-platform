# ⛔⛔ THE COWORKER IS AN IDE-STYLE WORKSPACE NOW — live plain-English steps, it asks questions back, Stop, voice, any file, folders and git projects, and a full page with settings (2026-09-15, `7b26c388`) — READ BEFORE touching `apps/agent/src/coworker/`, the router's tool loop, `apps/portal/components/coworker/`, or the desktop's `uiBridge`/tool groups

Izzy, 2026-09-15, after approving the live mockup (https://claude.ai/artifact/9rkPBPFRp6hqQJcYCaSDXG):
*"Build it exactly like the mockups. Everything should be wired end-to-end, production-ready…
stress-tested."* Built in ONE commit, `7b26c388` on `feat/ivr-migration-takeover`.
Supersedes the mockup-only section `2026-09-15-coworker-ide-redesign-mockup.md`.

## What a person sees

- **The bubble** (`/desktop/coworker`) opens the workspace's compact form: suggestions, a composer
  with attach / microphone / access chip, and — while it works — a **steps block**: `Files ·
  Looking in your Downloads folder · Working…`, each step expandable to plain-English detail, with
  a live timer and "3 of 5 steps". **New task**, **Open full page** and **Minimize** in the header.
- **The full page** (`/coworker`, sidebar → Workspace → Coworker): task list + search on the left,
  the same conversation in the middle, and on the right **What it's doing** (the model's own plan),
  **Right now** (the folder/site/spreadsheet it has open), step/time/changed/asked counters,
  **Made or changed**, and **Stop everything**. Plus **Everything it did** and **Settings**.
- **It asks questions back**: an amber card with 2–4 option buttons and a typed answer; Skip is
  always there. **Voice**: press the mic, it transcribes and drops the text in the box (or sends it).
  **Files**: any type, drag-and-drop, up to 20 per message, read on the server. **Folders and code
  projects** attach from the computer. **Ask first ↔ Full access** switches in the composer.

## ⛔ The five rules this was built under, and why

1. **The chat page is the HOSTED portal, so it is never the security boundary.** The mockup's
   in-chat "Do it" approval was deliberately NOT built: a compromised server could draw a fake one.
   A waiting step says *"Look for the Loopcom approval box on your screen"* and the desktop's own
   approval window stays the only place a "yes" exists (`coworkerHands.test.ts` forbids any approve
   verb in the page).
2. **Raising access needs a NATIVE dialog.** `coworker-ui:set-access` shows a Windows dialog listing
   what still always asks; lowering never asks. The page cannot answer it. The NEVER_AUTO floor,
   the hard prohibitions and the shell denylist are untouched and are still not settings.
3. **A folder is attached only from the native picker or a REAL drop** (the path comes from
   `webUtils.getPathForFile` in the preload — a page-built File has no path). A drop outside the
   user profile asks natively; drive roots and Windows folders are refused. Attached folders become
   fs/git roots live.
4. **A question is escapable four ways** (answer, Skip, Stop, 10-minute timeout), max 3 per turn —
   the hold-music trap ([[a-clarifying-question-must-be-escapable]]) as code.
5. **No code on screen, ever.** `stepDescriber.ts` is the only place a tool becomes words, and its
   test refuses tool names, JSON, PowerShell scripts and typed values in a label.

## How it works (the parts a future change will trip over)

- **There is still no streaming.** A chat message is ONE long request (nginx `/agent-api/`
  `proxy_read_timeout 900s`); the page picks a random `turnId`, sends it with the message, and polls
  `POST /agent/coworker/activity {turnId, after}` ~every 700 ms. Events carry sequence numbers, so a
  duplicated, late or second-window read is free — the bubble and the full page can watch the same
  task. If the long request dies, the page keeps watching and fetches the stored reply when the turn
  reports done.
- **The steps come from the ROUTER**, not from each tool: `ToolLoopHooks` in `llm/router.ts` wrap
  the one `runTool` both provider loops share, so Claude and OpenAI behave identically, and
  `shouldStop` is checked before every model call and before every tool call.
- **`ask_person` blocks inside the turn** (the desktop link's approval-extension pattern), and the
  engine registers `hub.onStop → dyn.cancel` so Stop also stops what is running on the computer.
- **Attachments are read on the server** with no new dependency (`attachments/extractText.ts`:
  text/code, docx, pptx, xlsx, odt/ods/odp, rtf, html, and PDFs with a text layer including hex
  strings mapped through the font's ToUnicode table). A scan, an encrypted PDF or a binary says so
  in plain English instead of returning garbage. Text is remembered per task for 24 h.
- **Voice runs BOTH engines at once** (`transcribeForCoworker`): Yiddish Labs and OpenAI
  `gpt-4o-transcribe`; Yiddish keeps YL's text, English keeps OpenAI's, either failing leaves the
  other. ⛔ The widget's own `/agent/chat/transcribe` (Laybel voice mode) is untouched.
- **Settings live in two places on purpose.** What may run ON THE COMPUTER (Ask first/Full access,
  files, browser, spreadsheets, code projects, email) is desktop settings, enforced there. What the
  AGENT does (phone-system tools, reply length, "things it should always know", show steps, notify,
  keep history, send voice right away) is agent prefs — append-only `AgentAuditLog` rows, **no
  migration**. Never move one to the other side.
- **git runs as `git` with an argument array, never a shell**; `GIT_TERMINAL_PROMPT=0` so a push
  that needs a password fails in seconds instead of hanging; clone refuses `ext::`, `file://` and
  local paths; push is `alwaysRequireApproval` (it sends code off the computer).
- **Tool families** (`toolGroup()`): a family switched off is not announced AND is refused locally
  before any verdict. **Email is blocked unless switched on** (webmail host list).

## Deployed and proven

- **agent** ✅ rebuilt 2026-09-15 23:0xZ from `7b26c388` (`docker compose … up -d --build agent`),
  healthy, 0 restarts, 0 error lines; `ActivityHub`, `ask_person`, `show_plan`,
  `registerCoworkerUiRoutes`, `transcribeForCoworker`, `extractText`, `STOPPED_REPLY`,
  `coworkerWorkspacePrompt` all grepped INSIDE the container; all eight new routes answer 403
  without a token through nginx and an unknown route 404s.
- **portal** ✅ deployed (branch tip, which contains `7b26c388`), 0 restarts, `/coworker` and
  `/desktop/coworker` **200 on both hostnames**.
- **desktop** ✅ `Connect-Setup-0.1.17-rc.17.exe` built from a CLEAN export of `7b26c388`
  (102,559,366 bytes, sha256 `535ca1449b60ba5a495b10051ecccaf8bf7e60f3bd2fa70e0e2a45741bcd49e9`),
  icon check 7/7 frames, and the packed asar carries `uiBridge.js`, `runtime/git.js`, the
  `coworkerUi` preload bridge (with `webUtils`), 9 git tools and the switch/webmail enforcement.
  ⛔ **NOT installed on any machine and NOT published** (the fleet feed is untouched) — both are
  Izzy's call; installing closes the running app and the phone with it.
- **Tests:** agent 883/885 (the 2 are the documented pre-existing corpus/everett failures), desktop
  Coworker 67 green, portal 646/650 (2 documented pre-existing + the task-card string test that
  already failed at HEAD + another session's desk-phone test), shared 70/70; agent/desktop/portal
  typechecks clean (desktop proven in a CLEAN export containing only this commit).
- **Stress, local** (`apps/agent/scripts/coworkerWorkspaceStress.ts`, committed): 400 turns × 40
  steps = 48,800 events in 436 ms, reads 15 ms, heap 9→26 MB; 200 rounds proving a polled view
  (batched, duplicated, reversed, re-read) equals the whole-stream view; question races
  (double-answer refused, skip/stop/timeout each resolve once); sweep reclaims; 2,000 fuzz turns
  with no throw, nothing left "running" after done, no question surviving the end.
- **Stress, live** against the deployed agent (`/root/coworker-live-stress.sh`, synthetic identity,
  no customer data): 1,000 polls across 40 turns, p50 70 ms / p95 220 ms / max 394 ms; 20 concurrent
  settings saves; unauthenticated 403, bad turn id 400, unknown turn 404, malformed JSON 400,
  oversized answer 400; agent still healthy afterwards.

## ⛔ THREE DEFECTS THAT ONLY A REAL SCREEN FOUND — all three fixed and deployed

Every one of these passed the tests, the typechecks and the container greps. They were found by
typing one sentence into the live workspace in a browser.

1. **The composer kept the sent text until the whole task ended.** `send` only resolves when the
   turn is *finished* — minutes, with the hands — so the box still holding the message read as
   "it didn't send". It clears immediately now and only restores the text if the send is refused.
2. **The published knowledge document still described the card-era Coworker** ("press the button",
   "not possible yet"), six days after the hands shipped. Fixed in `361946ea`; the api publishes
   `docs/agent-knowledge/` at boot, so a knowledge edit needs an **api deploy**, not an agent one.
3. ⛔⛔ **And the sentence that survived both fixes was in a TOOL DESCRIPTION** (`90e8a5ca`).
   Asked "what can you help me with on this computer?" while the desktop app was reconnecting, the
   workspace answered with the 2026-09-02 card world verbatim — the three kinds, the three folders,
   "each task appears on screen and only runs after you press the button". The prompts were right.
   The knowledge row in the database was right (verified: new wording present, card-era wording
   gone). The stale text was the `description` of `coworker_task` / `my_computer_tasks`, **which a
   model reads whether or not it ever calls the tool**, and which only stepped aside when
   `handsOn` was true. The app was reconnecting, so `handsOn` was false and the model was handed
   the card world. They now step aside on **every** workspace turn; outside the workspace nothing
   changes, so the dock's `FloatingAssistant` card path is untouched.

4. ⛔⛔ **And fixing 3 exposed a fourth: the full page could never touch the computer at all.**
   With the card wording gone, the honest answer underneath it read "right now the app isn't
   connected" — while the same screen's pill said **"On this computer: connected"**. The hands were
   gated on `viewingPath.startsWith("/desktop/coworker")`, so only the desktop BUBBLE ever got
   them; `/coworker` — the full page, the one surface where folders and git projects are attached —
   was locked out of the feature those attachments exist for. Now gated on `isCoworkerPath`, so
   every Coworker surface gets the hands (`90e8a5ca`+).
   ⛔ **This widened no security property, and the reason matters:** `viewingPath` is
   CLIENT-SUPPLIED, so any caller could always have claimed the bubble's path — it was never a
   boundary. The boundary is unchanged: the desktop's own policy core re-validates every call and
   approvals are answered in the desktop's **native window**, never on the hosted page; the hands
   stay keyed to `{tenantId, clientUserId}`, so a person only ever reaches their own computer.
   A source guard now forbids the bubble-only test from coming back.

⛔ **The lesson is wider than "update the knowledge doc": a capability the model reads about
anywhere is a capability it will describe.** Prompts, per-turn blocks, the knowledge document AND
every tool description are all places the model learns what it is. A guard test now replays red
against the previous condition. See [[a-capability-the-prompt-denies-is-not-a-capability]].

## ✅ A REAL TASK RAN ON A REAL COMPUTER — the gap this file used to lead with is closed

Asked on `/coworker` in a browser: *"Tell me this computer's Windows version and how much free disk
space is on C:."* It ran end to end, with the hands, from the full page:

- Two live plain-English steps — **This computer** "Checking this computer" (6s), **Command**
  "Running a command on this computer" (2s) — header **Done · 2 of 2 steps · 28s**.
- RIGHT NOW showed the computer with both steps ticked; THIS TASK counted **Steps done 2 ·
  Time 28s · Things changed None · Asked you 0 times**; MADE OR CHANGED stayed empty, which is
  correct for a read-only job.
- The answer carried real values off that machine: `Microsoft Windows Server 2025 Datacenter
  10.0.26100 (Build 26100)`, `320.22 GB free of 399.68 GB (80.1% free)`.
- No tool name, no command, no JSON appeared anywhere on screen.

⛔ Note which machine that is: the linked desktop is the **dev box**, not Izzy's own Windows 11
laptop — his machine still runs the pre-rc.17 app. So this proves the workspace → hands → computer
path completely, and does NOT prove rc.17's own new pieces (voice, drag-and-drop, folder/git
attach, the access dialog), which ship in the installer nobody has run yet.

## ⏳ NOT PROVEN — the honest list

- **No task that CHANGES anything has run, so no approval has ever been answered.** The proven task
  was read-only and needed no approval. Acceptance: ask "organize my Downloads folder" → the plan
  appears, the approval box appears **in the desktop's own window** (SAFE), pressing Yes lets the
  steps finish green, and MADE OR CHANGED lists the moves.
- **Voice, drag-and-drop, folder attach and the access dialog have not been used by a person**, and
  they cannot be until rc.17 is installed — they are the parts that live in the desktop app.
- **The desktop rc.17 is built but NOT installed and NOT published.** Izzy's own machine runs the
  older app; installing closes the running app and the phone with it, so it is his call.
- The full page needs `can_view_workspace_coworker` granted to anyone who should see it (it is in
  no default bucket) — nobody but Izzy has it.

Full detail lives in this file; there is no separate `AGENT_HANDOFF_*` for it.
