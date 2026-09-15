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
| 3 | System-wide lane: own worktree, tests, push+deploy only after GO, verify, rollback | ✅ `8bce4506` DEPLOYED (api route) + watcher restarted — see §9. ⏳ no real ticket has shipped through it |
| 4 | Customer conversation (SupportMessage/SMS, resume session on reply, "fixed" only with proof) | not built |
| 5 | Coworker bridge: `computer_powershell` on the filer's linked desktop, forced approval | not built |
| — | Watcher: MCP tools act_as_filer / post_owner_notice / get_owner_notices, fixing guardrails, 10/company cap, 30-min runs, api `changeWasMade` from the audit trail | ✅ `84a5fc16` DEPLOYED + watcher restarted — see §7. ⛔ writes still OFF (`SUPPORT_AGENT_WRITES_ENABLED` unset). Read-only SSH keys NOT done (PBX write — Izzy's call) |

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
  regex `[\\\u0000-\u001f]` landed as literal 0x00–0x1F and git stored the file as
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
- api `84a5fc16` (watcher hookup's api half — `verifiedChangeOnTicket`): ✅ job `488b8c20`, container
  `.build-commit` 84a5fc16, restarts 0, healthy, symbol present in the container.

## 7. The watcher hookup (`84a5fc16`, 2026-09-14)

- **MCP tools** (`tools/loopcom-support-mcp/server.mjs` + `loopcom.mjs`): `act_as_filer {reference, method, path,
  body}` → `POST …/act`; `post_owner_notice {reference, scope, summary}`; `get_owner_notices {reference}`. All three in
  `ALLOWED_TOOLS` (under `-p` an unlisted tool is DENIED). The client adds no gate; a 4xx comes back as an error
  carrying the api's reason (e.g. `409 stopped_by_owner`).
- **Guardrails** (`watch.mjs` GUARDRAILS): "Investigate and REPORT. Do not fix anything." is gone. The agent may fix
  what the filer may do, ONLY via act_as_filer, after a tenant owner notice, checking get_owner_notices before each
  further change, posting a system notice and reporting (not attempting) anything beyond one company, and verifying
  before calling it fixed; the report must list each write and its status. ⛔ Kept verbatim because
  `stress.test.mjs` E pins them AND the api cannot enforce them: "Do NOT commit, push, or deploy", "never write to the
  PBX", "Never message, email or text a customer", Bash read-only.
- **Caps** (`triage.mjs`): `tenantCap: 10` per company per UTC day, customer lane only, keyed `tenantKeyOf` (tenantId,
  company-name fallback, unknown company never capped); claims now store `tenant`; lane backstop `customerCap` 10 → 50.
  Env: `WATCH_TENANT_CAP`. Run timeout 20 → 30 min.
- **api** `customerUpdate.ts`: `verifiedChangeOnTicket(db, escalationId)` = any `SUPPORT_AGENT_ACT_WRITE` audit row on
  the ticket with `metadata.statusCode` 2xx (audit `sanitizeEventPayload` keeps `statusCode`). Passed to
  `reviewCustomerMessage` as `changeWasMade`, and the rewrite model is told what our records show. Fails closed.
  ⛔ `REWRITE_SYSTEM_PROMPT` deliberately untouched — `customerUpdate.test.ts` pins "INVESTIGATION, not a repair" and
  "NEVER say we fixed it"; the prompt already allows the claim when the input says a change was made.
- ⛔ **`stress.test.mjs` is BINARY to git since `7f73086a`** — it holds literal NUL and RLO bytes as hostile-input
  fixtures. It was left untouched; new watcher tests live in `hands.test.mjs` (package.json test script runs both).
- ⛔⛔ **RESTARTING THE WATCHER: `Stop-ScheduledTask` + `Start-ScheduledTask` did NOT replace the node process** (task
  read Running, Start was a no-op; the old `node watch.mjs` from 2026-09-11 kept running the OLD code). What worked:
  confirm the heartbeat is not `working`, `Stop-Process` the `node … watch.mjs` pid — `run-watcher.cmd` relaunched it
  within seconds — then read `logs/watcher.log` for the new startup line ("customers 10/day per company (backstop 50)
  … timeout 30m"). New pid 9484 started 22:44:35Z.
- ⏳ **To make it live:** `SUPPORT_AGENT_WRITES_ENABLED=1` must reach the api. ⛔ AGENTS.md rule 10 forbids agents
  editing `/opt/connectcomms/env/` — so Izzy sets it, or a code change flips the default. Until then every act_as_filer
  write answers `writes_disabled` and the agent reports instead.
- ⏳ Not proven: no ticket has run with the new tools; no owner notice texted; no real STOP/GO.

## 8. Incident found during the watcher restart: Izzy's office IP auto-banned by nginx (2026-09-14 22:29:11Z)

- `50.48.58.53` (Izzy's office) in `/etc/nginx/connectcomms/denylist.json`: reason **"req/min>600, 404>60/5m"**,
  req5m 670, s404 74, expires **23:29:11Z** (60-min TTL). Every request 403s on both hostnames — portal, desktop app,
  Coworker link, and the watcher (poll_failed from 22:37Z).
- **Cause: an open Deploy Center tab** (`app.loopcom.net/admin/deploy-center`) polling
  `/api/admin/deploy/jobs/10fee31a-fd98-45b7-9071-0e856e6bb7e5/log?lines=200` (portal job, branch
  `codex/profile-menu`): 96 × 404 with no backoff, and still polling (245 × 403) after the ban. NOT the session's curl
  probes — 4 × 401 on api paths, which `monitor.sh` deliberately does not count.
- Unblock (a person's job — rule 10): close that tab first or it re-bans; then wait for expiry or run
  `/opt/connectcomms/scripts/unblock_ip.sh 50.48.58.53` once the 5-minute window is clean. Trust's office
  `66.250.99.208` was unaffected (200s). Follow-up task filed: make Deploy Center stop polling a 404 job log.


## 9. Phase 3 — the agent can ship a CODE fix after the owner's GO (`8bce4506`, 2026-09-15)

Izzy, 2026-09-15: "Should be able to commit and deploy as well. It's the same agent in Claude, right?" Verified: yes -
the watcher's run transcript lives in the same Claude project folder, so the same CLAUDE.md, memory and repo. What differs
is that nobody watches the run, a stranger's ticket starts it, and the main folder is shared. So the model still never
holds git or deploy powers; `tools/loopcom-support-mcp/ship.mjs` does it, deterministically.

- **Agent side (MCP tools):** `stage_edit` (one exact match, CRLF-aware, control characters refused), `stage_new_file`
  (never overwrites), `request_ship` (commit by pathspec in the worktree; nothing pushed; 3 per UTC day),
  `get_ship_status`. Writes go ONLY to `.claude/worktrees/support-ship-<ref>` (a detached `git worktree add` of the
  branch, ignored via `.git/info/exclude`) and ONLY under apps/api/src, apps/portal (app, components, lib, navigation,
  services, hooks, contexts) and packages/shared/src. Always refused: the agent's own gate files (actAsFilerRoutes.ts,
  supportAgentNotice.ts, customerUpdate.ts, customerUpdateSafety.ts, agentFixByText.ts), .env, .connect-ssh, prisma and
  migrations, package.json, pnpm-lock, tsconfig, Docker files, .github, node_modules.
- **Why MCP tools and not Claude's Edit tool** (checked against the Claude Code docs): a path-scoped allow cannot beat a
  deny on the main folder (deny wins), Edit/Write denies do not stop Bash or other programs from writing, and memory is
  keyed on the git repository so worktrees share it anyway. Our own code enforcing the paths is the real boundary.
- **Worktree packages:** the main folder's `node_modules/@connect/*` are symlinks to the MAIN folder's packages, so tests in
  a worktree would import other sessions' uncommitted `packages/shared`. `linkWorkspacePackages` creates junctions
  `<worktree>/node_modules/@connect/<pkg>` pointing at the worktree's own package; third-party deps still resolve from
  the main install (shamefully-hoist).
- **Watcher side, one step per poll (`processShips`):** submitted -> `npm run test` + `npm run typecheck` in each touched
  package (via `cmd.exe /d /s /c` with a fixed command string); pass = tests green and no TS errors in the changed files ->
  `post_owner_notice` scope system with a summary naming the commit, services and files. Fail -> owner told, never asked
  for GO. awaiting_go -> STOP or expiry discards the worktree; GO -> `shipEntry`.
- **shipEntry:** HEAD must equal the approved sha and the worktree must be clean; fetch + rebase onto the tip (conflict ->
  abort, owner told), re-run checks if the commit moved; push `HEAD:refs/heads/feat/ivr-migration-takeover` (never forced;
  non-fast-forward retried 3 times); then per service an ssh `bash -s` script on loopcom: wait until no heavy job
  (bracketed ps patterns) and runningCount 0, enqueue by BRANCH (never commitHash), poll the job to a terminal status, read
  `.build-commit`, `git merge-base --is-ancestor`, health via `--resolve <host>:443:127.0.0.1` on both hostnames plus the
  portal root. A HEAVY JOB collision is waited out and retried (3 times). Not verified -> check out the tip, `git revert`,
  push, redeploy, owner told "ROLLED BACK"; if that fails too -> "URGENT ... needs a person". A ship interrupted by a
  watcher restart is marked `interrupted` and NEVER resumed. Staged-but-never-submitted worktrees are discarded after 6 h.
- **api:** `POST /admin/support/escalations/:ref/owner-update {message}` texts the owner's numbers (SUPER_ADMIN, 12 per
  ticket per UTC day, owner only, never the customer). Used for every ship outcome.
- **SSH from the watcher:** Git's `C:/Program Files/Git/usr/bin/ssh.exe` is preferred - Windows OpenSSH warned "Bad
  permissions" on the repo key (it still connected, but do not depend on it).
- **Tests:** `ship.test.mjs` (fake exec: path allowlist, services and packages, control bytes, exact-match + CRLF staging,
  commit by pathspec with no push, daily cap, GO decisions, notice text, result parsing + verdict, approved-commit binding,
  dirty worktree, rebase conflict, rollback, heavy-job retry, checks-failed never asks GO, interrupted never resumes,
  source guards: no shell:true / force / add-all / commitHash) and the owner-update route tests. Watcher suite 94/94, api
  support 129/129. api tsc 85 = the 84 baseline + 1 from another session's `7f2e9557` (globalSearchCallScope.test.ts).
- **Deployed:** api job `b91dfd96` -> container `8bce4506`, restarts 0, healthy, owner-update route present, health 200 on
  both hostnames. Watcher restarted (pid 17812) and polling 30 tickets (office IP no longer banned).
- **Found while documenting:** THIS handoff had gone BINARY - section 4 quoted the phase-1 regex and the Write tool decoded
  its backslash-u escapes into two real control bytes, so git stored the doc as binary from `fd68d4c5`. Repaired
  2026-09-15 (the bytes are now the text `u0000`/`u001f` after a backslash); the consolidated memory `support-watcher.md`
  had the same two bytes and was repaired too. Scan EVERY tool-written file, docs included.
- NOT PROVEN: no ticket has staged, been approved or shipped through this; no rollback has run for real. The first real
  use should be watched: expect a GO text naming a commit, then "Shipped ... verified" or "ROLLED BACK".
