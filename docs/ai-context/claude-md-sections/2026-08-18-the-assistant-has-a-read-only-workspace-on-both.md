# ⛔⛔ AGENT HANDOFF — the assistant has a READ-ONLY WORKSPACE on both servers now, and its findings must cite evidence (2026-08-18) — READ FIRST before adding another `prepare_*` capability, before believing an escalation report, or before giving the agent any write access

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_INVESTIGATION_WORKSPACE_2026-08-18.md`**
(`0ab965be` on `feat/ivr-migration-takeover`. ⛔⛔ **CORRECTED 2026-08-19: it IS
DEPLOYED** — it rode a later api deploy, and the first real queries have now been
run through it against BOTH live databases (403 without the secret, 52 Connect
tenants, 27 PBX tenants, an `UPDATE` refused). **The agent-side tool shipped
2026-08-19 (`95beef53`), so it is no longer true that nothing calls it** — the agent-side tools are unbuilt, so the route is inert
in production. No migration, no PBX write, no env change.)
Izzy, 2026-08-18: *"I don't have to trade every single scenario, that will take
a lifetime… how can we make this efficient?"* He was right; this is the answer.

- ⛔⛔ **THE INSIGHT: you never had to pre-build every scenario. DIAGNOSIS IS
  GENERIC — the same five verbs (query, count, list, describe, compare) pointed
  somewhere new — and only REPAIR is scenario-specific.** Everything the Trimpro
  ext 109 investigation needed was read-only. The old agent had 10 hardcoded
  questions instead of the ability to ask its own; that, not the model, was the
  limit. **api typecheck 75 = the exact baseline; 37 tests; source guards fail
  against the pre-change tree.**
- **What shipped: `POST /internal/agent/investigate`, one door, BOTH servers.**
  `source: "connect"` → Connect's Postgres on loopcom; `source: "pbx"` → the
  PBX's MySQL (`ombutel`, `asterisk`). ⛔ **Three enforcement layers and none of
  them is "the model was told not to":** a text guard that accepts only a single
  read; a Postgres **READ ONLY transaction** with a statement timeout (⛔ `prisma`
  is the ordinary app client and **has write rights** — that is exactly why the
  transaction is opened READ ONLY rather than trusting the guard); and the PBX
  credential **`connect_read`**, which holds SELECT and nothing else.
  ⛔ **The text guard is the BRACES, not the belt** — never let it be the only
  layer. Comments, quoted strings and **Postgres dollar-quoting** are scrubbed
  before any keyword match, and the row cap is applied by **wrapping the query as
  a subquery**, never by appending `LIMIT` (appending has to parse SQL; capping
  in JS is too late — an unbounded `ConnectCdr` read is 126k rows into api memory).
- ⛔⛔ **THE EVIDENCE RULE, and the failure that earned it: a finding may only be
  presented as a finding if it cites a query that really ran.** The Trimpro
  escalation claimed *"ext 101's mailbox is near its 9,999-message limit"* (it
  holds **47**; **9,432 is GESHEFT's**) and *"no billing settings row at all"*
  (the row exists, with **3 invoices**; that phrase is **inii mini's** documented
  fact, near-verbatim) — in the same confident voice as its correct findings,
  because **prose carries no provenance**. No query returns either claim, so both
  now fail automatically without anyone anticipating them. ⛔ **Uncited claims are
  RELABELLED under "NOT CHECKED", never deleted** — a hunch is often the best line
  in a report; the damage is dressing it as a measurement. ⛔ A citation to an id
  that was never recorded counts as UNVERIFIED and is reported, or a model learns
  to write `[E7]` without running anything. ⛔ **Only successful queries can be
  evidence** — there is deliberately no way to record a failure, or a broken
  connection becomes a source of confident findings.
- ⛔⛔ **THE DOOR IS NOT TENANT-SCOPED, DELIBERATELY — do NOT expose it to
  `minRole: "customer"`.** A query cannot be confined to a tenant without parsing
  SQL (refused) or a keyword check that blocks legitimate work — *"is this
  happening to anyone else?"* is a question a diagnostician must be able to ask.
  Mitigated by: internal secret only, `minRole: "internal"` tools only, and
  **every call audited** (`investigation.query` / `investigation.refused` in
  `AgentAuditLog`, with the claimed tenant and the exact statement). The whole
  tenant-isolation design of `toolRegistry.ts` rests on the model never choosing
  its own scope; this door hands it exactly that, which is why it is staff-side.
- ⛔ **It was committed with a PRIVATE INDEX and that was load-bearing.** Another
  session committed `eeec0002` mid-build, **sweeping my `jwtPublicRouteBypass.ts`
  edit into their commit** (both halves landed, verified), and their large
  in-flight `server.ts` work sat in the worktree over a partially-staged index. A
  pathspec commit would have swept it. Recipe: HEAD's `server.ts` + only my 2
  lines → `hash-object` → `GIT_INDEX_FILE` + `read-tree HEAD` + `update-index` →
  `write-tree` / `commit-tree`. ⛔ **And afterwards the shared index read my new
  files as DELETED** (index still held the pre-commit state) — one `git add` of
  **my paths only** fixed it; without that, the next session's broad commit would
  have committed a deletion of the whole feature.
- ⏳ **NOT BUILT, the honest list:** the agent-side tools + threading the evidence
  log through `escalations.ts` (⛔ the agent is a **manual container rebuild**, in
  no deploy queue); the **Asterisk CLI / log / dialplan channel** (`pjsip show
  endpoint`, `dialplan show`, grepping `/var/log/asterisk/full` — decisive in the
  Trimpro case, and reachable only via an AMI passthrough in `apps/telephony` or a
  new helper endpoint = a PBX install); **stage 3, the repair door** (one general
  "run this plan" door behind Izzy's approval, needing every admin route
  classified read/write/destructive — the real cost and the real risk); and
  feeding the **engineering docs** to the internal diagnostician only (⛔ they are
  full of other companies' facts — Gesheft's 9,432 mailbox is in them, and that is
  very likely where the contamination came from).
- ⏳ **NOT PROVEN: no query has been run through the door against either live
  database.** The acceptance test is §9 of the handoff — re-run the diagnostician
  against **Trimpro ext 109**, where the true answer is now known end to end (109
  is a Custom Application → Custom Destination → **(845) 251-0972**, consumes
  **no** extension slot, and **works** — answered calls 17 Aug and 18 Aug).
  ⛔ **The negative matters most:** no claim about a 9,999 mailbox, no claim that
  billing was never set up, and anything unbackable must appear under NOT CHECKED.
