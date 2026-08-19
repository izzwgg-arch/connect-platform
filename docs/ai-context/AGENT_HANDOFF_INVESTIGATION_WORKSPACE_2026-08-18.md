# AGENT HANDOFF — the assistant gets a read-only workspace on BOTH servers, and must cite its evidence (2026-08-18)

Commit `0ab965be` on `feat/ivr-migration-takeover`. **Pushed. ⛔ NOT DEPLOYED —
see §7.** No migration, no PBX write, no env change, no tenant row touched.

Izzy, 2026-08-18: *"I was told that the agent can actually work just like you as
an IDE in the server and repair and diagnose stuff. I don't have to trade every
single scenario, that will take a lifetime… so how can we make this efficient?"*

He is right, and the previous design did not deliver it. This is stage 1 and 2
of the answer.

---

## 1. The insight this is built on

Everything the 2026-08-18 Trimpro investigation needed was **read-only**:

```
pjsip show endpoint T11_109
mysql -e "select ... from ombutel.ombu_extensions where tenant_id=11"
grep "Custom Application: Closet" /var/log/asterisk/full
select count(*) from "Voicemail" where "tenantId" = ...
```

None of it needed a pre-built capability. **Diagnosis is generic** — the same
five verbs (query, count, list, describe, compare) pointed somewhere new. Only
**repair** is scenario-specific. So the two halves are separated: the diagnose
half gets a real workspace and carries almost no risk; the repair half stays on
a short leash (see §8).

⛔ This is why "I have to pre-build every scenario" was the wrong frame. You
never had to. The agent simply had 10 hardcoded questions instead of the ability
to ask its own.

## 2. What shipped

**`POST /internal/agent/investigate`** — one door, two servers:

| `source` | Reaches | Read-only because |
| --- | --- | --- |
| `"connect"` | Connect's Postgres on loopcom | runs inside a **READ ONLY transaction** with a `statement_timeout` |
| `"pbx"` | the PBX's MySQL (`ombutel`, `asterisk`) | the credential is **`connect_read`**, which holds SELECT and nothing else |

Body: `{ tenantId, source, sql, limit?, purpose? }`. Answers rows plus
`executed`, `rowCount`, `truncated`, `elapsedMs`.

**Files** (`apps/api/src/agentInvestigation/`):
- `readOnlySql.ts` — the guard: scrubber, validator, row-cap wrapper
- `investigationRunner.ts` — executes against either server
- `evidence.ts` — the citation rule
- `investigationRoute.ts` — the door
- three test files

## 3. ⛔ Three enforcement layers, and none of them is "the model was told not to"

1. **`validateReadOnlySql`** — a single statement, opening SELECT/WITH/SHOW/
   DESCRIBE/EXPLAIN, no DDL/DML keyword anywhere, no filesystem/network/CPU
   functions (`pg_read_file`, `dblink`, `load_file`, `benchmark`, `pg_sleep`…).
2. **Postgres READ ONLY transaction** — the SERVER refuses a write even if
   layer 1 were bypassed. ⛔ `prisma` is the ordinary application client and it
   **has write rights** — that is exactly why the transaction is opened READ
   ONLY rather than trusting the text guard.
3. **`connect_read`** — the GRANT refuses a write on the PBX even if layers 1
   and 2 were bypassed.

⛔ **The text guard is the braces, not the belt.** Parsing SQL with regexes is a
losing game. If you ever relax `readOnlySql.ts` "because the database will catch
it", that instinct is right — but keep both layers, because the day someone
points this at a connection with write rights, that file is what is left.

⛔ **Comments and literals are SCRUBBED before keyword matching** (line
comments, block comments, quoted strings with doubled/backslash escapes,
backticks, and **Postgres dollar-quoting** — the one people forget). Without it,
`select * from t where note = 'we should DROP this later'` is a false refusal,
and a keyword hidden in a comment can shape what a naive matcher sees.

⛔ **The row cap is applied at the DATABASE, by wrapping the query as a
subquery** — not by appending `LIMIT n`. Appending has to understand UNION,
ORDER BY, existing LIMITs and subqueries, i.e. it has to parse SQL, which is
what this module refuses to rely on. Capping in JS is too late: an unbounded
read of `ConnectCdr` (126k+ rows) streams into the api's memory before any JS
sees it.

## 4. ⛔⛔ The evidence rule — why it exists and what it does

The Trimpro escalation of 2026-08-18 stated, in the same confident voice as its
correct findings:

- *"Ext 101's mailbox is near its 9,999-message limit."* — it holds **47**.
  **9,432 is GESHEFT's** mailbox.
- *"This account has no billing settings row at all."* — the row **exists**,
  with **three invoices** issued against it. That phrase is the documented fact
  about **inii mini**, near-verbatim.

Both are other companies' facts restated as this one's. Nothing in the report
distinguished them from the findings it had genuinely measured, **because prose
carries no provenance.**

**The rule:** a finding may only be presented as a finding if it cites a query
that really ran and really returned. There is no query that returns "near the
9,999 limit" for Trimpro, and none that returns "no billing settings row" for a
tenant with three invoices — **so both claims fail automatically, without anyone
having to anticipate them.**

⛔ **Uncited claims are RELABELLED, never deleted.** They move under
`NOT CHECKED — the assistant believes these but ran no query to confirm them`.
A hunch is often the most valuable line in a report; the damage is done when a
hunch is dressed as a measurement. Deleting would also hide from the reader that
the assistant is guessing, which is the very thing being fixed.

⛔ **A citation to an id that was never recorded counts as UNVERIFIED, and is
reported separately.** A model that learns it must cite evidence can learn to
write `[E7]` without running anything, which would turn the whole mechanism into
decoration.

⛔ **Only successful queries can become evidence.** `EvidenceLog` has no path to
record a failure — "I tried to check and it errored" must never be citable, or a
broken connection becomes a source of confident findings.

## 5. ⛔⛔ NOT tenant-scoped, deliberately

Every other agent door answers one narrow question for one tenant, so it binds
the tenant itself. This one takes an arbitrary read query, and a query cannot be
mechanically confined to a tenant without either parsing SQL (refused, see §3)
or a keyword check that blocks legitimate work — **"is this happening to anyone
else?" is a question a diagnostician must be able to ask.**

So instead: the door needs the internal secret (agent service only, never a
customer); the tools that call it are `minRole: "internal"`; and **every call is
audited** — `investigation.query` / `investigation.refused` in `AgentAuditLog`
with the claimed tenant, the exact statement and the purpose. A refused query is
the most interesting row in that table: it is the model trying to do something
it is not allowed to do.

⛔ **Do NOT expose this to `minRole: "customer"`.** The entire tenant-isolation
design of `toolRegistry.ts` rests on the model never choosing its own scope, and
this door hands it exactly that. That design exists because of the 2026-08-02
cross-tenant leak (116 call records filed under the wrong company).

## 6. Tests — 37, and the guards are proven non-vacuous

- `readOnlySql.test.ts` (13) — mostly **bypass attempts**: writes behind
  comments, behind dollar-quoting, behind a second statement; `EXPLAIN ANALYZE`;
  filesystem/network functions; and the inverse, that a keyword inside a
  *literal* is **not** a false refusal.
- `evidence.test.ts` (12) — **the two real Trimpro false claims are regression
  cases**; a fabricated `[E7]` citation is caught; structure is not mistaken for
  a claim.
- `investigationRoute.test.ts` (9) — real Fastify: no secret / wrong secret /
  **unset secret all 403 (fail closed)**; bad body is 400 not 500; the rate
  limiter really fires; five writes are refused **by the guard, before any
  database**; plus source guards that `server.ts` imports **and calls** the
  registrar, that the runner opens a READ ONLY transaction, and that it reuses
  `connectOmbutelMysql` rather than opening its own PBX connection.

✅ **Proven non-vacuous:** replayed against the pre-change tree, the `server.ts`
import guard and call guard both **fail**, and the bypass-list entry has **0**
occurrences in `eeec0002^`. ⛔ All source reads normalise CRLF.

apps/api typecheck **75 errors = the exact baseline**, none in a new file.

## 7. ⏳ NOT DEPLOYED, and NOT PROVEN

**Nothing calls this door yet.** The agent-side tools are the next piece (§8),
so in production the route is inert. It was deliberately not deployed for two
reasons: the feature is incomplete without the agent half, and an api deploy now
would also ship another session's just-committed global rate-limiter change
(`eeec0002`), which is not mine to ship.

**Not proven:** no query has been run through the door against either live
database. The Postgres and MySQL paths are proven by unit test and by matching
the existing, working `connectOmbutelMysql` pattern — **not** by a real round
trip. The acceptance test is §9.

## 8. What is NOT built (the honest list)

- **The agent-side tools.** `apps/agent` needs `investigate_connect` and
  `investigate_pbx` tools (`minRole: "internal"`), the evidence log threaded
  through `escalations.ts`, and `renderFindingsWithEvidenceRule` applied before
  the report is written. ⛔ The agent is a **manual container rebuild** and is in
  no deploy queue.
- **The Asterisk CLI / log / dialplan channel.** `pjsip show endpoint`,
  `dialplan show`, and grepping `/var/log/asterisk/full` were decisive in the
  Trimpro case and are **not** reachable here. They need either an AMI
  passthrough in `apps/telephony` or a new `connect-pbx-helper` endpoint (a PBX
  install — Izzy's mandate). MySQL covers most of the rest: `ombu_extensions`,
  `ombu_devices`, `ombu_custom_applications`, `ombu_custom_destinations`,
  `ombu_inbound_routes`, `asterisk.queues_log`.
- **Stage 3 — the repair door.** One general "run this plan" door behind Izzy's
  approval, on Connect's own admin API, with every route classified
  read / write / destructive. Not started. That classification is the real cost
  and the real risk.
- **Stage 4 — close the loop:** after repairing, re-run the diagnosis and prove
  it worked.
- **The engineering docs as agent knowledge.** ⛔ `CLAUDE.md` and these handoffs
  are full of *other companies'* facts — Gesheft's 9,432 mailbox is in them, and
  that is very likely where the contamination came from. They may go to the
  **internal diagnostician only**, never to customer-facing chat. The
  `audience: "internal"` split already exists in `agentKnowledgeSync`.

## 9. Acceptance test (5 minutes, once the agent half lands)

Re-run the diagnostician against **Trimpro ext 109**, where the true answer is
now known end to end:

- 109 is a **Custom Application "Closet"** → Custom Destination #4 →
  **(845) 251-0972**. It is **not** a phone and consumes **no** extension slot
  (`select count(*) from ombutel.ombu_extensions where tenant_id=11 and
  extension=109` → **0**).
- It **works**: answered calls 17 Aug 10:30 (~8 min) and 18 Aug 11:37 (~2½ min).
- Trimpro ext 101 holds **47** voicemails.
- Trimpro **has** a billing settings row, $27/extension, **3 invoices**.

⛔ **The negative matters most:** the report must contain **no** claim about a
9,999-message limit and **no** claim that billing was never set up — and any
claim it cannot back with a query must appear under **NOT CHECKED**, not among
the findings.
