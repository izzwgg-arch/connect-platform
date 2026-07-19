# Connect AI Agent — PBX Provisioning Capability Plan

_Version 1.0 — 2026-07-19. Owner: Izzy. Author: Claude (Cowork). Companion to PLAN.md (§3, §6, §7) and CAPABILITIES.md._

Goal: give the agent (owner mode) the full range of VitalPBX provisioning powers — **create tenants, extensions, IVRs, inbound/outbound routes, ring groups, time conditions, queues, and more** — while making it **structurally impossible for any of this to alter an existing tenant or an existing call flow.**

This plan does not ship any PBX-write code. It is the design you approve before I build the Scoped PBX Executor. Per your standing rule and mine, no write-capable PBX code is built or deployed until you sign off on §6 (the safety contract).

---

## 1. The core principle: ADDITIVE-ONLY, NEVER MUTATE-IN-PLACE

The single rule that guarantees your live customers are untouched:

> **The agent may CREATE new objects and may only ever modify objects it itself created. It may never UPDATE or DELETE any object that already existed before the agent was given write access — and never any object belonging to a different tenant than the one the operation targets.**

Everything below is enforcement of that rule. The June-2026 incident in AGENTS.md — where an automatic tenant PUT silently wiped inbound DIDs — is exactly what this design makes impossible: no blanket PUTs, no full-resource replaces, no background/automatic writes, ever.

## 2. What "max capabilities" means — the provisioning catalog

Owner-mode PBX write actions (each an entry in the certified manifest, each individually approval-logged):

**Tenant lifecycle**
- P1 Create tenant (new customer onboarding: name, plan, extension limit, settings)
- P2 Add inbound number/DID to a tenant (uses the dedicated `add_inbound_numbers` sub-collection — NEVER a tenant PUT)
- P3 Apply changes / regenerate config for a **newly created** tenant only

**Extensions & devices**
- P4 Create extension (number, display name, voicemail, device profile)
- P5 Create/attach device to an agent-created extension (SIP/WebRTC)
- P6 Set extension features on agent-created extensions (VM, forwarding defaults, CoS)

**Call flow objects**
- P7 Create IVR (menu, prompt, entries → destinations)
- P8 Create inbound route (DID → destination) — additive route, never rebinds an existing DID
- P9 Create outbound route (owner-only, high-risk — extra confirmation)
- P10 Create ring group
- P11 Create queue
- P12 Create time condition / time group
- P13 Create virtual extension / feature code, conference room, parking lot

**Prompts & media**
- P14 Upload IVR prompt audio (ties into Voice Studio A12)

**Reversible operational actions (already in the base catalog A1–A12)** — forwarding, DND, IVR-switch-on-a-route, etc. Those act on live objects and are the temporary/auto-revert class; the provisioning actions above are the create class.

**Explicitly OUT (never, even owner mode):** deleting or editing any pre-existing tenant/extension/route/IVR; global reloads or PBX service restarts; trunk/SIP-transport/network config; anything touching payments or pension; the mutation safeguard itself.

## 3. Architecture — the Scoped PBX Executor

A new isolated module `apps/agent/src/pbx/` — the ONLY code in the whole system that can write to the PBX. Nothing else imports a write-enabled VitalPBX client.

```
 agent action (owner) ─► preflight ─► APPROVAL ─► Scoped Executor ─► VitalPBX v2 API
                            │                          │
                     provenance +               single scoped call,
                     ownership +                writes enabled ONLY
                     tenant-scope               for this one op,
                     checks                     then dropped
                            └────────── audit + ownership ledger ──────────┘
```

- Uses your existing `VitalPbxClient` + `endpointRegistry.ts` (which already flags every `pbxConfigMutation`). The registry is EXTENDED with the create-only provisioning endpoints (extensions/ivrs/inbound_routes/ring_groups/time_conditions) — additively, keeping every existing entry.
- `PBX_ALLOW_CONFIG_MUTATIONS` stays **globally unset**. The executor constructs a client with `allowConfigMutations: true` **per single approved operation**, in-process, then discards it. There is no long-lived write-enabled client and no env flag flipped on any running service.
- The executor refuses any endpoint not on an explicit **provisioning allow-list** (a create-only subset of the registry). PUT/DELETE against pre-existing objects are not on the list and cannot be called.

## 4. The Ownership Ledger — how "only touch what I made" is enforced

New table `AgentPbxObject`: every object the agent creates is recorded — `{ pbxObjectType, pbxObjectId, tenantId, createdByActionId, createdAt, state }`.

- The executor may target an existing object (for a later edit/delete, if ever added) **only if that object's id is in the ledger.** Anything not in the ledger is, by definition, "pre-existing / not ours" → hard refuse.
- Create operations write the new id into the ledger immediately, inside the same audited transaction.
- This is belt-and-suspenders with the additive-only rule: even a future edit capability can physically only reach agent-created objects.

## 5. Zero-impact safety contract (the guarantee you asked for)

Every provisioning action passes ALL of these before execution, or it does not run:

1. **Additive check** — the operation is a CREATE (or an edit whose target id is in the Ownership Ledger). No blanket tenant PUTs. Ever. (Regression test enforces this, mirroring `pbxMutationSafeguard.test.ts`.)
2. **Tenant-scope check** — for a new object under an existing tenant, the operation only adds to that tenant's sub-collections; it never rewrites the tenant resource. New DIDs go through `add_inbound_numbers`, never a tenant PUT (the exact June-2026 failure mode, blocked in code).
3. **Collision check** — new extension number / DID / IVR name doesn't already exist (read-first; abort if taken, never overwrite).
4. **Snapshot** — read and store the relevant current state before the call (for the create class there's nothing to revert, but the snapshot proves what existed and powers verification).
5. **Human approval** — you see the exact object to be created and its full payload, and approve. (Owner mode: your request is the approval, but the diff is still shown and logged.)
6. **Scoped execute** — one API call, writes enabled only for it.
7. **Verify** — read back the created object; confirm it exists and pre-existing objects are byte-for-byte unchanged (re-read a checksum of neighboring config where the API allows).
8. **`apply_changes` only for created tenants** — config regeneration is invoked only against a tenant the agent just created in this same flow, never an established one.
9. **Rollback** — if verify fails, delete the just-created object (it's in the ledger, so deleting it is in-scope) and alert.

**Because every action is create-only and ownership-scoped, an existing tenant's extensions, DIDs, IVRs, routes, and call flows are never read-modified-written. They are physically outside what the executor is allowed to touch.**

## 6. SIGN-OFF GATE (what I need from you before building write code)

I will not build or deploy any PBX-write code until you confirm this contract. Specifically, your "yes" means you approve:

- (a) The additive-only + Ownership-Ledger model in §1, §4, §5.
- (b) `PBX_ALLOW_CONFIG_MUTATIONS` remaining globally unset; writes only via the per-op scoped executor.
- (c) The provisioning catalog in §2 (tell me to add/remove any).
- (d) That the FIRST live write is a **create-tenant on a throwaway test tenant**, validated end-to-end and then deleted, before any real onboarding.
- (e) That destructive edits/deletes of pre-existing objects are permanently out of scope unless you separately, explicitly ask for a specific one.

## 7. Rollout phases (after sign-off)

- **PW-0 Foundation (no PBX contact):** extend `endpointRegistry` with create-only provisioning endpoints; build the Scoped Executor + Ownership Ledger + provisioning allow-list; unit tests + a `pbxAdditiveSafeguard.test.ts` regression proving no PUT/DELETE against non-ledger objects can be dispatched. Runs entirely in **PBX simulation mode**.
- **PW-1 Simulation certification:** full create-tenant / create-extension / create-IVR / create-inbound-route lifecycles against VitalPBX **simulation mode** + failure injection + the zero-impact contract asserted (snapshot of a fixture "existing tenant" is unchanged after each op). Capabilities flip to `certified` only when green.
- **PW-2 Live throwaway-tenant validation (owner-scheduled window):** create a test tenant + extension + IVR + inbound route on the live PBX, verify call flow works, verify a sampled existing tenant's config is byte-identical before/after, then delete the test tenant. You watch it happen.
- **PW-3 Real onboarding, owner-only:** enable create-tenant/extension/IVR for your own use via owner chat ("set up a new tenant Feldman Medical with extensions 101-110 and a holiday IVR") — each step approval-shown, ledger-tracked, emailed.
- **PW-4 (optional, later):** expose a *narrow, curated* slice to customers via policy (e.g. a tenant admin creating an extension within their own tenant, within limits) — only after PW-3 proves out.

## 8. What stays exactly as it is

Existing tenants, extensions, DIDs, IVRs, inbound/outbound routes, ring groups, queues, time conditions, trunks, and every live call path: **read-only to the agent, forever, unless the object is one the agent itself created.** The provisioning power is purely additive. That is the whole point of the design.
