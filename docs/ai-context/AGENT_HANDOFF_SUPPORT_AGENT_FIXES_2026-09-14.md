# AGENT HANDOFF — the automatic support agent is being given HANDS: it acts as the ticket's filer, texts the owner first, and STOP / GO are enforced (2026-09-14)

READ FIRST before touching `apps/api/src/support/actAsFilerRoutes.ts`,
`apps/api/src/support/supportAgentNotice.ts`, `agentFixByText.ts`'s reply sweep,
`tools/loopcom-support-mcp` (the watcher), or before giving the support agent any
new write power. Companion reading: `2026-08-31-a-customer-s-support-request-now-opens-a-claude.md`,
`AGENT_HANDOFF_SUPPORT_LOOP_BOTH_WAYS_2026-09-01.md`, `AGENT_HANDOFF_FIX_BY_TEXT_2026-08-16.md`,
`AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md`.

## 0. Why this exists

Ticket **3GTH9M** (Trust Bookkeepings ext 101, "my voicemail greeting doesn't play"):
the watcher's agent found the exact root cause in 11 minutes (busy calls play
busy.wav; Connect only ever saved unavail.wav) — and could fix nothing, by
design (read-only, Edit/Write/commit/push/deploy denied). The customer was told to
dial *97; the real fix needed a second session. Izzy: *"This should have been done
automatically … it should be allowed to fix everything."*

## 1. Izzy's rules (2026-09-14, verbatim decisions)

1. **Permissions = the filer's custom role.** *"If a regular user files a support
   ticket, the agent can fix everything that his user has permission to in the
   custom role."* Owner-level things (billing, payments, buying/porting/releasing
   numbers) only for someone whose custom role has the **Owner toggle**
   (`can_act_as_account_owner`). **No tenant leakage.**
2. **Tenant-only change →** text Izzy what is being done; **do not wait**; he
   interferes if he wants.
3. **Change that affects the whole system →** text Izzy and **wait for his reply**.
4. **Customer:** may be told it is fixed **only with proof it is fixed 100%**, in
   plain English; the agent may also talk to the customer — ask them to test or do
   something, "just as I do".
5. **Coworker:** the agent may run PowerShell on the customer's computer **through
   the Coworker installed in the Loopcom Windows app**, with the approval pop-up the
   user must allow.
6. **Cap: 10 fixes per day, per tenant.**

## 2. The design, and why each piece is shaped this way

⛔⛔ **The watcher agent runs on Izzy's PC with a SUPER_ADMIN token and root SSH.**
No tool list can confine THAT to one company. So "only what the filer may do" is
enforced by the API, never by the agent's judgement:

| Phase | What | State |
|---|---|---|
| 1 | Act as the filer (`/act`) | ✅ DEPLOYED `cc8211c1` |
| 2 | Owner notice + STOP/GO, write gate | ✅ DEPLOYED (`31dc0e05` inside container `12d2c318`) — see §6 |
| 3 | System-wide lane: own worktree, tests, push+deploy only after GO, verify, rollback | not built |
| 4 | Customer conversation (SupportMessage/SMS, resume session on reply, "fixed" only with proof) | not built |
| 5 | Coworker bridge: `computer_powershell` on the filer's linked desktop, forced approval | not built |
| — | Watcher: MCP tools for act/owner-notice, per-tenant cap, guardrails rewrite, read-only SSH keys | not built |

### Phase 1 — `POST /admin/support/escalations/:reference/act` { method, path, body? }

Replays ONE request through the api's own routes with `app.inject`, signed as the
filer with a **2-minute token that never leaves the api process** (the existing
`injectAsService` pattern, `server.ts` agent grant routes). The global preHandler
then resolves that person's permissions from the database exactly as for their own
browser. Enforced in code:
- caller must be SUPER_ADMIN (the watcher's token);
- identity from the **user row**, never the request; **filer tenant must equal the
  ticket tenant**; SUPER_ADMIN filers refused; platform alarms (no `clientUserId`)
  refused; tickets > 7 days refused; inactive filers refused;
- `BLOCKED_PREFIXES` for everyone: `/admin /internal /auth /ops /agent /agent-api
  /support /onboarding /voice/pbx/resources` (the last is the unscoped raw VitalPBX
  door from the 2026-08-17 isolation audit); absolute URLs, `//`, `..`, encoded
  traversal, backslash/control chars refused; `token=` / `tenantContext=` query
  params refused; `x-tenant-context` never forwarded;
- **writes OFF unless `SUPPORT_AGENT_WRITES_ENABLED=1`** (not set anywhere yet);
- writes capped at **10 distinct tickets per tenant per UTC day** (`auditLog`
  `SUPPORT_AGENT_ACT_WRITE`, a ticket already in today's set may continue);
- every call audited `SUPPORT_AGENT_ACT_READ|WRITE` against the escalation.

### Phase 2 — owner notices (`SupportAgentNotice`)

- `POST /admin/support/escalations/:reference/owner-notice` { scope: tenant|system, summary }
  texts `AGENT_ESCALATION_SMS_TO` (Izzy's two numbers) from the escalation number via
  `resolvePlatformSmsSender`. tenant → status `proceeding` ("Reply STOP <code> to stop
  it"); system → `awaiting_go` ("Reply GO <code> … Nothing happens until you reply").
  **The code is hashed (`support-notice:` prefix) and never stored or returned** — the
  agent must not hold the thing that approves its own request. SMS not delivered → 502
  and the gate stays shut. After STOP a new notice is refused (409).
- `GET …/owner-notices` → the notices + `mayChange`.
- ⛔⛔ **The write gate is in the act route** (`deps.ownerNoticeGate`, before the
  replay): no write without a live, SMS-delivered, unexpired tenant notice (or an
  approved system one); **any STOP on the ticket refuses all further writes**.
- Replies: the **one existing reader** `sweepFixRepliesBatch` (60 s, escalation-number
  threads from owner numbers only) now also parses `STOP <code>` / `GO <code>`
  (`parseNoticeReply` in `@connect/shared`): word + 6-digit code together; bare words,
  bare codes, both words refused; **a negated go ("no go", "don't go", "wait", "hold")
  is never a yes**; STOP works even after expiry; atomic `updateMany` claims so one
  reply acts once; a "no change" answer is not re-sent every minute (in-memory
  answered set — after an api restart one duplicate answer is possible).

## 3. Facts found along the way (all verified 2026-09-14)

- **The Coworker is live on real customer PCs.** nginx `agent-api/coworker/hello`:
  ~570 hellos each from `66.250.99.208` (**Trust Bookkeepings' office — the same IP
  ext 101's desk phone registers from**), `50.48.58.53` (Izzy), `173.212.214.198` (dev
  box), plus B Visible's Philippines IPs; UAs rc.10 → rc.15.
- `computer_powershell` (desktop `toolCatalog.ts`) is category SHELL: **asks under
  SAFE and TRUSTED, runs without asking under AUTONOMOUS**; its denylist
  (`runtime/shell.ts` SHELL_DENY_PATTERNS) refuses security/firewall/network changes,
  Stop/Restart-Service, installs (winget), New-LocalUser, Enable-PSRemoting,
  Restart-Computer, HKLM policy writes, encoded commands. ⛔ Those are desktop floors,
  not settings — "repairs" through the Coworker cannot include them without a desktop
  change (Izzy's call). ⛔ Izzy wants the pop-up ALWAYS for support-originated calls,
  so phase 5 must add a "require approval" flag the desktop honours — stricter only,
  which a compromised server cannot use to skip the pop-up. Needs a desktop build.
- `DesktopLink.dispatch(identity, {name, args, taskId, timeoutMs})` (agent
  `coworker/desktopLink.ts`) queues a call for a linked desktop keyed `tenantId:userId`
  and resolves with a result (never rejects; not-connected / timeout / cancel are
  results). Today only the chat engine calls it — phase 5 needs a door for the support
  agent.
- **Why 3GTH9M wasn't picked up "automatically": it WAS.** Watcher claimed it 20:33:42Z,
  report done 20:45:04Z, SupportUpdate delivered 20:46:06Z (unread). The ticket MCP
  tool's `formatTicket` prints "NOBODY HAS INVESTIGATED THIS YET" for every
  Report-a-problem ticket without checking agent runs — that misled the second session.
  ⏳ Not fixed yet.
- **Nothing tells Izzy a report says "code fix needed"** — the report-back path
  (`customerUpdateRoutes.ts` agent-report) sends no SMS/email; only a customer
  "not fixed" verdict re-escalates. ⏳ Not fixed yet.
- Vigdor's widget still holds the *97 advice (unread) while an SMS told him it is
  fixed; recording a busy greeting on the handset now would make it "distinct" and
  block the Connect mirror. ⏳ A widget correction needs Izzy's OK.

## 4. Traps hit this session

- ⛔ **A `Write` tool payload decodes JSON `\u` escapes into real bytes.** The phase-1
  regex `[\\ -]` landed as literal 0x00–0x1F and git stored the file as
  **binary** (`Bin 0 -> 10665 bytes`, commit `d1f2aa46`); fixed in `cc8211c1` with a
  char-code check written via a Python script that builds backslashes with `chr(92)`.
  Rule: no `\u`/`\b`/`\d`/`\s` in tool-written source — use `[0-9]`, `[a-z]`, char
  codes; scan new files for stray control bytes before committing. See
  [[control-chars-from-heredocs-make-source-binary]].
- A source guard "replayed" from a scratchpad copy failed with `Cannot find module
  'fastify'` — that proves nothing. Replay by counting the asserted symbol in
  `git show HEAD:<file>` instead.
- The permission classifier blocked a remote DB write and (once) the deploy enqueue in
  this session; after Izzy said "keep going" the enqueue went through. Never route
  around a denial.

## 5. Not proven (⏳)

- No request has been sent through `/act` by the watcher; no owner notice has been
  texted; no real STOP/GO reply has been processed.
- `SUPPORT_AGENT_WRITES_ENABLED` is unset — writes as the filer are OFF in production.
- Phases 3–5 and the watcher-side tools do not exist.

## 6. Deploy state

- api `cc8211c1` (phase 1 + binary fix): ✅ container-verified — `.build-commit`
  cc8211c1, restarts 0, healthy, `/admin/support/escalations/:ref/act` → 401 without a
  token on both hostnames, health 200 on both.
- api phase 2 + migration `20260914230000_support_agent_notice`: first attempt `33fb81a7`
  stopped at the migrate stage on `HEAVY JOB ALREADY RUNNING: deploy-queue:portal:compose-build-portal`
  (another session's portal deploy) — **changed nothing** (no migration row, no table, container unchanged).
  Retry `928e0b0c` after that portal job finished: ✅ `Applying migration 20260914230000_support_agent_notice`
  → "All migrations have been successfully applied"; container `.build-commit` **12d2c318** (a later
  commit that contains `31dc0e05` and `cc8211c1`), restarts 0, healthy; `registerSupportAgentNoticeRoutes` and the
  `checkOwnerNoticeGate` wiring present in the container; `SupportAgentNotice` table exists, 0 rows.
