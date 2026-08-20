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
   ⏳ One sub-question still open: whether support staff also get a RAW human-typed terminal
   at the server, or everything on-server runs agent-mediated (recommended: agent-mediated).
4. **Wire claude-fable-5 into the router?** Independent small job.

⏳ **NOT STARTED: everything.** No phase has been approved; nothing may be built until Izzy picks
a direction and answers §3. Per his explicit instruction, mockups first.
