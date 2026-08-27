# PLAN — a Claude agent that opens on each support ticket (2026-08-27)

**Status: SCOPE ONLY. Nothing built, nothing deployed, no code changed.**
Izzy, 2026-08-27: *"every time a support comes in through LoopCom support chat,
it would kick off an agent automatically that would take care of it"*, then
*"all agents should open up in this project and follow the project rules"*, and
on self-approval: *"I trust Claude enough by now to approve its own work, most
of it, but it would always be watched by a human."*

## 0. The correction that shapes everything else

An MCP server cannot be the trigger. MCP is pull-only: a client connects and
calls tools; nothing in the protocol wakes an idle agent. The trigger must be
something on LoopCom's side that STARTS an agent process. An MCP server is only
useful afterwards, as packaging for tools that already exist in `apps/agent`.

## 1. Most of this already runs

`EscalationService.research()` (`apps/agent/src/escalation/escalations.ts`)
already fires an LLM run with tools the moment a support chat produces an
escalation — `completeWithTools` on the `diagnostics` route, read-only
tenant-bound tools — and drafts ISSUE / FINDINGS / PROPOSED FIX. The api's
30-second sweeper (`agentEscalationDispatch.ts`) then texts Izzy, and where the
request maps to a safe capability `offerFixCode` attaches a one-time code so a
reply of `FIX <code>` executes it.

**The `AgentEscalation` row IS the ticket; its id is the reference to hand over.**

What is missing is not the trigger. It is that the researcher is read-only,
tenant-scoped, one-shot, and has no hands — it cannot read the repo, run a
command, or look at a live page.

## 2. Measured facts (loopcom, 2026-08-27)

- **Claude Code is NOT installed.** `which claude` → nothing. Node is v20.20.0
  (fine), 345 GB free.
- An `ANTHROPIC_API_KEY` already exists in `app-agent-1`, so a billing line
  exists. A SEPARATE key for ticket runs is still worth it, purely so the spend
  is attributable rather than mixed into chat.
- **`CLAUDE.md` is 1,219,928 bytes / 15,843 lines ≈ 305,000 tokens**, plus 172
  handoffs totalling 4.4 MB under `docs/ai-context/`. That is the rules load,
  per ticket. Prompt caching is not an optimisation here — it is the only thing
  that makes it affordable, and it means the ticket agent must reuse a STABLE
  prefix. A rules file rebuilt per run defeats the cache.

## 3. ⛔⛔ THE FINDING: three project rules are unsafe unattended

"Follow the project rules" is the right instinct — the rules that hold in this
codebase are the ones written down, and CLAUDE.md is where they are. But three
of them are written for a SUPERVISED session and are actively dangerous when
nobody is watching the keyboard:

1. **"every finished task ends: commit → push → deploy."** An unattended agent
   following this literally **ships code to production at the end of a support
   ticket.**
2. **"END of every task — UPDATE THE MD FILES, AUTOMATICALLY."** It would append
   to a 1.2 MB CLAUDE.md that live parallel sessions are also editing. The
   shared-worktree commit hazard is the single most-documented trap in this
   repo, and an unattended committer is precisely its shape.
3. **"THE WORK TREE MUST BE EMPTY BY THE END OF THE DAY."** CLAUDE.md itself
   warns that clearing the tree is a triage, never `git add -A`, and that a
   worktree file can be OLDER than HEAD. Done unattended, this reverts live work.

✅ **The fix: keep CLAUDE.md's SAFETY rules, replace its WORKFLOW rules.** A
scoped `CLAUDE.support-agent.md`, read INSTEAD of the ending rules, whose own
first line is: never commit, never push, never deploy, never edit a tracked file.

## 4. ⛔ It must not run in `/opt/connectcomms/app`

Deploys hard-reset that clone, so an agent working there loses its work
mid-ticket; and an untracked file there blocks the next deploy's
`git checkout -B`. It already carries three untracked files today
(`HANDOFF.md`, `HANDOFF-webrtc-ringtone-2026-07-22.md`,
`ops/deploy-queue/var/`). The ticket agent needs its own clone.

## 5. Build order

**Phase 0 — prove the undo.** Does `grant_permission` actually revert?
`resultSnapshot` / `revertOfId` / `revertAt` are in the schema; whether the path
works has never been exercised. **Auto-approval is safe exactly in proportion to
how good the undo is.** Nothing else starts until this passes.

**Phase 1 — the runner.** A sweeper in the **api**, not the agent container (the
agent is a manual rebuild and in no deploy queue — which is why the escalation
dispatcher already lives in the api). Atomic claim (`updateMany` guarded on a
null column, the pattern used everywhere here) so one ticket can never be picked
up twice; a daily ceiling like the 40/day SMS cap; an env kill switch.

**Phase 2 — the session.** Claude Code headless on loopcom, cwd = its own clone,
handed the escalation id and nothing else. Reads the scoped rules file.

**Phase 3 — auto-approval.** A third credential kind on `applyConfirmedAction`
— it REPLACES the credential and skips no gate, exactly as the SMS one-time code
already does (capability authorisation, tenant scoping, params hash, atomic
single-use claim, audit all run identically). **No second apply path.**
Auto: `grant_permission` (transactional, pure DB), `enable_sms` (one reversible
flag). Not auto: `add_extension` (Izzy's call). **Never** `add_phone_number` —
real money at VoIP.ms, `transactional: false`, and a number cannot be un-bought.

## 6. What "watched by a human" has to mean mechanically

Watched-AFTER only survives if undo works (§5 Phase 0). Then: it texts what it
**did**, not what it wants to do, with a one-word undo; applied actions already
surface on the support desk; and the caps are code, not instructions.

⛔ The remaining exposure, stated plainly and not as an objection: the ticket
text is written by a customer, so auto-approval means a stranger's words can
cause a write. That is not a question about trusting Claude's judgment — it is
that the input is not from us. It is bounded by the four capabilities being the
only writes that exist, and by the undo.

## 7. Open decisions (Izzy's)

- Where runs live: a second clone on loopcom, or a git worktree.
- May it write files at all, or read-only + propose?
- The daily ceiling. Volume is **7 escalations in 30 days (~2/week)**, so 5/day
  is generous.

---

# Round 2 (same day) — the cloud half, and where the MCP finally belongs

Izzy: *"we should be able to do it in the cloud as well"*, and then
*"I want to make it so it syncs. I should be able to enable in the MCP if I
should see live the technical support come in locally or not."*

## 8. ⛔ CORRECTION to §2 — I was wrong about prompt caching

§2 said caching is "what makes it affordable". That is true **within one
ticket's run** and false **across tickets**. Cache TTL is **5 minutes by
default, 1 hour maximum**. Tickets arrive ~2 a week, so the cache is always
cold when a ticket starts — every ticket pays a fresh cache WRITE (~1.25×), not
a read.

Corrected shape, at Opus 5 input $5.00/MTok:

- turn 1 of a run: ~305k tokens written to cache ≈ **$1.90**
- every turn after, within the run (seconds apart, cache warm): ~0.1× ≈ **$0.15**
- a 20-turn run ≈ **$5 in input**, plus output

So ~$5–10 a ticket, and at 2/week that is noise. **Caching still matters — it
is what stops a 20-turn run costing $30 — but it never amortises across
tickets.** Do not plan as if it does.

## 9. ✅ The better answer to the size problem: don't carry the rules, READ them

At 1.2 MB, CLAUDE.md should not be a prompt the agent carries — it should be a
file the agent opens. That is literally what the project rule already says
("READ THE MD FILES FIRST"). So the ticket agent gets a SHORT scoped rules file
(one page) that points at the CLAUDE.md sections and handoffs worth reading for
this ticket, and reads them on demand. Cheaper, and it is the behaviour the
repo already asks for.

## 10. The cloud shape: Managed Agents

Four ways to build an agent; only one supplies BOTH the harness and the
deployment:

| Approach | Harness | Deployment |
|---|---|---|
| Claude API manual loop | you | you |
| Tool Runner | SDK | you |
| **Managed Agents (CMA)** | **Anthropic** | **Anthropic** |
| Claude Agent SDK | SDK (Claude Code harness) | you |

So: **cloud = Managed Agents. On loopcom = Claude Agent SDK.** Same ticket
queue, two workers.

**And this is the trigger, plainly:** the flow is `POST /v1/agents` **once**
(model, system, tools, mcp_servers, skills live here) and `POST /v1/sessions`
**per run** (a pointer to the agent id — nothing else). **`sessions.create` IS
"kick off an agent."** That is the call LoopCom's sweeper fires with the
escalation id. There is no MCP in that sentence.

⛔ Pitfalls that would cost a day each: the agent is created **once** and
versioned (`POST /v1/agents/{id}` bumps a version; sessions pin to one) — never
`agents.create()` in the hot path; `model`/`system`/`tools` on a session body is
rejected; archiving is **permanent, no unarchive**.

### Two CMA features that directly answer the risks in §5–§6

- **Session budgets** — a hard, dollar-denominated cap on one session, enforced
  by the platform. It pauses at `stop_reason: budget_reached`. That is a better
  runaway guard than anything we would write, and it is a platform primitive.
- **Vault `environment_variable` credentials** — secrets stored by Anthropic and
  **substituted at egress, never visible in the sandbox.** Given that the ticket
  text is customer-written (§6), a secret the sandbox cannot read is a secret a
  prompt-injection attempt cannot exfiltrate. MCP auth goes through vaults too;
  the agent's `mcp_servers` array carries `{type, name, url}` and no auth.

## 11. ✅ WHERE THE MCP ACTUALLY BELONGS — the local/live switch

Izzy's newest ask is the first thing in this conversation that MCP is genuinely
the right tool for. It is not the trigger; it is the **view and control surface**
his own Claude Code attaches to.

Tools the LoopCom MCP server exposes: `list_tickets`, `get_ticket`,
`claim_ticket`, `get_routing_mode`, `set_routing_mode`.

Remote MCP is supported by URL, so it can be hosted next to the api and used by
both the cloud agent and his local session. ⛔ **The MCP connector needs BOTH
halves** — `mcp_servers=[{type:"url", url, name}]` **and**
`tools=[{type:"mcp_toolset", mcp_server_name:<same name>}]`, with beta
`mcp-client-2025-11-20`. Declaring only the server is a validation error.

### ⛔⛔ The sync rule: ONE queue, ONE atomic claim, never two workers

`routing_mode` is `cloud` | `local` | `both`, and it must be **enforced
server-side in the claim**, never as a local preference. The cloud sweeper's
atomic claim (`updateMany` guarded on a null column) reads the mode before it
claims: in `local` mode it does not claim at all and the ticket sits for his
session to pick up through the MCP; in `both` it claims only what a local
session has not.

If the flag lives on the client, a ticket gets worked twice — by the cloud agent
and by him — and with auto-approval on (§5 Phase 3) that means two grants, two
extensions, or two of anything else. **The flag IS the claim, or it is nothing.**

⛔ "Live" is still pull: MCP clients poll, servers do not push into a local
Claude Code session. So local-live means his session polls the MCP on a loop.
That is fine — it just must not be described as a push.

## 12. Revised build order

Unchanged: **Phase 0 is still proving the revert.** Then:

1. `routing_mode` + the atomic claim in the api (the sync rule, §11).
2. The LoopCom MCP server — read tools + the routing switch. Useful on its own:
   it gives him a live ticket view from his own Claude before any agent runs.
3. The cloud worker: one CMA agent config (versioned, created once), a session
   per ticket, session budget set, vault credentials, repo mounted, short scoped
   rules file.
4. Auto-approval (§5 Phase 3) last — after the revert is proven.

Step 2 is worth doing even if he never turns the automation on.
