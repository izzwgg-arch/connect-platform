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

⏳ **Phases 2–5 NOT started** (customer panel, cross-company inbox + take-over, tools,
the Agent-SDK workbench). The support-agent accounts remain Izzy's to create.
