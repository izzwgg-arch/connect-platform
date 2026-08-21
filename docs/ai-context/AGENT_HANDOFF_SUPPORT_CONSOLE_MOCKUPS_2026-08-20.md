# AGENT HANDOFF — Technical Support Console: mockups + infrastructure inventory (2026-08-20)

**Mockups-only engagement. No code, no deploy, no migration, no PBX interaction, no data change.**
Izzy, 2026-08-20: *"I want to build a full-on technical support page for the technical
support people… Chat with the customers. Escalated chats will come in there… see reports
of one customer… when something is escalated and the agent sends it with a full report,
you should be able to see it there. Maybe even fix it, put a little IDE into it…
Run tasks from there as well… select which agent is using Opus, Fable, Sunnet, or Open AI."*
And explicitly: *"I want to see mock-ups before you build anything."*

**Deliverable: mockups artifact (3 layout directions + inventory + build plan + decisions):**
<https://claude.ai/code/artifact/042ff488-ae78-4e7f-b4cf-6ca8194b671a>

- **Option A "The Desk"** — escalation-first three-pane (queue / report / customer panel). Smallest build.
- **Option B "Mission Control"** — cross-company unified inbox with a human **take-over** of assistant conversations.
- **Option C "The Workbench"** — the full IDE: tabbed report / SQL console / task terminal, chat docked right.
- Recommendation given: start A, grow into B, add C's tools as a tab. Build order phases 1–5 in the artifact.

## §1 The infrastructure inventory (two very-thorough codebase sweeps, 2026-08-20)

This is the load-bearing research — verified with file:line refs, do not re-derive.

### Exists — reuse directly
- **Staff gating.** `apps/agent/src/adminAuth.ts` `resolveStaffCaller` / `resolveAdminCaller`;
  `isPlatformStaff` = SUPER_ADMIN only (`apps/agent/src/authRoles.ts`). API side: `requireOwner`
  + SUPER_ADMIN `x-tenant-context` header pivot (`connectChatRoutes.ts:85` `effectiveChatTenantId`;
  portal sends it from `services/apiClient.ts`).
- **Escalation DATA.** `AgentEscalation` (schema ~:6588) already stores the full research report:
  `report` (ISSUE/FINDINGS/PROPOSED FIX/APPROVAL, parsed by `escalations.ts:392 parseReportSections`),
  `proposedFix`, and the whole fix-by-text state machine (`fixCodeHash`, `fixStatus`, `fixActionId`).
  ⛔ **ZERO list/detail routes and ZERO portal screens exist** — today an escalation reaches only
  Izzy's phone + the alert inbox. Rendering this is the single biggest quick win.
- **Fix machinery.** `applyConfirmedAction` (`apps/api/src/agentConfirmations.ts:277`) + password
  dialog (`AgentGrantConfirmDialog.tsx`) + `agentFixByText.ts`. A console "Approve fix" button is a
  new caller of the EXISTING gate — never a second apply path.
- **Task runners ×3, no unified surface:** `POST /agent/diag/run` (writes `AgentDiagReport`);
  the `AgentAction` prepare→approve flow (`/agent/admin/approvals`, portal `/agent-approvals`);
  the deploy queue proxied as `/admin/deploy/*` (portal `/admin/deploy-center`).
- **`investigate`** — staff-only read-only SQL against BOTH prod DBs via
  `POST /internal/agent/investigate` (4 enforcement layers, fully audited). The natural engine for
  a console SQL panel; reachable today only through chat.
- **Chat model picker** — `AgentSecret` key `chat_model`, `GET /agent/admin/models`,
  `POST /agent/admin/secrets`, UI on `/assistant`. Repoints ONLY `support_chat` + `task_extraction`.
- **Admin-page scaffolding** — copy the `admin/pbx-console` pattern end to end: navConfig item +
  SUPER_ADMIN force in `isNavItemVisibleForUser`, `PermissionGate` on the page, a
  `PORTAL_API_PERMISSION_RULES` prefix (⛔ a prefix matching NO rule silently skips the global
  gate — documented incident `server.ts:2885`), `requireOwner` per handler.

### Partial
- **Tenant chat/SMS** — full per-tenant CRUD + `can_view_tenant_chats` oversight (whole-tenant
  thread list, read without participating, unread forced 0) + the super-admin tenant pivot.
  **No cross-tenant aggregate list** — a support inbox needs a new staff route.
- **Customer-360** — every source exists (`/calls/history`, `/voice/queues/reports`, billing
  per-customer routes, `AgentDiagReport`, escalations, `buildTenantFactsDoc` in
  `agentTenantFacts.ts` which already aggregates — but emits MARKDOWN for the LLM, not JSON).
  Needs one `GET .../360`-style endpoint. `/apps/customers` "Customer Hub" is a 15-line stub.
- **Model routing** — `DEFAULT_ROUTES` (`apps/agent/src/llm/router.ts:63`): support_chat/
  task_extraction → gpt-5; diagnostics/security_analysis/report_writing/policy_editing →
  claude-opus-5 (env `ANTHROPIC_MODEL_HEAVY`). ⛔ **No route/UI to pick models per task class**,
  and ⛔ **"Fable" (claude-fable-5) appears nowhere in the repo** — wiring it is small but real.

### Missing
- **Human takeover of assistant conversations.** No route accepts a human-authored message into an
  `AgentConversation`; no `assignedToUserId`/pause field; every read route is self-scoped
  (`engine.ts:602–628`). The whole take-over mechanism (pause agent → staff writes → resume) is new.
- **Staff list/read of assistant conversations** — `listConversations` filters by tenant AND user.
- **Any IDE/terminal/editor** — no monaco/codemirror/xterm anywhere in any app or package. Greenfield.

### §1b Corrections from the follow-up sweeps (2026-08-20, same day)
- ⛔ **The `/agent-api/*` → `/agent/*` nginx rewrite is NOT in the repo** — only code comments
  reference it; the config lives on loopcom. Verify it on the box before the console depends
  on the prefix, and note the commented 10 MB body cap on that path.
- **Agent-confirmation routes DO exist API-side** (missed in the first sweep):
  `GET /admin/agent-confirmations/pending`, `POST .../:actionId/apply` (password in body,
  bcrypt-checked), `POST .../:actionId/dismiss` (`agentGrantRoutes.ts:256-265`, plus legacy
  `/admin/agent-grants/*` aliases). Tenant-admin-scoped, NOT staff/cross-tenant.
  ⛔ **The password must NEVER traverse `/agent-api/*`** (`agentGrantRoutes.ts:10-12`) — a
  hard boundary for any console mixing the two origins. `AGENT_FIX_BY_TEXT_ARMED` at api
  boot is a ready-made health signal for a console status panel.

## §2 Security findings noticed in passing (NOT fixed — out of scope for a mockups task)

- ⛔ **`POST /agent/actions/decide` (`apps/agent/src/actions/routes.ts:22`) still gates on
  `id.role === "owner"`, which admits every TENANT_ADMIN** — inconsistent with the sibling
  `GET /agent/admin/approvals` that was narrowed to `resolveStaffCaller` in the fortification pass.
  A tenant admin cannot SEE the queue but can approve/deny any action id they learn. Same
  admin-mode-≠-staff class as the 2026-08-19 findings. Worth its own small fix.
- ⛔ **Two auth conventions would meet on this console:** API pages ride `services/apiClient.ts`
  (+ `x-tenant-context`, global permission preHandler), while `/agent-api/*` pages send a raw
  localStorage Bearer straight to the agent through nginx, bypassing the api's permission gate
  entirely. A console spanning both needs the bridge designed, not accreted.

## §3 The decisions that gate the build (Izzy's, all open as of 2026-08-20)

1. **Which direction** — A / B / C, or the recommended A → B → C-as-a-tab progression.
2. **Who counts as support staff.** ⛔ Today `isPlatformStaff` = SUPER_ADMIN and there is exactly
   ONE such account (Izzy's). A support team = new staff accounts seeing every tenant's chats,
   calls and billing → needs a deliberate "platform support" staff role, distinct from
   TENANT_ADMIN (the exact class of confusion the fortification pass just cleaned up).
3. **IDE power level — ANSWERED by Izzy, 2026-08-20** (in-chat, same day as the mockups):
   *"it should look like the real IDE with all features that an IDE needs, so the agent can
   run maintenance right off the server."* So the Workbench IDE is a FULL IDE (explorer, diff
   editor, integrated terminal) and the agent runs maintenance on the live server. The "C+"
   full-size IDE mockup was added to the artifact same day. ⛔ Design constraints drawn into
   the mockup and to be treated as the contract: the agent shows its PLAN before running;
   deletes/restarts/deploys PAUSE for a human click; code changes ship ONLY through the
   deploy queue (never straight onto the server); every command audited; **the PBX stays
   read-only from this screen — the standing house rule, enforced not promised**.
   **Sub-question ANSWERED same day** — Izzy: *"with the full SSH Sandbox which already
   exists, just wire it in."* So the Workbench terminal is a REAL root SSH session on
   loopcom, shared live between the support person and the agent (agent types, human can
   take the keyboard). ⛔ **Honest scope note, surfaced to Izzy in-chat: no product-side
   SSH terminal exists today.** What exists is the ACCESS — the server, the
   `.connect-ssh/` keys, and the canonical sandbox method Claude sessions use. "Wiring it
   in" = building a portal terminal (new dep, e.g. xterm.js), a session/PTY bridge service
   on loopcom, the staff gate, and keystroke recording. Defaults committed to in the
   mockup unless Izzy overrides: every session recorded; destructive agent steps pause
   for a human click; app code ships only via the deploy queue; ⛔ **the PBX key is NOT
   wired in — that box stays read-only (standing house rule)** — and nothing in this
   surface may touch payments.
4. **Wire claude-fable-5 into the router?** Independent small job.
5. **ANSWERED 2026-08-20 (later the same day, in-chat) — the interaction model:** Izzy speaks
   **plain English only, never code, and sees everything**; the agent codes VISIBLY —
   *"it codes like a movie animation"* — live cursor, typed-out edits, streaming terminal.
   The mockup artifact now carries a looping ANIMATION demonstrating exactly this. Build
   implication: agent work must stream as events (chunk-level file edits, terminal output,
   plan updates) into the console, not arrive as finished results.
6. **ANSWERED — permissions:** *"make permission titles for it… every feature… customize it
   for each agent individually."* Every console feature gets its own permission key, set
   per support agent via the EXISTING custom-roles machinery (mockup shows the switch
   panel: console/escalations/approve-fixes, chat/all-company-chats/take-over,
   customer-360/billing, diagnosis/investigate/tasks, workbench/SSH-terminal/models,
   edit-ground-rules/manage-support-roles). ⛔ `can_use_ssh_terminal` defaults OFF for
   everyone; approve-fixes always ALSO requires the password; each phase ships its keys
   with it. ⛔ Remember [[custom-roles-are-authoritative]] when building the role.
7. **ANSWERED — the Ground Rules rulebook:** a page where Izzy writes, in plain English,
   what the agent MAY do / may NEVER do / must ASK FIRST — versioned, every change logged,
   editable only by him unless granted. ⛔ Enforcement is double-layered BY DESIGN: the
   text goes into the agent's context AND the never/ask-first buckets are wired into hard
   permission gates — prose alone is the braces, not the belt (house rule). Standing
   nevers pre-seeded from existing guardrails: payments/pension, PBX writes, deploys
   outside the queue, the geo firewall.
8. **ANSWERED — the Watchman:** *"the agent… should constantly be checking the MD files,
   the server, and the PBX to make sure that everything is good."* Standing checks: re-read
   the rulebook + MD rule files before every job; watch server health (containers, disk,
   deploy queue); watch the PBX READ-ONLY (registrations, doorways, firewall loaded);
   anything off → stop and report, never push on.
9. **The engine — Izzy asked whether Claude can be integrated instead of building the
   agent ("have the IDE view inside Connect but it's actually Claude").** Answer given:
   **yes — the Claude Agent SDK** (the Claude Code engine, embeddable; streams every file
   edit + command = the movie feed; its permission callbacks map 1:1 onto the three rule
   buckets; reads CLAUDE.md-style rule files natively). ⛔ There is NO drop-in Anthropic
   IDE widget/iframe — the screens are still ours to build; the agent is not. Billed as
   API usage. ✅ **DECIDED later the same day** — Izzy: *"the SDK is already inside
   Loopcom, so just wire that into our IDE UI and keep it like cursor style."*
   ⛔ **Premise verified and corrected in-chat before accepting:** `apps/agent` carries
   only **`@anthropic-ai/sdk` ^0.60.0** — the plain API client (so the key + billing ARE
   already wired) — and `claude-agent-sdk` appears **nowhere** in the repo. Wiring it =
   one NEW dependency in a new small service beside the existing agent, same key, no new
   account. **UI style: Cursor-like** — editor center, agent chat docked right, changes
   as inline diffs (the C+ mockup already matches).

## §4 BUILD STARTED — Phase 1 (the escalation desk) + Fable SHIPPED (2026-08-20, commit `d61c98b9`)

Izzy, same day: *"build it, do fabel as well, and for now do just super admin, and I will
create it later."* The mockups-first instruction is discharged; phases now ship in order.

- **API:** `apps/api/src/supportConsole.ts` — `GET /admin/support/escalations` (filters:
  status/tenantId/take/before-cursor; `counts.fixReady`) and `GET .../:id` (full stored
  report, conversation tail via `agentMessage`, the linked DRAFT `agentAction`).
  ⛔ Field-by-field responses, `fixCodeHash` NEVER leaves the server (tested).
  ⛔ SUPER_ADMIN two ways: every handler calls `requireSuperAdmin` AND
  `{ prefix: "/admin/support", permission: "can_manage_global_settings" }` in
  PORTAL_API_PERMISSION_RULES. ⛔ NO new grantable key yet, deliberately — a key a
  non-super could tick while handlers refuse them is a visible door that doesn't open;
  per-feature keys ship with the support-agent phase.
- ⛔ **Approve-fix is the EXISTING gate:** the portal posts the DRAFT action id to
  `POST /admin/agent-confirmations/:actionId/apply` (password, bcrypt). No new apply
  path — a source test pins that supportConsole.ts registers no POST and never touches
  `applyConfirmedAction`. Cross-tenant works because `applyConfirmedAction` feeds the
  ACTION's own tenantId into `resolveTargetTenantId`, which for SUPER_ADMIN resolves to
  that tenant (agentConfirmations.ts:218) — verified in source before building.
- **Portal:** `/admin/support` (Support Desk) — queue left (All / Fix ready / Needs a
  look), report center (sections via `lib/escalationReport.ts` parser — a deliberate
  mirror of the agent's `parseReportSections`, forgiving, `hasSections:false` renders
  raw so degraded reports still show), conversation tail, password dialog. Nav item
  `admin.support` forced SUPER_ADMIN in `isNavItemVisibleForUser` (pbx-console pattern).
  ⛔ `PermissionGate` uses `can_manage_global_settings`; errors read `e.body` (never
  `.payload`). Test registered in the portal package.json EXPLICIT list.
- **Fable:** `KNOWN_ANTHROPIC_CHAT_MODELS = ["claude-fable-5"]` in
  `apps/agent/src/llm/router.ts`, unioned into `listModels`' Anthropic catalog (and
  offered even when the provider's list call fails — the picker's ping validates).
  ⛔ The agent is a MANUAL rebuild: reset the server clone to origin first.
- **Tests:** 9 api (wiring guards proven failing against pre-change server.ts) +
  6 portal parser + 3 agent (incl. a listModels source guard). Typechecks: portal 0,
  api 75 = the exact baseline, agent adds 0 (its 14 are other sessions' WIP). Portal
  suite 223 pass / 2 = the documented pre-existing failures.
- ✅ **DEPLOYED AND CONTAINER-VERIFIED, ALL THREE, 2026-08-20 evening:**
  **api** `deploy-direct.sh api` → `verify: container commit d61c98b978a7 matches
  target`, module greps in the container, unauth GET → 401, health 200;
  **portal** (19 min build) → `.build-commit d61c98b9`, the page chunk
  `.next/static/chunks/app/(platform)/admin/support/page-*.js` greps the STRING
  "Approve the fix", both hostnames 200; **agent** manually rebuilt after the
  deploy's clone reset → healthy, `KNOWN_ANTHROPIC_CHAT_MODELS`/`claude-fable-5`
  grep in the running container, 0 error-level log lines.
- ✅ **PROVEN LIVE WITH REAL DATA:** a 60-second self-signed SUPER_ADMIN token
  against `127.0.0.1:3001/admin/support/escalations?take=5` answered
  **200, 4 escalations** (the platform's entire real backlog — ⛔ the 93 dropped
  "promises" from before the 2026-08-19 escalation fix were never written as rows,
  which is precisely what that bug was; only post-fix rows exist), first row
  Connect Communications Ref 8Z7C4Q. The whole chain ran: JWT hook → permission
  rule → requireSuperAdmin → data.
- ⏳ **NOT PROVEN until a human looks:** nobody has opened `/admin/support` in a
  browser, and no fix has ever been approved from it (fixReady is 0 today, so the
  approve path awaits the next escalation that carries a draft). Acceptance
  (2 min, Izzy's login): open the page → 4 rows list → open one → the report
  renders in sections → the negative: a TENANT_ADMIN must not see the nav item,
  and the API must 403 them. ⛔ An already-open portal tab keeps the OLD bundle
  until reloaded.

## §5 Phase 2 — the customer panel: SHIPPED same evening (commit `8e192e5d`)

- `GET /admin/support/customers/:tenantId` aggregates: ACTIVE extensions
  (`extNumber`/`displayName`), user count, numbers (`PbxTenantInboundDid` by
  **`connectTenantId`** + active), texting numbers, billing posture
  (**`autoBillingEnabled`** — ⛔ not "autopayEnabled" — + FAILED/OVERDUE and OPEN
  invoice counts), last 5 calls (`ConnectCdr` `startedAt`/`talkSec`), last 5
  escalations. ⛔ **Every block is best-effort** — a failing source empties its
  card, never a 500 (tested). Portal renders it as the desk's third column,
  cached per tenant, past escalations clickable.
- ⛔ **No `:has()` in supportDesk.css, on purpose** — the 3-column state is a
  class the component toggles (`sd-body-3`), per the 70ms-per-DOM-mutation
  finding. Keep it that way.
- ✅ **DEPLOYED + verified:** api container `8e192e5d`, live probe of the
  endpoint → 200 with Connect Communications' real aggregate (1 ext / 1 user /
  1 number / autopay off / 5 calls). Portal container `.build-commit 8e192e5d`,
  the support page chunk greps "Invoices needing attention", css carries
  `sd-cust`, both hostnames 200. ⛔ The portal deploy log's last line read
  `done d0627e7c` (a later fetch's clone HEAD — the documented trap);
  `.build-commit` + the bundle grep are the authority. Tests 13/13.

## §6 Phase 3 — the cross-company inbox: SHIPPED (`a2bb91fa`)

- `GET /admin/support/threads` — every company's `ConnectChatThread` newest-first,
  tenant names joined, last-message previews (⛔ a deleted message never previews).
  `GET .../threads/:id` — transcript oldest-first, deleted bodies masked to `""`,
  senders named via the shared `resolvePersonDisplayName` (extension name first),
  ⛔ inbound labelled by the external NUMBER, never a guessed contact name.
- ⛔⛔ **`POST .../threads/:id/reply` DELEGATES to the injected
  `sendConnectChatSmsMessage`** — the ONE send implementation (participant join,
  `canSendSmsUser`, provider dispatch, pushes). **`tenantId` comes from the
  THREAD, never the caller**, so the reply leaves from that company's own number.
  Non-SMS threads are refused in plain English; a missing injection answers 503
  rather than inventing a sender. ⛔ A source guard pins the exact POST route
  list and fails on `smsQueue.add` / `sendSMS(` / `voipMs` / `connectChatMessage.create`
  appearing in this module, plus a second guard that **server.ts injects the real
  sender**.
- ✅ **DEPLOYED + verified:** api + portal container-verified at `a2bb91fa`.

## §7 Phase 4 — assistant take-over: SHIPPED (`7a2e106c`)

Migration **`20260820213000_agent_conversation_takeover`** — `AgentConversation.
humanTakeoverAt` / `humanTakeoverBy`, both nullable (no existing row changes).
✅ Applied live (`prisma migrate deploy`, 20.8 s) and **both columns confirmed in
the production database**.

- ⛔⛔ **THE CONTRACT HAS THREE LEGS AND ALL THREE MUST SHIP TOGETHER:**
  **(1)** the desk API flips the flag and writes `role: "staff"` `AgentMessage`
  rows; **(2)** the agent **ENGINE** refuses to answer while the flag is set —
  ⛔ **that half is an agent CONTAINER REBUILD, not an api deploy**; **(3)** the
  customer's widget polls `/agent-api/chat/messages`, which now reports the flag
  (`getMessagesWithState`, same gating — tenant isolation tested).
- ⛔ **The engine's take-over branch sits BEFORE the Yiddish input leg** on
  purpose: bridging costs Yiddish Labs credits and its only consumer would be
  the model that deliberately is not running. While taken over the engine is a
  mailbox — stores the customer's message, runs no model, returns
  `humanTakeover: true` with an empty reply.
- ⛔ **A staff message REQUIRES an active take-over (409 otherwise)** — the
  assistant and a person both answering is two voices in one mouth.
- ⛔ **`AgentAuditLog.hash` is REQUIRED tamper evidence** — the first draft wrote
  bare `agentAuditLog.create` calls that would have failed silently; `supportAudit()`
  computes a real sha256 (a test asserts a 64-char hash, never a stub).
- Both moments are announced in the transcript (take-over and hand-back), so the
  change of voice is never silent; the widget renders staff turns as
  **"Loopcom support · a real person"** and polls every 4 s, stopping itself on
  hand-back.
- ✅ **DEPLOYED + verified:** api `fd9fc575` (route greps in-container, migration
  applied); **agent REBUILT — the running container greps `humanTakeoverAt` ×2 and
  `getMessagesWithState` ×1** (⛔ no bind mounts on `app-agent-1`, so the code
  really is the image's); portal carries "Take over from the assistant" in the
  shipped chunk.
- ⛔ **A deploy log lied again and the bundle grep caught it:** my own Phase-4
  portal deploy **FAILED** (`git fetch origin --prune failed`) — yet the feature
  is live, because a parallel session's portal deploy at `4e13522f` carried the
  commit up. **Judge by `.build-commit` + a bundle STRING grep, never the log.**

## §8 The sidebar (`9fbd5af3`)

Izzy: *"put it in the sidebar."* It already WAS — and deployed — but at
**position 9 of 25** in the Admin section, between Ring Groups & Queues and PBX
Events, which is functionally invisible. Moved to the **top of the Admin
section**, above Admin Console. Gating unchanged.
⛔ **Committed surgically from the tip**: the shared worktree's `navConfig.ts`
also held another session's **uncommitted** pbx-console permission-key fix
(`can_manage_global_settings`), which a plain file commit would have swept in.

## §9 Phase 5a/5b — the Ground Rules and the Watchman: SHIPPED (`fe755157`)

⛔⛔ **BUILD ORDER IS THE POINT: the governor shipped BEFORE the engine it
governs.** An execution surface that can run commands on production needs its
rules to exist first; bolting guardrails on afterwards is how they end up not
quite fitting. Phase 5c (the IDE + SDK + terminal) is deliberately still unbuilt.

**Ground rules** (`apps/api/src/supportGroundRules.ts`, migration
`20260820234500_support_ground_rules`, applied live):
- Three plain-English lists owned by Izzy. **Append-only** — every save writes a
  NEW version and nothing is updated in place, so the row history IS the audit
  trail he asked for.
- ⛔⛔ **`classifyAction()` is the EXECUTABLE half.** The rendered text going
  into the model's context is the braces; this is the belt. Phase 5c MUST call
  it and obey the verdict, so "never" holds even when the model is wrong or
  talked into something. A rulebook that lives only in a prompt is decoration —
  this repo already shipped an assistant that "passed it to the team" for two
  weeks with nothing behind the words.
- ⛔ **Order is the safety property: NEVER > ASK > ALLOWED**, and ⛔ **no match
  ⇒ ASK, never ALLOW.**
- ⛔ **The matcher is VERB-AWARE, and that is not decoration.** A noun-only
  matcher sees "PBX" in both "Read the PBX" (allowed) and "Write to the PBX"
  (never) and refuses the read the rules permit; it also refused "delete the old
  deploy logs" because the word *deploy* appeared. Rule shapes: subject-only
  ("Payments, billing or pension") matches ANY mention; verb-only ("Delete
  anything") matches that kind of action; verb+subject needs both.
  ⛔ **Do NOT put a common word like "customer" in a subject-only never rule** —
  it refuses half of all support work (caught in test, fixed before shipping).
- ⛔ An **empty never-list is refused** (400) — that is a mis-paste or a UI bug,
  not a decision.

**The Watchman** (`apps/api/src/supportWatchman.ts`) — Izzy: *"constantly be
checking the MD files, the server, and the PBX."*
- Three checks: rule files readable → server healthy → PBX reachable **and
  read-only**. ⛔ **Read-only is proved by asking `SELECT CURRENT_USER()` and
  confirming `connect_read`, NEVER by attempting a write** — testing a write
  guarantee by writing is how you break the thing you were checking.
- ⛔⛔ **FAIL SAFE: a probe that THROWS becomes "unknown", and unknown BLOCKS
  work.** An unreachable-but-read-only PBX is only a WARNING (nothing can be
  harmed); a PBX that is NOT read-only is a stop-everything.
- Probes are injected, so the whole verdict layer is unit-testable with no
  server, database or PBX.

✅ **DEPLOYED + PROVEN LIVE on production** (api container `fe755157`, migration
9.8 s): the Watchman answered **safeToWork: true** with all three real checks —
`rules: 2 rule files read`, `server: 2 services healthy`, **`pbx: Reachable, and
read-only`** (a real MySQL connection to the live PBX confirming the credential)
— and the live classifier answered **"write a new extension to the PBX" → never**
while **"read the PBX extension list" → allowed**.

Tests: 29 console + 13 rules + 9 watchman. Portal typecheck 0; api 75 = baseline.

## §10 Phase 5c — the Workbench: SHIPPED (`9e824f19`)

⛔⛔ **THE HEADLINE, AND IT CORRECTS THIS DOC'S OWN EARLIER ADVICE: no new SDK
and no new API key were needed.** §9 said 5c was blocked on installing
`claude-agent-sdk` plus a key. **Checked before building: the platform already
has the engine** — `completeWithTools` in `apps/agent/src/llm/router.ts` is a
working agentic loop with a `staff` tool tier, and **both `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` are already SET in `app-agent-1`**. So the workbench was
built on proven in-house infrastructure with **zero new dependencies**.
**Check what the platform already has before adding a dependency** — the
"missing" engine was the same one `investigate` already rides.

**`apps/api/src/supportWorkbench.ts` — three doors, four gates.**
- ⛔⛔ **GATE ORDER IS THE SAFETY PROPERTY: WATCHMAN → SHAPE+ALLOWLIST →
  SECRETS → RULEBOOK.** The allowlist runs before the rulebook so the read-only
  guarantee is established before the verdict is interpreted.
- ⛔ **`ALLOWED_BINARIES` is READ-ONLY TOOLS ONLY** — a test asserts `rm`, `mv`,
  `chmod`, `bash`, `sh`, `npm`, `tee`, `dd`… are absent. `FORBIDDEN_SUBCOMMANDS`
  blocks the dangerous halves of safe binaries (`git push/reset`, `docker
  restart/exec`, `systemctl restart`, `sed -i`, `find -delete`), and chaining,
  substitution, redirects and `sudo` are refused so one approved command cannot
  smuggle a second. **Every segment of a pipe** is allowlisted, not just the first.
- ⛔⛔ **A HOLE FOUND WHILE BUILDING: `cat` is legitimately read-only, so the
  door would have served `.env.platform` and every private key on the box.**
  `commandTouchesSecrets()` refuses secret PATHS mechanically. The rulebook says
  never read credentials; this is that rule made enforceable, because "don't
  look" is not a control.
- ⛔ **ONE DELIBERATE ASYMMETRY, documented in the code:** `classifyAction`
  defaults an unrecognised action to ASK, but `decideCommandRun` PROCEEDS on an
  unmatched command — the allowlist has already proven it read-only, and
  prompting for `ls` teaches a support person to click through the confirmation
  that matters. **A real ask-first RULE still stops it** (`verdict.matchedRule`
  is what separates the two cases); `never` refuses even when confirmed.
- ⛔ **NO PTY / interactive shell, on purpose** — a shell makes every gate above
  decoration the moment someone types `bash`. If Izzy ever wants a true
  terminal it is its own engagement with its own decision.
- ⛔ Refusals are audited exactly like runs (`workbench.command_refused` /
  `workbench.command_ran`) — a door that records only its successes is not an
  audit trail. ⛔ **Unset workspace root ⇒ the workbench is OFF (503)**, never a
  fallback to cwd. Path traversal and credential files are refused by the file
  reader too; `node_modules`/`.git`/dotfiles are never listed.

✅ **DEPLOYED (api container `9e824f19`) AND THE GATES DRIVEN LIVE ON
PRODUCTION** — the explorer listed the real repo (`apps`, `docs`, `infra`,
`ops`, `packages`), a real `git status | head` ran (exit 0), and **all five
attacks bounced**: `cat …/.env.platform` → **403 refused_secrets**;
`ls; rm -rf /tmp/x` → 400; `bash -c whoami` → 400; `docker restart app-api-1`
→ 400; `../../etc/passwd` → 400.

Tests: 18 workbench (every refusal path) + 32 console. Portal typecheck 0; api 75.

⏳ **NOT DONE / next:** the agent DRIVING the workbench (its tools would be
`read_file` / `list_files` / `run_command` at `minRole: "staff"` in
`apps/agent/src/tools/`, calling these doors exactly as `investigate` does — the
loop and the keys already exist, so this is wiring, not a capability build);
proposing an edit as a reviewable diff and shipping it through the deploy queue;
and ⛔ **nobody has opened the Workbench tab in a browser.** The support-agent
accounts and per-feature permission keys remain Izzy's to create.

## §11 The IDE, built to the mockup (2026-08-21, `8b690d52` + `0ba63443`)

⛔⛔ **THE PROCESS LESSON, AND IT IS THE MOST IMPORTANT LINE IN THIS FILE.**
Izzy, repeating himself and furious: *"What is the point of making mockups if you
never make it look like the mockups?"* He was right. The first build had the
mockups' STRUCTURE and generic portal styling, and every status report claimed
"matches the mockups" **without ever putting them side by side.** Two rules now:
1. **Port the mockup, do not re-derive it.** `workbenchIde.css` carries the
   mockup's own values verbatim and `SupportWorkbench.tsx` is the mockup's
   markup wired to real data. There is no interpretation step to drift through.
2. ⛔ **Never claim a screen matches a mockup without publishing the
   comparison.** Proof pages — the desk
   <https://claude.ai/code/artifact/90e6e2f7-fabc-466c-8555-47e3e6830b05> and the
   IDE <https://claude.ai/code/artifact/20aeef9d-c32d-4b6c-a9ba-59fb99c7e48b> —
   render the BUILT screen with the real shipped stylesheet beside the drawing,
   so the claim is checkable without opening the app.

Approved mockup: <https://claude.ai/code/artifact/cf13e7b7-ebbf-414e-a1a6-f22dee7a2eaa>

**The IDE** (`/admin/support` → Workbench): menu bar, activity bar with a
git-change badge, explorer with git letters + open editors, editor tabs with
close, breadcrumbs, a local syntax highlighter (⛔ no new dependency — a
tokeniser inside the component), minimap, Terminal/Problems/Output panel, the
SSH pill with its recording dot, the shell strip, the guarded terminal with
history and confirm-to-run, a status bar, and a ⌘K command palette. The agent
dock talks to the real assistant; the model switcher writes the real
`chat_model` (Opus 5 / Sonnet 5 / Fable 5 / GPT-5).

⛔ **`workbenchIde.css` is the ONE place in the portal carrying its own palette,
and its header says why.** The house rule exists because billing keyed off the
OS preference and disagreed with the app's own theme switch. An IDE is a
different case — its own visual world, VS Code inside a light app is still dark
— so the values are FIXED, never `prefers-color-scheme`, and scoped under
`.ide-root` so nothing leaks.

⛔⛔ **ESCALATIONS ARE CHATS** (Izzy, repeatedly — he had to say it several
times before it landed). The escalation IS the conversation: the list is people,
the middle is their thread, and the agent's report is a card INSIDE it.
Take-over and reply reuse the Phase-4 routes; the customer panel stays right.
**The old report-list view is DELETED, not dead-coded** — with it went ~180
lines of state that made `page.tsx` unreasonable; the shell now holds no screen
logic at all, so a change to one view cannot quietly break another.

### §11a What driving it live found — and the mount I refused
⛔⛔ **The api container has NO `git` binary and NO `.git`** — the image COPIES
source, it is not a clone. So the branch and the explorer's M/U letters came
back silently empty and the palette offered git actions that answer
"git: not found".
⛔ **Deliberately NOT fixed by mounting `/opt/connectcomms/app`**: that clone
holds **live `.env` files**, and trading real credential exposure — guarded only
by a filename regex — for cosmetic git chrome is the wrong bargain. A deployed
container's uncommitted-change letters would be empty anyway (deploys
hard-reset), so the benefit was near zero.
✅ **Fixed by reporting the truth instead:** capabilities returns
`permittedBinaries` (the policy) AND `allowedBinaries` (what is really on PATH),
plus `deployedCommit` read from `.build-commit`. The status bar shows a branch
when there is a repo and otherwise **the running commit** — which is what a
support person actually needs — and never invents one. The palette, the
source-control icon and the terminal placeholder hide what this container cannot
run; Output lists permitted-but-absent so the gap is visible rather than
puzzling.
⛔ **The general rule: offer only what the box can actually do.** A control that
answers "not found" is how a tool teaches people to distrust it.

⏳ **Still not built:** the agent DRIVING the workbench (tools `read_file` /
`list_files` / `run_command` at `minRole: "staff"` calling these doors exactly
as `investigate` does — the loop and keys exist, so it is wiring), the inline
accept/reject diff the mockup shows, and a real interactive SSH PTY (the
terminal is the guarded read-only runner; the SSH pill reflects that the box IS
loopcom, not a shell). Support-agent accounts and per-feature permission keys
remain Izzy's to create.

### §11b The rulebook refused ordinary work, and only the live run found it
⛔⛔ **`wc -l apps/api/src/supportWorkbench.ts` came back refused as NEVER**, and
*"restart the api container"* matched **"Passwords, card details or API keys"**
instead of its own ask-first line. The cause: that rule contributed the bare
token **`api`**, which is a substring of every path under `apps/api`. **79 unit
tests were green through this.** It is the third time in this repo that a
plain-word matcher over-blocked (after "deploy" in *"delete the old deploy
logs"*, and a subject-only rule containing "customer" refusing half of support).
✅ **Fixed (`00a5c8a0`): a rule LINE is a LIST.** `ruleItems()` splits on
`, ; / or and`, and a match needs **every word of ONE item** — so "API keys" is
one phrase and `api` alone can never trip it — while a verb stated anywhere on
the line still governs every item on it ("Read files, logs and code…").
Singularisation drops to **>3 characters** so a rule about "logs" matches an
action about a "log", with three-letter words (`sms`, `did`, `dns`) left intact;
filler prepositions joined the stopwords so "Anything about docker" still
matches `docker ps`. Six regressions added, **every one taken from what the live
run actually did**; suite 79/79, api typecheck 75 = the exact baseline.
⛔ **The rule this earns: an over-broad safety layer is the one that gets
ignored.** A refusal a support person knows is wrong teaches them the rulebook
is noise, and the next refusal — the real one — gets clicked through. Judge a
guard by what it lets through as well as by what it stops, and **drive it on
real inputs**: unit tests written by the same person who wrote the matcher share
its blind spot.
