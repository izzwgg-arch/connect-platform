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
