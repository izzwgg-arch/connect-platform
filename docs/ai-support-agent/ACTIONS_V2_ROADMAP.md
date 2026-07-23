# AI Agent Actions v2 — Change, Diagnose & Repair Roadmap

_Drafted 2026-07-23. Status: **LIST FOR IZZY'S REVIEW — nothing here is approved for build yet.**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

This is the master checklist for the next capability tier: the agent moving from
"additive-only provisioning + temporary auto-revert actions" (P1–P14, A1–A12) to
**modifying existing customer configuration** and **admin-grade diagnose & repair**.

It builds on, and never bypasses, what already exists:

- `ActionService` approval state machine (`apps/agent/src/actions/service.ts`)
- `ScopedPbxExecutor` + Ownership Ledger (`apps/agent/src/pbx/executor.ts`)
- Capability manifest (`apps/agent/src/manifest/capabilities.json`, human twin `CAPABILITIES.md`)
- PBX feasibility audit (`PBX_AUDIT.md`, 2026-07-19 — VitalPBX 4.5.3, what's API vs helper vs DB-only)
- Existing proven write bridges: **inbound-route helper** (snapshot built in), **connect-prompt-sync**,
  **Connect-managed MOH via AstDB** (`apps/api/src/mohControl.ts` + `publishMohToAstDb`)

---

## 0. Non-negotiable ground rules (apply to EVERY item below)

1. **Nothing is ever written to the PBX without Izzy's explicit approval.**
   Every live PBX write — no matter who requested it (customer, tenant owner, admin,
   watchman, or the agent itself) — requires a per-operation approval from Izzy
   (portal Approvals page or signed approval link). There is no blanket approval,
   no "approved category", no auto-approve for live PBX writes. `ownerConfirmed`
   is per-call and single-use.
2. **Plan → build → test, one capability at a time.** Each item gets its own short
   written spec (exact params, exact PBX touchpoints, exact rollback) approved by
   Izzy BEFORE code is written. No batching.
3. **Simulate-first, always — then T21 only.** Every capability must pass its full
   certification in `simulate` mode before a live attempt is ever made. **Every
   capability's live certification runs exclusively on T21 "Landau Home" (Izzy,
   2026-07-23) — no capability is ever exercised live on any other tenant until it
   has fully passed on T21 and Izzy has signed the rollout.** Protected-extension
   fencing applies on T21 (ext 101 and the `AGENT_PBX_PROTECTED_EXTS` list stay
   untouchable), per `PW2_RUNBOOK.md`. The tenant fence is enforced in code, not
   just process: during a capability's live-cert phase the executor refuses any
   live op whose tenant is not T21.
4. **Snapshot before write, verify after write, revert path required.** A modify
   capability that cannot capture the previous state and restore it does not ship.
5. **Feasibility honesty.** Ops whose real path is "DB+regen" (`feasibility: "db"`)
   are NOT live-dispatchable until a narrow, owner-reviewed helper exists. The
   executor already enforces this (Gate 3b); it stays that way. New helpers are
   installed on the PBX by Izzy manually — the agent never installs its own bridges.
6. **The June-2026 DID-wipe incident is the reference blast radius.** Anything that
   triggers config regeneration (`apply changes` on pre-existing tenants, DB+regen
   paths) is HIGH RISK, windowed, and gets a dedicated rollback drill.
7. **Kill switch and audit** apply to everything; every read, refusal, approval,
   write, verify, and revert is a ledger/audit row.
8. **Customer vs admin scoping.** Customer-facing capabilities operate strictly on
   the requesting tenant's own objects. Admin/repair capabilities are owner-role only.
9. **Build order = list order, start to end** (Izzy, 2026-07-23). Group 1 top to
   bottom, then Group 2, and so on. No jumping around. If work branches off any
   item (a prerequisite, a discovered sub-task, a new helper), it gets its OWN
   prefixed ID (e.g. `H*` for PBX helper scripts, `X*` for infrastructure
   prerequisites), is ADDED to the master list in place, and is tracked to done —
   nothing is ever done "on the side" without a list entry.
10. **Mandatory Side-Effect & Blast-Radius Analysis (SEBA).** Every spec must
   contain a section that answers, exhaustively: (a) every file, DB table, AstDB
   key, and dialplan context the operation touches; (b) every OTHER feature that
   reads those same locations; (c) what happens to calls in flight; (d) what
   happens if the op dies halfway; (e) proof the op is scoped to ONE tenant/object
   and cannot fan out. The SEBA is re-verified against the live PBX (read-only)
   before live-cert, and Izzy signs it separately from the code. No SEBA → no build.

### Lifecycle — every capability is checked off through these gates, in order

```
[ ] SPEC'D        — 1-page spec (params, touchpoints, rollback) approved by Izzy
[ ] BUILT         — code + unit tests merged (feature-flagged off)
[ ] UNIT ✅       — unit suite green, including refusal paths
[ ] SIM-CERT ✅   — full certification harness pass in simulate mode
[ ] RED-TEAM ✅   — approval-bypass / scope-escape / injection attempts all refused
[ ] STRESS ✅     — stress suite green (see per-item stress definition)
[ ] LIVE-CERT ✅  — live run on T21 "Landau Home" ONLY (code-enforced tenant fence), Izzy approving each write
[ ] REVERT-DRILL ✅— live revert exercised and verified
[ ] LIVE          — enabled in manifest for real tenants (Izzy sign-off)
```

No capability starts SPEC'D until the previous one in the build order is LIVE
(or explicitly parked by Izzy).

---

## 1. Master checklist (build order)

Risk: 🟢 low · 🟡 medium · 🔴 high. Path: **AstDB** (Connect-managed, no PBX config touched),
**API** (official VitalPBX v2 API), **Helper** (Connect helper script on the PBX),
**Helper-NEW** (helper must be built + hand-installed first), **DB+regen** (last resort, windowed).

### Group 1 — Customer config changes (modify existing objects) — `pbx.M*`

| # | Capability | Path | Risk | Status |
|---|---|---|---|---|
| M1 | Music-on-hold selection — tenant (incl. ALL queues, per X4) | AstDB + helper | 🟢 | SPEC'D ✅ · BUILT ✅ (internal api door `/internal/agent/moh/override` + `pbx.M1` catalog op + moh_tenant scope mapping; manifest `built`/not-offerable, liveEnabled false) · UNIT ✅ (15 M1 tests + 6 api tests) · SIM-CERT ✅ (39/39 harness incl. 5 M1 cases + zero-api-contact tripwire) · RED-TEAM ✅ (approve-then-mutate G8, foreign tenant G6/G3, foreign/dead profile fences) · STRESS ✅ (25 rapid flips; live budget caps at 10/hr; timeout ⇒ zero retries) · **X4 queue-evidence contract enforced in verify** (missing queue coverage ⇒ auto-revert) — REMAINING: deploy via queue, then LIVE-CERT + REVERT-DRILL on T21 with Izzy approving each write + ear test |
| M2 | Music-on-hold selection — extension | AstDB | 🟢 | ☐ |
| M3 | Inbound route destination change (existing route/DID) | Helper (exists) | 🟡 | ☐ |
| M4 | IVR entry destination change (digit → new destination) | Helper-NEW | 🟡 | ☐ |
| M5 | IVR greeting/recording selection change | Helper (prompt-sync) + Helper-NEW | 🟡 | ☐ |
| M6 | IVR timeout / invalid-input destination change | Helper-NEW (same as M4) | 🟡 | ☐ |
| M7 | Time-condition schedule edit (permanent) | Helper-NEW | 🟡 | ☐ |
| M8 | Ring-group membership edit (permanent) | Helper-NEW | 🟡 | ☐ |
| M9 | Ring-group strategy / ring-time edit | Helper-NEW (same as M8) | 🟡 | ☐ |
| M10 | Queue configuration edit (agents, strategy, timeouts) | API | 🟡 | ☐ |
| M11 | Extension feature edit on PRE-EXISTING extensions (CF/DND/VM on-off, permanent) | Helper-NEW / AstDB where possible | 🟡 | ☐ |
| M12 | Voicemail settings edit (email, attach, delete-after-email, greeting slot) | Helper-NEW | 🟡 | ☐ |
| M13 | Extension caller-ID (name/number) edit | Helper-NEW | 🔴 | ☐ |
| M14 | Apply-changes on a PRE-EXISTING tenant (required to make M4–M13 take effect) | API | 🔴 | ☐ |

### Group 2 — Adds to existing tenants (extend P-series to live) — `pbx.E*`

| # | Capability | Path | Risk | Status |
|---|---|---|---|---|
| E1 | Add extension to an existing tenant | Helper-NEW | 🟡 | ☐ |
| E2 | Add phone number (DID) to an existing tenant | API (`inbound_numbers`) | 🟡 | ☐ |
| E3 | Create inbound route for a NEW DID on an existing tenant | Helper (exists) | 🟡 | ☐ |
| E4 | Add IVR to an existing tenant | Helper-NEW (M4's helper, create mode) | 🟡 | ☐ |
| E5 | Add ring group to an existing tenant | Helper-NEW (M8's helper, create mode) | 🟡 | ☐ |
| E6 | Add queue to an existing tenant | API | 🟢 | ☐ |
| E7 | Add time condition to an existing tenant | Helper-NEW (M7's helper, create mode) | 🟡 | ☐ |
| E8 | Add MOH class / upload MOH audio | Helper (Connect MOH pipeline) | 🟢 | ☐ |
| E9 | Add device to an existing extension | API | 🟡 | ☐ |
| E10 | Upload IVR prompt audio to an existing tenant (Voice Studio) | Helper (prompt-sync) | 🟢 | ☐ |

### Group 3 — Admin deep diagnostics (read-only, no approval, always logged) — `diag.D*`

| # | Capability | Path | Risk | Status |
|---|---|---|---|---|
| D1 | Extension deep-dive (registration history, qualify, codecs, NAT, last calls) | Read | 🟢 | ☐ |
| D2 | Inbound call trace for a DID (route → IVR/TC → destination walk) | Read | 🟢 | ☐ |
| D3 | Trunk health (registration, recent failures, ASR/ACD from CDR) | Read | 🟢 | ☐ |
| D4 | Audio-quality forensics (RTP/RTCP stats, jitter/loss, SIP ALG signatures) | Read | 🟢 | ☐ |
| D5 | PBX system health (services, load, disk, memory, channel count, uptime) | Read (SSH read-only) | 🟢 | ☐ |
| D6 | Security posture read (fail2ban jail list, recent bans, failed registrations) | Read (SSH read-only) | 🟢 | ☐ |
| D7 | Certificate / TLS expiry check (SIP TLS, HTTPS, provisioning) | Read | 🟢 | ☐ |
| D8 | Dialplan lint for a tenant (dangling destinations, orphan IVR entries, loops) | Read | 🟢 | ☐ |
| D9 | Voicemail storage / MWI consistency check | Read | 🟢 | ☐ |
| D10 | Config-drift snapshot diff (yesterday vs today for a tenant's objects) | Read | 🟢 | ☐ |

### Group 4 — Admin repairs (owner-only; every PBX write Izzy-approved) — `repair.R*`

| # | Capability | Path | Risk | Status |
|---|---|---|---|---|
| R1 | SIP re-registration kick for one extension/device | AMI/ARI | 🟢 | ☐ |
| R2 | Clear a single stuck channel (by channel ID, with live-call guard) | AMI/ARI | 🟡 | ☐ |
| R3 | Trunk re-register / qualify kick | AMI | 🟡 | ☐ |
| R4 | Voicemail MWI resync for one mailbox | AMI | 🟢 | ☐ |
| R5 | Fail2ban unban a specific customer IP | SSH (scoped cmd) | 🟡 | ☐ |
| R6 | Dialplan / single-module reload (NOT full restart) | AMI (scoped) | 🟡 | ☐ |
| R7 | Log / recording disk cleanup (rotate + archive, never delete newest) | SSH (scoped cmd) | 🟡 | ☐ |
| R8 | Certificate renewal run (with pre/post verification) | SSH (scoped cmd) | 🔴 | ☐ |
| R9 | Single service restart on PBX (e.g. fail2ban, NOT asterisk core) | SSH (scoped cmd) | 🔴 | ☐ |
| R10 | Asterisk core restart / full apply-regen | — | 🔴 | **NOT DELEGATED** — stays a manual, Izzy-run, windowed operation. The agent may only RECOMMEND it with evidence. |

### Group 5 — Connect-platform (loopcom) self-repairs — `repair.L*`

These touch loopcom only (never the PBX) and still follow the deploy-queue rule.

| # | Capability | Path | Risk | Status |
|---|---|---|---|---|
| L1 | Connect service health check + restart via deploy queue | Deploy queue | 🟡 | ☐ |
| L2 | Stuck job requeue (transcription, notifications, sync jobs) | API/DB | 🟢 | ☐ |
| L3 | PBX↔Connect sync re-run for one tenant (extension sync, MOH map republish) | API | 🟢 | ☐ |
| L4 | Redis cache invalidation for a scoped key set | API | 🟢 | ☐ |

---

## 2. Architecture changes needed (spec'd once, before M1)

The current `ScopedPbxExecutor` **hard-refuses** edits to objects not in the
Ownership Ledger. That is exactly right for the additive tier and stays the
default. Group 1/2 requires a second, parallel contract — the **Modify Executor**
— with a strictly stronger gate set:

1. **Snapshot gate** — before dispatch, capture the object's full current state
   (e.g. the route helper's `original_row_json` pattern) into a `agentPbxSnapshot`
   row. No snapshot → refuse.
2. **Izzy-approval gate** — live mode requires a fresh, per-action approval token
   issued via the existing `ActionService` approval email/portal flow. The token is
   bound to (capabilityId, tenantId, objectId, params-hash) so an approval cannot
   be replayed for a different change. **Auto-approve is disabled for `pbx.M*`,
   `pbx.E*`, and `repair.R*` even for owner-role requesters.**
3. **Verify gate** — after write, re-read the object and diff against intent;
   mismatch → automatic revert from snapshot + alert.
4. **Revert command** — every executed modify action exposes one-click revert from
   its snapshot for 7 days (configurable), surfaced on the portal Approvals page.
5. **Scope fence** — customer-requested modifies validate the object belongs to the
   requesting tenant via the Connect DB mirror BEFORE the action is even drafted.
6. **Rate fence** — per-tenant and global caps (e.g. max 3 pending modify actions
   per tenant, max N live writes/hour globally) in `guards/limits.ts`.
7. **Change journal** — human-readable before/after diff attached to the approval
   email so Izzy sees exactly what will change before approving.

Repairs (`repair.R*`) additionally require a **pre-flight safety probe** (e.g. R2
refuses if the channel is part of a bridged, answered call; R7 refuses if the
archive target has insufficient space) and a **post-repair health re-check** that
is attached to the action record.

---

## 3. Per-capability detail

Template for every item; each one ALSO gets its own 1-page spec at SPEC'D time.

> **Requesters** — who may ask for it. **Approval** — who must approve the live write
> (always Izzy for PBX writes, per ground rule 1). **Stress** — what the stress suite
> does beyond the standard fuzz (invalid params, wrong-tenant probes, concurrent
> duplicates, PBX-unreachable behavior, approval-replay attempts — those run for ALL).

### M1 — MOH selection, tenant scope 🟢
- **What:** switch a tenant's active music-on-hold class among classes already available to that tenant.
- **Path:** Connect-managed MOH only (`mohControl.ts` priority stack → `publishMohToAstDb`). **Zero PBX config writes** — AstDB publish through the existing shared transport. If the tenant is in `pbx` control-mode, the agent refuses and explains (flipping control-mode is a separate, owner-approved step).
- **Requesters:** customer (own tenant), owner. **Approval:** Izzy (AstDB publish is still a PBX-state write).
- **Revert:** snapshot previous class; republish.
- **Stress:** 50 rapid class flips; flip during an active held call; publish with Redis/AstDB transport down (must queue or fail clean, never half-publish).

### M2 — MOH selection, extension scope 🟢
- Same as M1 at extension scope (`ExtensionMohControlMode`), including `inherit`.
- **Extra guard:** protected-extension list applies.
- **Stress:** M1 suite + conflicting tenant-vs-extension changes racing.

### M3 — Inbound route destination change 🟡
- **What:** point an existing DID's inbound route at a different destination (IVR, extension, ring group, queue, TC).
- **Path:** existing inbound-route helper (`pbxInboundRouteHelperClient`) — already snapshots `original_row_json` + `original_destination_id`.
- **Pre-flight:** destination must exist and belong to the same tenant (D2 walk); route must belong to requester's tenant.
- **Revert:** helper snapshot restore; auto-revert option (A3 stays the temporary variant; M3 is the permanent one).
- **Stress:** repeated flip A→B→A; change while calls are inbound on that DID; destination deleted between approval and execution (must re-verify at execute time and refuse).

### M4 — IVR entry destination change 🟡
- **What:** re-point digit N of an existing IVR to a different destination.
- **Path:** **new helper** (`ombu_ivr_entries` row update + scoped regen of just that IVR context if possible) — spec'd and hand-installed by Izzy first. No API exists (audit).
- **Revert:** full IVR row-set snapshot before change.
- **Stress:** all 10 digits changed sequentially; entry pointing at itself / loop creation (D8 lint must block); simultaneous edits to two digits of the same IVR.

### M5 — IVR greeting/recording selection 🟡
- **What:** switch which recording an existing IVR plays (from tenant's recording library or a Voice Studio render).
- **Path:** `connect-prompt-sync` for audio placement (exists) + M4 helper for the IVR's greeting field.
- **Stress:** swap greeting 20× ; missing/corrupt audio file (pre-flight audio checksum + duration probe must refuse); swap while IVR is mid-playback on live calls.

### M6 — IVR timeout / invalid destination change 🟡 — rides M4's helper and suite.

### M7 — Time-condition schedule edit 🟡
- **Path:** new helper over `ombu_time_conditions`.
- **Pre-flight:** render the resulting open/closed calendar for the next 7 days into the approval email (human-verifiable intent).
- **Stress:** DST boundary dates; inverted ranges; edit that flips current state (must warn "this takes effect immediately").

### M8/M9 — Ring-group membership / strategy 🟡
- **Path:** new helper over `ombu_ring_groups`.
- **Pre-flight:** every member extension must exist and register-check (warn on adding an offline extension).
- **Stress:** add/remove 20 members; empty group prevention (refuse removing last member without explicit fallback destination); strategy flip under inbound load.

### M10 — Queue configuration edit 🟡
- **Path:** official API (`queues` module is full CRUD per audit).
- **Stress:** agent add/remove churn; timeout set to extremes (schema caps); edit while callers are queued.

### M11 — Extension features on pre-existing extensions 🟡
- **What:** permanent CF/DND/VM-enable changes on extensions the agent did NOT create — the permanent sibling of A2/A7.
- **Path:** AstDB where the feature is AstDB-backed (CF/DND typically are), else helper.
- **Extra guard:** protected extensions; per-tenant policy can block customers entirely.
- **Stress:** conflict with an active A2/A7 temporary action (temporary must win or merge deterministically — spec decides); revert after the underlying extension was edited in the GUI (three-way diff must refuse and alert).

### M12 — Voicemail settings edit 🟡 — new helper over voicemail config; checksum + restore file-level backup.
### M13 — Extension caller-ID edit 🔴 — spoofing-sensitive: allowed values restricted to the tenant's own verified DIDs; anything else refused. Izzy approval + 24h change journal notice.
### M14 — Apply-changes on pre-existing tenant 🔴
- **The gate everything in Group 1 funnels through** where regen is required.
- **Path:** API `apply_changes` — but ONLY inside a declared change window, ONLY immediately after a specific approved M-op, with a pre-apply full-tenant snapshot (D10) and a post-apply automated smoke test (test call into a canary DID). This op is never queued in bulk.

### E1 — Add extension to existing tenant 🟡
- **Path:** new narrow "create extension" helper (audit Path 2) — API is read-only for extensions.
- **Pre-flight:** number-plan check (no collision, respects tenant's range); protected list untouched.
- **Post:** Connect-side `syncExtensionsFromPbx` for that tenant (L3) so the portal sees it immediately.
- **Stress:** 20 sequential creates; duplicate-number race; create → immediate delete request (delete is NOT in scope — refuse; deletes remain manual).

### E2 — Add DID to existing tenant 🟡
- **Path:** existing API sub-collection (`PATCH /tenants/:id/inbound_numbers` — P2's path with the existing-tenant `ownerConfirmed` gate → now full Izzy-approval gate).
- **Pre-flight:** E.164 validation; DID not already bound anywhere on the PBX (global uniqueness probe); carrier-side existence is Izzy's declaration in the approval.
- **Stress:** same DID submitted twice concurrently; malformed numbers fuzz.

### E3–E10 — ride the corresponding M-helper or API path, create-mode; each still gets its own spec + individual certification. E8/E10 reuse the proven Connect MOH/prompt pipelines.

### D1–D10 — read-only diagnostics
- No approval needed, always audited, customer-visible results are plain-language summaries; raw evidence attaches to the internal report (`diag/engine.ts` grows one rule-pack per D-item).
- D5/D6 use **read-only SSH probes** (existing monitoring pattern; command allowlist, no shell interpolation of model output — commands are fixed templates with validated params).
- Each D-item is certified by fixture: recorded real outputs → engine must produce the expected ranked hypotheses.
- **Stress:** malformed/hostile command output parsing (fuzz the parsers); PBX unreachable; giant outputs (100k-line logs) within time/memory budget.

### R1–R9 — admin repairs
- All owner-role only, all Izzy-approved per-op, all with pre-flight safety probe + post-repair health re-check as first-class parts of the action record.
- R1 (re-register kick) is the pilot: smallest blast radius, existing AMI pattern from A10.
- R2 (channel clear) refuses bridged/answered calls unless `force` is separately approved.
- R5 (unban) validates the IP was banned for registration failures (not an attack signature) and belongs to a known customer site (Connect DB cross-check).
- R7 (disk cleanup) is archive-then-rotate with a dry-run report in the approval email: exactly which files, exactly how much space.
- R8/R9 (cert renew / service restart) each get a dedicated runbook spec and a manual-first live drill (Izzy at the keyboard, agent watching and verifying) before the agent ever drives them.
- **R10 is explicitly not delegated.** Asterisk core restarts and full regen stay human.
- **Stress (all R):** repair issued twice concurrently (idempotency/locking); repair on healthy target (must no-op with "nothing to repair"); mid-repair PBX disconnect (must record UNKNOWN outcome and alert, never retry blind).

### L1–L4 — loopcom self-repairs
- Deploy-queue rule respected (L1 never restarts services directly); no PBX contact at all; standard fuzz + concurrency stress.

---

## 4. What the agent will still NEVER do (hard exclusions)

- Delete any pre-existing object (extensions, DIDs, routes, IVRs, tenants, recordings, voicemail).
- Rebind or remove a DID that it did not just create in the same approved plan.
- Asterisk core restart, full config regeneration outside M14's windowed contract, kernel/OS changes (R10 class).
- Touch trunks' credentials, outbound caller-ID beyond M13's verified-DID fence, or emergency-services (E911) routing.
- Payments, pension, or anything outside the Connect/PBX scope.
- Install or modify its own helper scripts on the PBX.
- Any write while the kill switch is on.

---

## 5. Build order — DECIDED (Izzy, 2026-07-23): list order, start to end

**M1 → M2 → M3 → … → M14 → E1 → … → E10 → D1 → … → D10 → R1 → … → R9 → L1 → … → L4.**
One capability at a time, all 9 lifecycle gates green before the next one starts.
(The list order in Group 1 already runs safest-first: the two AstDB-only MOH ops,
then the helper-with-existing-snapshots route op, then the Helper-NEW ops, with
the two 🔴 ops last.)

Branch-work prefixes (ground rule 9):
- **H\*** — a new PBX helper script required by an M/E item (e.g. H1 = IVR edit
  helper needed by M4/M5/M6). Each H item gets its own spec, SEBA, review, and
  Izzy hand-installs it on the PBX; it is inserted into the list directly before
  the first item that needs it.
- **X\*** — Connect-side infrastructure prerequisites (e.g. X1 = Modify Executor +
  snapshot store + Izzy-approval token binding, needed before M1 can be built).

Current inserted branch items:
| # | Item | Needed by | Status |
|---|---|---|---|
| X1 | Modify Executor: snapshot store, params-hash-bound approval tokens, verify-after-write, revert command, rate fence (architecture §2) | M1+ (everything) | SPEC'D ✅ · BUILT ✅ · UNIT ✅ (63 tests) · SIM-CERT ✅ (31/31 harness cases, zero-impact proven) · RED-TEAM ✅ (tamper/replay/approve-then-mutate all refused) · STRESS ✅ (concurrency races incl. a real cap race found+fixed) · LIVE-CERT/REVERT-DRILL: N/A-by-design (no live surface; catalog empty) — **awaiting Izzy's check-off** |
| X3 | Instant approval channel (SMS / phone push) so Izzy can approve live writes from his pocket instead of email-only | quality-of-life for all approvals | ☐ |
| X4 | **Tenant MOH publish must cover QUEUES (Izzy, 2026-07-23):** "change all my hold music" must change inbound, outbound, AND every queue in one shot. Today: native classes sync queues via the route helper (`music_group_id`), but Connect-uploaded classes hit an explicit no-op (`connect_uploaded_moh_no_vitalpbx_music_group`) — queues keep their old music, which is exactly the manual chore Izzy does today. Read-only PBX audit (2026-07-23, vmi2718844): `ombu_queues` resolves MOH by `music_group_id` (+ `force_moh` flag); Connect classes exist only in `musiconhold_custom.conf` with no native music group, so queues can't point at them via the normal column. X4 = design + fix the publish path for queue coverage of connect classes (likely an H-series helper update, hand-installed by Izzy), verified end-to-end. **M1 is blocked on X4** and M1's verify/live-cert must include queue evidence. **ROOT CAUSE CONFIRMED (2026-07-23, read-only): the installed helper already updates `ombu_queues.music_group_id` but its apply step runs only `dialplan reload` + `moh reload` — the queue config file is never re-rendered and app_queue is never reloaded, so queues keep the old class until a GUI edit forces it. Fix = H1 helper update: tenant-scoped in-place `musicclass=` patch of `queues__50-<tenant>-*.conf` (regen-free, backed up, diff-verified) + `queue reload all` + per-queue evidence in the helper response.** **DONE 2026-07-23:** SPEC'D ✅ (Izzy approved; one-time explicit permission for agent-installed helper) · BUILT ✅ (helper v2026.07.23.2-queuemoh live on PBX; repo installer updated to v2026.07.23.3 as canonical) · UNIT ✅ (23 offline tests incl. foreign-tenant fence, scope verification, hostile-content inertness) · LIVE-CERT ✅ on T21: portal MOH re-apply → queue conf `default`→`moh8`, one-line diff vs backup, DB/file/reload consistent, all other tenants' files byte-untouched · REVERT-DRILL ✅ (backup restored + rolled forward, byte-identical) · Two fail-safe refusals during rollout (missing backup dir; sandbox read-only /opt) both behaved exactly as designed — refuse + report, touch nothing. Pending: Izzy's ear test (call queue 1121 on hold). | M1 | ☑ |

**Requester rule for FULL-TENANT changes (Izzy, 2026-07-23):** any capability that
changes something tenant-wide (tenant MOH, IVR, routes, time conditions, …) may be
REQUESTED only by the tenant's OWNER (TENANT_ADMIN role) or Izzy. Managers, admins,
and regular users are redirected to the tenant owner. Izzy still approves every
live execution regardless of requester.
| X2 | Identity-aware sessions + per-user memory (Izzy, 2026-07-23): when a user opens the agent, it ALREADY knows — from their verified portal/mobile login, never by asking or guessing — who they are, their tenant, their extension(s), their phone numbers and routes, AND their full history with the agent (every chat distilled into a per-user markdown dossier the agent reads at session start). Every read and every action is pre-scoped to that verified identity; any mismatch = polite refusal + escalation. Also wires X1's G3 scope resolver (ships fail-closed until then). | M1+ (any customer-facing use) | SPEC'D ✅ · BUILT ✅ · UNIT ✅ (33 tests) · SIM-CERT ✅ (34/34 harness cases incl. 3 X2 scope cases, zero-impact proven) · RED-TEAM ✅ (fake-admin claims, foreign-tenant params, dossier injection all neutralized) · STRESS ✅ (found+fixed a duplicate-history race in the sweep design) · LIVE-CERT/REVERT-DRILL: N/A-by-design (Connect-side reads only, zero PBX contact) — **awaiting Izzy's check-off** |

---

## 6. Open questions for Izzy (answer before M1 spec)

1. **Approval channel:** is the existing approval email + portal Approvals page the way you want to approve every live write, or do you want an additional real-time channel (SMS/push) for time-sensitive customer requests?
2. **Customer visibility:** when a customer asks for a change and it's pending your approval, what does the agent tell them? ("Queued for engineering approval, ETA X"?)
3. **Snapshot retention:** 7-day one-click revert window OK, or longer?
4. **M14 change windows:** fixed maintenance windows (e.g. nightly 2–4 AM) or ad-hoc per approval?
5. **Helper installation:** confirm you personally install each new helper script on the PBX from a repo-reviewed file (agent prepares, you install), per audit Path-2 discipline.
6. ~~**T21 pilot tenant:** still the live-certification sandbox?~~ **ANSWERED (2026-07-23): YES — every capability live-certs on T21 "Landau Home" before any rollout to anyone else.** Remaining sub-question: any additional protected extensions beyond 101?
