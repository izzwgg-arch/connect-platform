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

## ⏳ NOT PROVEN — the honest list

- **Nobody has typed a task into the rebuilt bubble and watched the steps run.** Everything above is
  tests, container greps, and load — not one real turn with the hands on a real computer.
  Acceptance: install rc.17, open the bubble, ask "organize my Downloads folder" → the plan appears,
  steps run, the approval box appears (SAFE), the steps end green and the reply is plain English.
- Voice, drag-and-drop, folder attach, the access dialog and the full page have not been used by a
  person. The full page needs `can_view_workspace_coworker` granted (it is in no default bucket).
- The desktop rc.17 is not installed and not published.

Full detail lives in this file; there is no separate `AGENT_HANDOFF_*` for it.
