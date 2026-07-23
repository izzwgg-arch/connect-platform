# X1 — Modify Executor (Connect-side infrastructure) — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` (ground rules 1–10 apply) · Status: **AWAITING SIGN-OFF — no code until approved**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. Purpose

The machinery every Group-1/2/4 capability runs through: snapshot-before-write,
Izzy-bound approval tokens, verify-after-write with auto-revert, one-click revert,
and rate fencing. X1 is **pure loopcom code with an EMPTY capability catalog** —
after X1 ships, the agent can not do one single new thing. It only becomes usable
when M1 (its own spec, its own certification) registers the first catalog entry.

**X1 involves ZERO PBX contact — in code, in tests, and in certification.**

## 2. Non-goals

- No capability enabled, no PBX client wired for live mode, no helper scripts.
- No changes to the existing additive `ScopedPbxExecutor` (P-series) or A-series
  backends — they keep working exactly as today.

## 3. Design

### 3.1 New files (all under `apps/agent/src/`)

| File | Contents |
|---|---|
| `pbx/modifyCatalog.ts` | `MODIFY_CATALOG: Record<string, ModifyOp>` — **ships empty** (`{}`). A `ModifyOp` declares: id (`M1`…), kind, zod schema, `feasibility`, `snapshot(readClient, params)` fn, `dispatch` descriptor, `verify(readClient, params, snapshot)` fn, `revert` descriptor. |
| `pbx/modifyExecutor.ts` | `ModifyPbxExecutor` — the gate chain (§3.3). Client factories injected; **X1 wiring registers only the simulate factory.** |
| `pbx/snapshotStore.ts` | Thin typed wrapper over the new `AgentPbxSnapshot` model: `capture()`, `get()`, `markRestored()`, integrity checksum (sha256 of canonical JSON). |
| `actions/bindings.ts` | Params-hash binding for approvals (§3.4). |

### 3.2 DB migration (additive only — no existing row/column touched)

- **New model `AgentPbxSnapshot`**: `id, actionId (unique), capabilityId, tenantId,
  objectType, objectId, stateJson (Json), checksum, source ("helper"|"api"|"astdb"),
  capturedAt, restoredAt?, expiresAt` + indexes on `(tenantId, objectType, objectId)`
  and `(expiresAt)`.
- **`AgentAction` additive columns**: `paramsHash String?`, `approvalConsumedAt DateTime?`.
- Migration is `CREATE TABLE` + `ADD COLUMN` (nullable) only → zero-downtime, no
  rewrite of existing rows, existing A/P flows unaffected.

### 3.3 Gate chain (ordered; every refusal is an audit row; superset of the P-series gates)

```
G0  kill switch off?                         (existing owner.kill_switch)
G1  capability in MODIFY_CATALOG?            (empty in X1 → everything refuses)
G2  zod schema valid?
G3  SCOPE FENCE — object belongs to the requesting tenant, proven against the
    Connect DB mirror (never trusts LLM/params); customer role → own tenant only
G4  RATE FENCE — per-tenant max pending modify actions (default 3) and a GLOBAL
    live-writes/hour cap (default 10, env AGENT_PBX_LIVE_WRITES_PER_HOUR)
G5  protected-extension list (AGENT_PBX_PROTECTED_EXTS, default "101")
G6  LIVE TENANT FENCE — AGENT_PBX_LIVE_TENANTS allow-list, fail-closed (empty =
    no live writes anywhere). During every capability's live-cert this is "21" only.
G7  feasibility — live dispatch only for ops whose real path is proven ("api",
    "helper", "astdb"); "db" is never live-dispatchable
G8  IZZY APPROVAL — action status APPROVED + params-hash binding verified (§3.4)
    + approvalConsumedAt null (single-use; set atomically at execution start)
G9  SNAPSHOT — op's snapshot() must return the full current state; store it with
    checksum. Snapshot failure = hard refuse (never "write anyway")
G10 DISPATCH — via injected client factory (simulate factory only, in X1)
G11 VERIFY — re-read the object, diff against intent. Mismatch → automatic revert
    from snapshot + owner alert + action → FAILED
```

### 3.4 Approval binding (closes the approve-then-mutate hole)

- At action **creation**: `paramsHash = sha256(capabilityId | tenantId | objectId |
  canonicalJson(params))` stored on the row; params are FROZEN (no update path exists).
- Approval token becomes HMAC over `{actionId, decision, exp, paramsHash}`
  (backward-compatible: old-format tokens remain valid for A/P actions only).
- At **execution**: recompute the hash from the row and require equality with the
  token's hash AND `approvalConsumedAt == null`; then set `approvalConsumedAt` in
  the same compare-and-set transition `APPROVED → EXECUTING`. A token can therefore
  approve exactly one execution of exactly the change Izzy saw.
- **Auto-approve is structurally disabled** for capability prefixes `pbx.M`,
  `pbx.E`, `repair.` in `ActionService.create` — even `requestedRole: "owner"`
  goes through the pending-approval email/portal flow.

### 3.5 Revert

- Every EXECUTED modify action exposes `revert(actionId)` for
  `AGENT_MODIFY_REVERT_DAYS` (default 7): restores from the checksummed snapshot
  through the same gate chain (its own audit trail, its own dispatch+verify),
  surfaced on the portal Approvals page.
- Three-way-diff rule: if the object's CURRENT state differs from what our write
  left behind (someone edited it in the GUI since), revert REFUSES and alerts
  instead of blindly overwriting.

### 3.6 Config flags (all fail-closed defaults)

| Env | Default | Meaning |
|---|---|---|
| `AGENT_MODIFY_ENABLED` | `0` | Master switch for the whole modify pipeline |
| `AGENT_PBX_LIVE_TENANTS` | unset (= none) | Live tenant allow-list (existing flag, reused) |
| `AGENT_PBX_LIVE_WRITES_PER_HOUR` | `10` | Global live-write budget |
| `AGENT_MODIFY_MAX_PENDING_PER_TENANT` | `3` | Pending-approval cap |
| `AGENT_MODIFY_REVERT_DAYS` | `7` | One-click revert window |

## 4. SEBA — Side-Effect & Blast-Radius Analysis

**(a) Everything X1 touches:** loopcom Postgres (`AgentPbxSnapshot` new table;
two nullable columns on `AgentAction`), the agent service's code, the capability
manifest (new empty section). Nothing else. **No PBX host, no AstDB, no ombutel
DB, no helper, no AMI/ARI — X1 contains no code path that can open a connection
to the PBX** (live client factory is not registered; grep-provable in review).

**(b) Other readers of the touched locations:** `AgentAction` is read by
`ActionService`, the portal Approvals page, and the auto-revert scheduler. Both
new columns are nullable and ignored by existing code paths; existing P/A actions
have `paramsHash = null` and are validated exactly as before (binding is enforced
only for `pbx.M*/pbx.E*/repair.*`). Token verification stays backward-compatible.

**(c) Calls in flight:** N/A — no telephony contact of any kind.

**(d) Dies halfway:** every transition is a DB compare-and-set; a crash leaves an
action in DRAFT/PENDING_APPROVAL/EXECUTING with full audit, and EXECUTING rows
with no dispatch confirmation are flagged `outcome UNKNOWN` for owner review on
restart. No retry-blind. Since X1 has no live dispatch, the worst crash outcome
is a stale DB row.

**(e) Fan-out proof:** the executor operates on exactly one (tenantId, objectId)
per action, both frozen into `paramsHash` at creation; there is no list/bulk op in
the catalog schema type (single-object contract), and G3/G6 pin the tenant.

**Deploy:** normal deploy-queue release of the agent service; additive Prisma
migration; instant rollback = previous image (new table simply unused).

## 5. Test plan (all gates must be green before X1 is checked off)

- **UNIT** — every gate's refusal path; token tamper matrix (wrong hash, expired,
  reused, cross-action, old-format token against a modify capability); snapshot
  checksum corruption detected; verify-mismatch triggers auto-revert (fake client);
  three-way-diff revert refusal; auto-approve attempted for `pbx.M*` as owner → still pending.
- **SIM-CERT** — certification harness extended: with an empty catalog, EVERY
  dispatch attempt refuses at G1 (proves fail-closed shipping state); with a
  test-only fixture op registered, the full G0–G11 happy path + revert runs in simulate.
- **RED-TEAM** — approve-then-mutate replay, double-execute race on one approval
  (two workers, one must lose the CAS), wrong-tenant object ids, protected-ext
  probe, kill-switch mid-flight, rate-cap exhaustion behavior (typed denial, no drop).
- **STRESS** — 200 concurrent action creations on one tenant (cap holds, no
  deadlocks); 50 concurrent snapshot captures; clock-skew/expiry edge (token
  expiring between approve and execute → clean refuse); DB latency injection.
- **LIVE-CERT / REVERT-DRILL** — trivially N/A-by-design for X1 (no live surface);
  recorded as such with the sim evidence attached.

## 6. Acceptance criteria

- [ ] All §5 suites green in CI
- [ ] Grep-proof in review: no PBX client import in the X1 wiring
- [ ] Existing P-series certification + A-series tests still green (no regression)
- [ ] Manifest shows modify pipeline present with 0 enabled capabilities
- [ ] Izzy checks X1 off in `ACTIONS_V2_ROADMAP.md`

## 7. Decisions Izzy makes on this spec

1. Revert window default **7 days** — OK?
2. Global live-write budget default **10/hour** — OK?
3. Approval channel stays **email + portal Approvals page** for every live write
   (roadmap open question 1) — OK for M1, or add SMS/push first?
