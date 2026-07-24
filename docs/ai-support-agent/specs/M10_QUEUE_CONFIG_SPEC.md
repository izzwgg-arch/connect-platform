# M10 — Queue Configuration Edit — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. What M10 does

Edit an existing **queue's configuration** — ring strategy, ring/agent
timeouts, wrap-up time, max callers, etc. — and revert. NOT the queue's music
(that's M1/X4), NOT creating/deleting queues (P11/create-only).

## 2. Why M10 is safe — the official VitalPBX API (no regen, no helper)

Queues are the ONE object VitalPBX exposes full CRUD for via its official REST
API (`PATCH /api/v2/queues/:id`), confirmed by the PBX audit ("clean, supported,
safe"). VitalPBX handles its own config regeneration internally as part of the
API call — the agent NEVER runs `gen-conf`. Connect already has the client
(`VitalPbxClient.updateQueue`) and the tenant-scoped auth pattern
(`getVitalPbxClient` + `tenantPbxLink`). This is why M10 (API) ships while M8/M9
(ring groups, regen-only) are parked.

## 3. Bounded field allow-list (hardening)

The agent may only patch a fixed ALLOW-LIST of queue fields, each validated:
`strategy` (enum: ringall/leastrecent/fewestcalls/random/rrmemory/linear/
wrandom/rrordered), `timeout` (0–600s), `wrapuptime` (0–600s), `retry` (0–60s),
`maxlen` (0–1000), `ringinuse` (yes/no), `skip_busy`/`answered_elsewhere` (yes/no),
`servicelevel` (0–3600). Anything else is REFUSED — the agent can never send an
arbitrary queue payload. Agent membership add/remove is a distinct future item
(separate validation), not M10 v1.

## 4. Execution path

`apps/api`: internal door `POST /internal/agent/queue/action`
`{ tenantId, action: "list"|"update", queueId?, patch?, agentActionId }`.
Resolves the tenant's PBX instance + vital tenant id + a mutation-enabled
`VitalPbxClient`; for `update` it (a) lists the tenant's queues and confirms
`queueId` is one of them (ownership, belt-and-suspenders with VitalPBX's own
tenant scoping), (b) filters `patch` to the allow-list + validates, (c)
`updateQueue(queueId, patch, vitalTenantId)`. Attribution `agent:<actionId>`.

`apps/agent`: `pbx.M10` op (kind `queue`, feasibility `api`): snapshot the
queue's current allow-listed fields → dispatch update → verify re-read matches →
revert restores the snapshot. Scope fence `queue` = tenant link resolvable
(queue-level ownership enforced in the door + by VitalPBX's tenant-scoped API).

## 5. SEBA

Touches: one queue object on the PBX via the official API (VitalPBX owns the
regen). Other readers: callers in that queue (VitalPBX applies queue param
changes the way a GUI edit does — waiting callers keep their position). Dies
halfway: API error ⇒ verify fails ⇒ auto-revert (updateQueue back to snapshot);
timeout ⇒ outcome UNKNOWN, no blind retry. Fan-out: one queue, tenant-scoped
call; no bulk. **Worst case: one queue runs a wrong (but validated) parameter
until one-click revert.** No config-file regen, no dialplan blast radius.

## 6. Test plan

Unit (op + field allow-list: valid passes, out-of-range/unknown field refused) ·
SIM-CERT (zero-API tripwire; catalog includes M10) · RED-TEAM (approve-then-
mutate patch G8; foreign tenant G3; non-owned queueId refused in door;
arbitrary-field injection refused) · SUPER-STRESS (rapid strategy/timeout swaps
+ volume) · LIVE-CERT on T21 (edit the test queue's strategy/timeout → confirm
via `queue show` + a test call → revert → confirm).

## 7. Decisions Izzy makes

1. Field allow-list (§3) — OK, or trim/extend?
2. Requesters: tenant owner + Izzy — recommended yes.
