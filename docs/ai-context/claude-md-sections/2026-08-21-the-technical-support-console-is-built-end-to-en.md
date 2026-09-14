# ⛔⛔ AGENT HANDOFF — the Technical Support Console is BUILT END TO END: escalation CHATS, cross-company inbox, human take-over, the Ground Rules rulebook, the Watchman, and a full IDE with a guarded server terminal (2026-08-21) — READ FIRST before touching /admin/support, `apps/api/src/support*.ts`, `workbenchIde.css`, or before letting anything run a command on the server

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


**BUILD STATE (2026-08-21, `0ba63443` — full detail handoff §4–§11):**
✅ **api + portal DEPLOYED and container-verified; agent REBUILT.** Five views on
`/admin/support`: **Escalations (as chats)**, **Inbox** (cross-company SMS),
**Conversations** (assistant chats + human take-over), **Rules** (the Ground
Rules rulebook + Watchman), **Workbench** (the IDE). SUPER_ADMIN only, Izzy's
call: every handler takes an injected `requireSuper`, `/admin/support` rides
`can_manage_global_settings` in `PORTAL_API_PERMISSION_RULES`, nav forced in
`isNavItemVisibleForUser` — ⛔ deliberately NO new grantable key until a feature
honours it. Support-agent accounts + per-feature keys are Izzy's to create.
- ⛔⛔ **ESCALATIONS ARE CHATS, NOT A TICKET LIST** (Izzy said it several times
  before it landed). The escalation IS the conversation: the list is people, the
  middle is their thread, the agent's ISSUE/FINDINGS/PROPOSED FIX report is a
  card **inside** it, the customer panel is on the right. **The old
  report-list view is DELETED, not dead-coded** — `page.tsx` is a lean shell
  holding no screen logic, so a change to one view cannot break another.
- ⛔ **"Approve the fix" posts the DRAFT action id to the EXISTING
  `/admin/agent-confirmations/:id/apply` password gate — never add a second
  apply path** (a source test pins it), and ⛔ `fixCodeHash` never leaves the
  server (tested; responses are built field-by-field, never `...row`).
- ⛔ **Take-over runs BEFORE the Yiddish input leg in `engine.ts`** — a
  taken-over conversation must not spend Yiddish Labs credits translating for
  a model that will not answer.

**⛔⛔ THE THREE SAFETY LAYERS — they are CODE, not prompt text, and the order is
the safety property.**
1. **`supportGroundRules.ts` — the rulebook Izzy writes, enforced by a matcher.**
   `classifyAction()` is **NEVER > ASK > ALLOWED**, and ⛔ **no match ⇒ ASK,
   never ALLOW.** Matching is **verb-aware** (`VERB_FAMILIES`: read/write/delete/
   restart/deploy/send/run/touch) so *"Read the PBX"* can be allowed while
   *"Write to the PBX"* is never — a plain substring matcher refused *"delete the
   old deploy logs"* because the word "deploy" appeared, and a subject-only rule
   containing "customer" refused half of all support work. Rules are
   **append-only versions** (migration `20260820234500_support_ground_rules`).
2. **`supportWatchman.ts` — three standing checks** (MD rule files / server /
   PBX read-only), re-read before every job. ⛔ **A throwing probe becomes
   "unknown", and unknown BLOCKS work** — a health check that fails open is
   decoration. Unreachable-but-read-only PBX is a warning; **not read-only is a
   stop-everything**. ⛔ The PBX probe proves read-only with
   `SELECT CURRENT_USER()`, **never by attempting a write**.
3. **`supportWorkbench.ts` — the IDE's hands.** Gate order
   **WATCHMAN → SHAPE+ALLOWLIST → SECRETS → RULEBOOK**. `ALLOWED_BINARIES` is a
   read-only allowlist with `FORBIDDEN_SUBCOMMANDS` (no `git push/commit/reset`,
   no `docker rm/exec/restart/compose`, no `systemctl start/stop`, no `sed -i`,
   no `find -delete/-exec`), no shell metacharacters, and a secret-path regex
   (`.env`, `.ssh`, `id_rsa`, `*.pem`, `credentials.json`, `authorized_keys`,
   `.connect-ssh`). ⛔ **The asymmetry is deliberate and documented in the file:
   an UNMATCHED command proceeds** (the allowlist already proved it read-only;
   prompting for `ls` teaches people to click through), but a matched **ask-first**
   rule stops it and a **never** rule refuses even when confirmed.
⛔⛔ **AND DRIVING IT LIVE CAUGHT THE OPPOSITE FAILURE — IT REFUSED ORDINARY
WORK.** `wc -l apps/api/src/supportWorkbench.ts` came back **NEVER**, and
*"restart the api container"* matched **"Passwords, card details or API keys"**
instead of its own ask-first line, because that rule contributed the bare token
`api` — a substring of every path under `apps/api`. **79 unit tests were green
through it.** ✅ Fixed (`00a5c8a0`): **a rule LINE is a LIST**, split on
`, ; / or and`, and a match needs **every word of ONE item** (so "API keys" is
one phrase); a verb stated anywhere on the line still governs every item on it;
singularisation drops to **>3 chars** so a rule about "logs" matches an action
about a "log" while `sms`/`did`/`dns` survive intact.
⛔ **The rule: an over-broad safety layer is the one that gets ignored** — a
refusal a support person knows is wrong teaches them the rulebook is noise, and
the next refusal, the real one, gets clicked through. **Judge a guard by what it
LETS THROUGH as well as what it stops, and drive it on real inputs** — unit
tests written by the matcher's own author share its blind spot.

✅ **Proven on production, not by unit test:** `rm -rf /` refused
`command_not_allowed`; `git push` refused `subcommand_not_allowed`;
`cat .env` refused `secret_path`; `ls; whoami` refused `shell_metacharacter`;
a `docker restart` phrased in English classified **ask-first**.

**⛔ THE IDE, and the process lesson that outranks it.** Izzy: *"What is the
point of making mockups if you never make it look like the mockups?"* He was
right — the first build had the mockups' structure and generic portal styling,
and my status reports claimed "matches the mockups" **without ever putting them
side by side.** Two rules now: **port the mockup, do not re-derive it**
(`workbenchIde.css` carries the mockup's own values verbatim;
`SupportWorkbench.tsx` is the mockup's markup wired to real data), and ⛔ **never
claim a screen matches a mockup without publishing the comparison** — desk
<https://claude.ai/code/artifact/90e6e2f7-fabc-466c-8555-47e3e6830b05>, IDE
<https://claude.ai/code/artifact/20aeef9d-c32d-4b6c-a9ba-59fb99c7e48b>, each
rendering the BUILT screen with the real shipped stylesheet beside the drawing.
Approved mockup: <https://claude.ai/code/artifact/cf13e7b7-ebbf-414e-a1a6-f22dee7a2eaa>.
The IDE has the menu bar, activity bar with a git-change badge, explorer with
git letters, editor tabs, breadcrumbs, a local syntax highlighter (⛔ **no new
dependency** — a tokeniser inside the component), minimap, Terminal/Problems/
Output panel, the SSH pill, the guarded terminal, a status bar and a ⌘K palette.
The agent dock talks to the real assistant; the model switcher writes the real
`chat_model` (Opus 5 / Sonnet 5 / **Fable 5** / GPT-5 — Fable via
`KNOWN_ANTHROPIC_CHAT_MODELS` in `llm/router.ts`).
⛔ **`workbenchIde.css` is the ONE place in the portal with its own palette, and
its header says why** — an IDE is its own visual world (VS Code inside a light
app is still dark), so the values are FIXED, never `prefers-color-scheme`, and
scoped under `.ide-root` so nothing leaks. That is a deliberate exception to
[[billing-must-use-connect-theme-tokens]], not a violation of it.
⛔ **A class collision cost an afternoon:** the terminal container and a stdout
LINE both resolved to `.sd-wb-out`, so every output line inherited the
container's padding and background. **Audit class names across a ported
stylesheet before wiring it.**
⛔⛔ **AND A PORTED COMPONENT NEEDS ITS FRAME TOO — the screen shipped
"gigantic".** `.ide-root` had **no height**: in the mockup it sat in a
fixed-height frame, and porting the component's CSS without that frame left
every `flex:1`/`min-height:0` inside resolving against **content** height — the
tree drew all 222 entries, the editor the whole file, nothing scrolled in its
own pane, and the chat composer ended up at the bottom of a page thousands of
pixels tall. ⛔ **It reads as a zoom problem and is not one** (the type scale is
12px and correct) — **when a screen "looks zoomed", check for something
UNBOUNDED before touching a font size.** Fixed `5e952aa3` with
`height: calc(100vh - 214px)` — ⛔ **`height`, not `max-height`**: only a
definite height makes the panes scroll instead of stretch — the same cap the
sibling views already used, plus `.ide-body > * { min-height: 0 }`. Guarded by
`supportWorkbenchLayout.test.ts`; **all 4 assertions fail against the shipped
stylesheet**, which is the only test shape that can see a MISSING rule.

**⛔⛔ WHAT DRIVING IT LIVE FOUND — AND THE MOUNT I REFUSED.** The api container
has **no `git` binary and no `.git`** (the image COPIES source; it is not a
clone), so the branch and the explorer's M/U letters came back silently empty
and the palette offered git actions that answer "git: not found".
⛔ **Deliberately NOT fixed by mounting `/opt/connectcomms/app` into the
container: that clone holds live `.env` files, and trading real credential
exposure — guarded only by a filename regex — for cosmetic git chrome is the
wrong bargain.** A deployed container's uncommitted-change letters would be
empty anyway (deploys hard-reset). ✅ Fixed by **reporting the truth**:
capabilities returns `permittedBinaries` (the policy) AND `allowedBinaries`
(what is really on PATH), plus `deployedCommit` read from `.build-commit`; the
status bar shows the running commit when there is no repo and never invents a
branch; the palette and terminal hide what this container cannot run.
⛔ **The general rule: offer only what the box can actually do** — a control that
answers "not found" teaches people to distrust the tool.

✅ **THE ANSWER CAN BE PLAYED OUT LOUD (`d401645b`, ElevenLabs · Kristen)** —
a ▶ on every agent reply in the dock; `POST /admin/support/speak` returns mp3.
⛔⛔ **`synthesiseNarration` is a SIBLING of `synthesiseSpeech`, never a flag on
it** — that one feeds Asterisk and asks for **`pcm_8000`**, and every decision in
it is wrong for a laptop; a branch there puts the LIVE IVR greeting path one edit
from a narration change. No format fallback ladder here on purpose.
⛔⛔ **BILLED PER CHARACTER, so the cost controls ARE the feature**
(`supportNarration.ts`, pure + tested): fenced code is **dropped, not read**
(including an **unterminated** fence from a streamed answer); a **code-only
answer costs nothing**; links are read as their label, never the URL; capped at
3,000 chars **cut on a sentence boundary** with the client told; a **replay is
cached**; concurrency gate of 2; and **exactly ONE POST, never retried** — a
retry bills the same words twice (source guard counts the call sites).
⛔ **It stores NOTHING** — no catalog row, no PBX push, nothing on disk.
⛔ **The voice id was READ OFF THE ACCOUNT, not guessed:**
`CvD6hF1BJzAFN428j1cO` = *Kristen — Warm, Corporate and Steady*; the other
Kristen (`dfeOmy6Uay63tNhyO99j`) is the upbeat advertisement read. A test pins
it — a wrong voice id fails at the provider with an unhelpful 400.
⛔ Browser side re-earns the three media traps: rebuild the Blob with an explicit
**`audio/mpeg`**, **CSP `media-src blob:`** is what makes it play at all, and
**`play()` can reject** — surface the reason, never a silent no-op. Use the new
**`apiPostBlob`**, never a bare `fetch` (a bare fetch skips the global 401
handler and a signed-out tab retries itself into the nginx auto-ban).

⏳ **NOT PROVEN: nobody has opened any of these screens in a browser.** Proven
by 51 api tests, portal typecheck 0, the shipped-bundle string greps
(`ide-root`, `ide-menubar`, `ide-minimap`, `ide-sshpill`, `ide-palette`,
"Ask anything, in plain English", "Claude Fable 5"), and live SUPER_ADMIN
probes of every route on production.
⏳ **Deliberately NOT built:** the agent DRIVING the workbench (tools
`read_file` / `list_files` / `run_command` at `minRole: "staff"` calling these
doors exactly as `investigate` does — the agentic loop and both API keys already
exist, so ⛔ **no `claude-agent-sdk` dependency and no new key are needed**, a
correction to my own earlier advice); the inline accept/reject diff the mockup
draws; per-task model picking (only the chat model is switchable); a real
interactive SSH PTY (the terminal is the guarded read-only runner, and the SSH
pill reflects that the box IS loopcom, not a shell).

Full handoff + the verified infrastructure inventory:
**`docs/ai-context/AGENT_HANDOFF_SUPPORT_CONSOLE_MOCKUPS_2026-08-20.md`**
(⛔ **The sections below are the ORIGINAL mockups-only handoff and are kept for the
decision history — the BUILD STATE above supersedes every "not built" claim in them.**
Izzy, 2026-08-20: *"I want to
see mock-ups before you build anything."* Mockups he is choosing from:
<https://claude.ai/code/artifact/042ff488-ae78-4e7f-b4cf-6ca8194b671a> — A "The Desk"
escalation-first, B "Mission Control" unified inbox + take-over, C "The Workbench" IDE.)

- ⛔ **(HISTORICAL — this said "NOTHING IS APPROVED OR BUILT"; it is all built now.)** Decisions state (§3 of the handoff): still open —
  direction (A/B/C) and **who counts as support staff** (today `isPlatformStaff` =
  SUPER_ADMIN and exactly ONE account holds it — a support team needs a new
  platform-support role) and wiring `claude-fable-5` into the router (it appears nowhere
  in the repo today). **ANSWERED 2026-08-20: the IDE is the FULL real thing and the agent
  runs maintenance right off the server** (Izzy, in-chat) — the "C+" full-size IDE mockup
  is in the artifact, and its guardrails ARE the contract: plan shown before running,
  deletes/restarts/deploys pause for a human click, code ships only via the deploy queue,
  everything audited, **PBX read-only from this screen**. **ALSO ANSWERED same day:
  the terminal is the FULL SSH SANDBOX wired in** — a real root SSH session on loopcom
  shared live by the support person and the agent, every session recorded. ⛔ No
  product-side terminal exists today (the "existing sandbox" is the AI-session access:
  keys + canonical method) — wiring it is a real build (portal terminal + PTY bridge +
  staff gate + recording). ⛔ The PBX key stays OUT of it — read-only house rule.
- ✅ **MORE CALLS, later 2026-08-20 (all in the handoff §3, all mockups-only):**
  interaction = **plain English only, agent codes VISIBLY "like a movie"** (the artifact
  now carries a looping animation of it — build implication: agent work streams as
  events, never finished results); **every console feature gets its own permission key,
  set per support agent** via the existing custom-roles machinery (`can_use_ssh_terminal`
  defaults OFF for everyone; approve-fixes always also wants the password); a **Ground
  Rules rulebook** (allowed / never / ask-first, Izzy-written, versioned — enforced by
  HARD GATES as well as prompt text, never prose alone); a **Watchman** (re-reads MD rule
  files before every job, watches server health + the PBX read-only, stops and reports
  on anything off). **Engine recommendation given: the Claude Agent SDK** — the Claude
  Code engine embedded in Connect, streaming edits/commands into our screens; ⛔ no
  drop-in Anthropic IDE widget exists, the screens are ours. ✅ **ENGINE DECIDED same
  day** — Izzy: *"the SDK is already inside Loopcom, so just wire that into our IDE UI
  and keep it like cursor style."* ⛔ Premise verified + corrected: `apps/agent` carries
  only `@anthropic-ai/sdk` ^0.60.0 (plain API client — key + billing already wired);
  `claude-agent-sdk` appears NOWHERE — a NEW dependency in a new small service, same
  key. UI style: Cursor-like (editor center, agent chat docked right, inline diffs).
- ✅ **The inventory is done — don't re-derive it.** Escalation reports are FULLY STORED
  (`AgentEscalation.report`, already ISSUE/FINDINGS/PROPOSED FIX/APPROVAL) with **zero
  read routes and zero screens** — the biggest quick win. Fix machinery, task runners
  (diag / approvals / deploy queue), `investigate`, the chat-model picker and the
  pbx-console admin-page pattern all EXIST to reuse. **MISSING outright:** human takeover
  of assistant conversations, a cross-tenant chat list, any IDE/editor/terminal.
- ⛔ **Noticed in passing, unfixed:** `POST /agent/actions/decide`
  (`apps/agent/src/actions/routes.ts:22`) still admits every TENANT_ADMIN
  (`role === "owner"`) while its sibling approvals GET is staff-only — a tenant admin
  can approve/deny any action id they learn. Same class as the 2026-08-19 findings.
