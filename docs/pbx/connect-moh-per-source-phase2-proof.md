# Connect MOH per-call-source — deployment-readiness proof

**Status: NOT DEPLOYED.** No deploy was enqueued, no PBX was mutated, no
migration was run in any environment. `PBX_ALLOW_CONFIG_MUTATIONS` untouched.
This document is the pre-deploy proof for making `inbound_direct`, `outbound`,
and `internal` per-call-source Music-on-Hold active on real call paths (and
honestly disabling `mobile_app` and `parked`).

Everything is grounded in the captured PBX brain
(`docs/pbx-brain/extracted-useful/pbx-full-brain-20260609-063057/…/vitalpbx/`).

---

## 0. Hardening-pass headline finding (why it wasn't working before)

`extensions__20-baseplan.conf` L217, inside `[sub-local-dialing]`, sets
`__TRANSFERED_CALL=TRUE` **unconditionally on every local extension dial**, right
before the `Dial()` that installs our MOH hooks. It is inherited (`__`) and
**never read back** by VitalPBX. The prior resolver used it as a transfer
signal, so **every** extension-terminating call (inbound_direct, internal,
ring-group, IVR) bucketed as `transfer` — which is exactly why those per-source
policies looked "stored but not active."

**Fix:** transfer is now detected **only** from the Asterisk-native
`BLINDTRANSFER` (blind) and `ATTENDEDTRANSFER` (attended) channel variables,
which are empty on normal calls (VitalPBX itself gates on `${BLINDTRANSFER}=""`
throughout `[sub-local-dialing]`). `__TRANSFERED_CALL` is no longer read.
Locked in by the test *"resolver classifies transfer ONLY from Asterisk-native
BLINDTRANSFER/ATTENDEDTRANSFER, never __TRANSFERED_CALL."*

---

## 1. `__CALL_TYPE` / classifier signal present on the exact bridge-hook path

The MOH resolver runs from `[sub-before-bridging-call]` →
`global-before-bridging-call-hook` (installed as the `U(...)` Dial option) and
from the caller-leg `[connect-tenant-moh-connect-shim]` (via
`b(sub-before-connecting-call)`). `[sub-before-bridging-call]` itself reads
`${CALL_TYPE}` (baseplan L3259/L3281), proving the inherited value is live there.

| Call path | Where the classifying signal is set | Hook installed by | Signal at hook | Resolves to |
|-----------|-------------------------------------|-------------------|----------------|-------------|
| inbound direct | `T<id>_default-trunk` / `…-trunk` `sub-setup-call-type(incoming)` → `__CALL_TYPE=2` before ext dial | `sub-local-dialing` L215-216 (U+b) | `CALL_TYPE=2`, origin≠rg/ivr, no queue ctx | `inbound_direct` |
| outbound | outbound route `sub-setup-call-type(outgoing)` → `__CALL_TYPE=3` | trunk `Dial(... U(sub-before-bridging-call…))` (e.g. `50-1` L403) | `CALL_TYPE=3` (trunk leg) | `outbound` |
| internal | `sub-local-dialing` `sub-setup-call-type(internal)` → `__CALL_TYPE=1` | `sub-local-dialing` L215-216 | `CALL_TYPE=1` | `internal` |
| blind transfer | Asterisk sets `BLINDTRANSFER` on transferred leg; target dialed via `sub-local-dialing` | `sub-local-dialing` L215-216 | `BLINDTRANSFER≠""` | `transfer` |
| attended transfer | Asterisk sets `ATTENDEDTRANSFER` on completion | `sub-local-dialing` L215-216 | `ATTENDEDTRANSFER≠""` (best-effort; else falls to internal→default, fail-safe) | `transfer` |
| queue delivery | `T<id>_queue-call-to-agents` → `sub-local-dialing`; `__QUEUE_AGENTS_CONTEXT=T<id>_queue-call-to-agents` set by `T<id>_set-global-tenant-vars` L226 | `sub-local-dialing` L215-216 | `QUEUE_AGENTS_CONTEXT≠""` | `inbound_queue` |
| ring group delivery | `T<id>_ring-group-dial` sets `__CALL_ORIGIN=ring-group` (L312) → `sub-local-dialing` | `sub-local-dialing` L215-216 | `__CALL_ORIGIN=ring-group` | `inbound_ringgroup` |
| IVR delivery | IVR restricted ctx sets `__CALL_ORIGIN=RESTRICTED_IVR_CALL`; routed to ext via `local-dialing` | `sub-local-dialing` L215-216 | `__CALL_ORIGIN=RESTRICTED_IVR_CALL` | `inbound_ivr` |

Notes verified in-brain:
- `sub-setup-call-type` is guarded by `__CALL_TYPE_CONFIGURED` (baseplan L475), so
  an inbound call flowing through `sub-local-dialing` is **not** reclassified to
  internal — it stays `CALL_TYPE=2`.
- `[clean-variables]` (baseplan L2917, used by ring-group `U(clean-variables)`)
  resets `__CALL_ORIGIN=none` and a few flags but **does not touch `__CALL_TYPE`**.
  Ring-group/queue/IVR are classified from `__CALL_ORIGIN`/`QUEUE_AGENTS_CONTEXT`
  (checked before `__CALL_TYPE`), so they are unaffected regardless.

## 2. Priority order (confirmed, matches the installed resolver)

`[sub-connect-tenant-moh]` `MOH_SRC`, first match wins:

1. explicit future override `${CONNECT_MOH_SRC}` (read-only; never set here)
2. transfer — `BLINDTRANSFER≠"" | ATTENDEDTRANSFER≠""`
3. ring group — `__CALL_ORIGIN=ring-group`
4. queue — `QUEUE_AGENTS_CONTEXT≠""`
5. IVR — `__CALL_ORIGIN=RESTRICTED_IVR_CALL`
6. `__CALL_TYPE` fallback — `1→internal`, `3→outbound`, `2→inbound_direct`

Each step guarded on empty `MOH_SRC`. Locked in by the tests *"…transfer/
ring-group/queue/ivr are classified before the __CALL_TYPE base classes"* and
*"…derives internal/outbound/inbound_direct from … __CALL_TYPE"*. The shared TS
classifier `classifyDialplanMohSource` was reordered (ring-group before queue)
to mirror this exactly.

## 3. `__CALL_TYPE=4` (TRANSIT) never maps to a source

There is no `CALL_TYPE="4"` branch. TRANSIT (trunk↔trunk, no extension leg) and
any unknown leave `MOH_SRC` empty → the per-source AstDB reads are skipped → the
call uses the existing extension/tenant/global/PBX default chain (identical to
the pre-source build). Locked in by the assertion `CALL_TYPE}" = "4"` **absent**
from the resolver body.

## 4. UI hides `mobile_app` and `parked`

`UNSUPPORTED_MOH_SOURCES = { "mobile_app", "parked" }` filters both the policy
editor and the diagnostics selector in
`apps/portal/app/(platform)/pbx/moh-scheduling/page.tsx`.
- **mobile_app**: a softphone that *places* a call is an ordinary PJSIP
  extension (`CALL_TYPE 1/3`), indistinguishable from a desk phone;
  `[pjsip-push]`/`[send-mobile-push]` only *wake a called* device then
  `Hangup()`. No per-call inherited variable identifies the originator as mobile.
- **parked**: parking-lot hold music is `res_parking.conf`'s `musicclass` applied
  when the call enters the lot, not settable on the bridge/connect hooks this
  resolver runs on.

## 5. Legacy policies for hidden sources: not deleted, only marked inactive

Hiding is presentation + path-level inertness only. Any stored `MohSourcePolicy`
row for `mobile_app`/`parked` is **not** deleted and **not** auto-`enabled=false`
by this change. It still publishes its AstDB key, but the dialplan never sets
`MOH_SRC` to those tokens, so the key is never read (inert). In the UI the row
renders badged **(not active)**. Reversible with zero data loss.

## 6. Rollback paths

| Layer | Rollback |
|-------|----------|
| Dialplan installer | `sudo bash scripts/pbx/install-connect-tenant-moh-dialplan.sh --rollback` — removes only the Connect-owned `extensions__65_*` / `pjsip__65_*` files + the sentinel `#include` line, reloads dialplan + `res_pjsip.so`, and verifies the resolver is no longer loaded. Manual break-glass equivalent (sed/rm) also printed by the installer. |
| DB migration | `packages/db/prisma/migrations/20260630120000_moh_call_source_policies/ROLLBACK.sql` (reference-only; Prisma runs only `migration.sql`). Drops `MohGlobalConfig`, `MohSourcePolicy`, and the 3 additive `MohScheduleRule` columns + index. All forward objects are additive, so the drop restores the exact prior schema. Deploy reverted API/worker first. |
| Published AstDB keys | `POST /voice/moh/rollback/:publishId` writes empty-string tombstones for every per-source key the publish added (`computeSourceKeysClearForRollback`), and the dialplan treats empty as "fall through" — so the tenant reverts to its default chain without any key delete. |
| UI / API | Additive routes + one portal tab. Revert the commit; the dialplan/AstDB keep working (reads simply stop being written). No destructive coupling. |

## 7. Staging-only live-call checklist (actual Asterisk CLI)

Run on a **staging** PBX only, with owner approval. `<T>`=tenant slug,
`<EXT>`=extension, `<PBX>`=host.

**A. Install + load (read-only check first):**
```bash
sudo bash scripts/pbx/install-connect-tenant-moh-dialplan.sh --check      # read-only
sudo bash scripts/pbx/install-connect-tenant-moh-dialplan.sh              # install
asterisk -rx "dialplan show sub-connect-tenant-moh"                        # resolver present
asterisk -rx "dialplan show global-before-bridging-call-hook"             # U-hook wrapper present
```

**B. Prove `MOH_SRC` + `CONNECT_MOH` are logged and `CHANNEL(musicclass)` is set.**
Enable dialplan verbosity and watch the resolver NoOps while placing each call:
```bash
asterisk -rx "core set verbose 4"
asterisk -rx "logger set level VERBOSE on"
# In a second shell, tail the CLI while placing calls of each type:
asterisk -rvvvvv    # watch for the resolver NoOp:
#   "Connect tenant MOH source tenant_id=<id> slug=<T> call_type=<n> origin=<o> moh_src=<src>"
#   "Connect tenant MOH ... class=<class>"   (musicclass applied)
```
For a live channel, confirm the musicclass value directly:
```bash
asterisk -rx "core show channels concise" | grep <EXT>
asterisk -rx "core show channel <CHANNEL>" | grep -iE "musicclass|CONNECT_MOH"
```
Per call type, assert the logged `moh_src`:
- internal ext→ext → `moh_src=internal`
- outbound ext→PSTN → `moh_src=outbound`
- inbound DID→ext (direct) → `moh_src=inbound_direct`
- inbound via ring group → `moh_src=inbound_ringgroup`
- inbound via queue → `moh_src=inbound_queue`
- inbound via IVR → `moh_src=inbound_ivr`
- blind transfer → `moh_src=transfer`

**C. Prove NO Dial/Local/Answer/Bridge change in the resolver:**
```bash
# Static (source of truth):
npx tsx --test scripts/pbx/install-connect-tenant-moh-dialplan.test.ts    # "resolver is metadata-only" passes
# Live: the resolver context must show ONLY Set/ExecIf/GotoIf/NoOp/Return — no App=Dial|Local|Answer|Bridge
asterisk -rx "dialplan show sub-connect-tenant-moh" | grep -iE "Dial\(|Local/|Answer\(|Bridge\(|Originate|Playback\(|Background\(" && echo "FAIL: forbidden app present" || echo "OK: metadata-only"
```

**D. Prove routing behavior unchanged (queue/ring-group/IVR/transfer):**
```bash
# Before vs after install, compare the generated contexts are untouched:
asterisk -rx "dialplan show T<id>_queue-call-to-agents"     # identical pre/post
asterisk -rx "dialplan show T<id>_ring-group-dial"          # identical pre/post
asterisk -rx "dialplan show T<id>_incoming-calls"           # identical pre/post
```
Then live-verify each still connects normally and hold music plays:
- Queue call answered by agent; caller placed on hold → hears MOH; agent retrieve → resumes. No dropped/duplicated legs.
- Ring group call → all members ring, one answers, transfer works.
- IVR → DTMF routes to extension; MOH on hold.
- Blind + attended transfer → target rings, transfer completes, original party hears MOH while ringing, no loop, no duplicate `Dial` (`core show channels` shows the expected count only).
```bash
asterisk -rx "core show channels count"     # sanity: no unexpected extra legs during hold/transfer
asterisk -rx "bridge show all"              # one bridge per active call, no orphan bridges
```

**E. Fall-through + rollback:**
```bash
# Remove all per-source policies for the tenant, re-publish → confirm default MOH returns.
# Then full rollback:
sudo bash scripts/pbx/install-connect-tenant-moh-dialplan.sh --rollback
asterisk -rx "dialplan show sub-connect-tenant-moh"     # => context not found (unloaded)
```

## 8. Tests + results (this machine)

- Installer string-shape: **51 tests, 48 pass, 3 fail**. The 3 fails (`#12/#37/#43`)
  are **pre-existing on the unmodified baseline** (`git stash` → 45 tests / same 3
  fails) — a Windows CRLF-vs-`\n` regex-shape artifact, unrelated. All 6 new/updated
  MOH tests pass.
- Shared MOH pure-logic (`mohCallSource`, `mohSourcePublish`, `mohScenarios`):
  **50 tests, 50 pass, 0 fail.**
- Portal lint: clean.

## 9. Operational status of each displayed call source

| Source | Active | Signal |
|--------|--------|--------|
| inbound_direct | ✅ | `CALL_TYPE=2` & not rg/queue/ivr |
| inbound_ivr | ✅ | `__CALL_ORIGIN=RESTRICTED_IVR_CALL` |
| inbound_ringgroup | ✅ | `__CALL_ORIGIN=ring-group` |
| inbound_queue | ✅ | `QUEUE_AGENTS_CONTEXT` |
| internal | ✅ | `CALL_TYPE=1` |
| outbound | ✅ | `CALL_TYPE=3` (trunk leg) |
| transfer | ✅ | `BLINDTRANSFER` / `ATTENDEDTRANSFER` |
| parked | ❌ hidden — `res_parking.conf` musicclass, not this resolver |
| mobile_app | ❌ hidden — not detectable per-call |

## 10. Deployment confirmation

No deployment occurred. No `deploy-direct.sh`, no queue enqueue, no migration
applied, no PBX mutation, `PBX_ALLOW_CONFIG_MUTATIONS` unset.

---

# ADDENDUM — MOH catalog / playability redesign (2026‑07‑01)

## A. Production incident + repair (A‑Plus / T2)

**Symptom:** T2 hold music went silent after its default Hold Profile was changed
from `moh2` to `moh5` in the portal.

**Root cause (grounded in PBX brain files `musiconhold__50-*.conf`):**
- `moh2` (group 2) is **owned by T2** (`musiconhold__50-2-main.conf`, files dir
  present, DB `fileCount=1`).
- `moh5` (group 5) is **owned by the main/library tenant (pbxTenantId 1, slug
  `vitalpbx`)** (`musiconhold__50-1-main.conf`, DB `fileCount=40`). It is a loaded,
  file-backed class — *not* fileless.
- Publishing `moh5` for T2 ran the **native sync** (`syncNativeInboundRoutesMoh` →
  helper `/sync-tenant-moh`) which stamped **T2's own** inbound routes / extensions /
  queues with `music_group_id=5` — pointing T2's native resources at a **foreign**
  group. That mispointing (not a missing file) is what produced silence.

**Repair (existing publish path, T2 only):** profile reset to `moh2` and
re‑published. Publish record `cmr28svg5esxvmw1323fqugbj` (`manual moh5→moh2 success`).
Native sync restored `music_group_id=2` on **inbound 6/6, extensions 20/20, queue 1/1**;
helper ran `dialplan reload` + `moh reload` (exit 0). No other tenant touched.

## B. The corrected model

Ownership is **not** the assignment gate — **playability** is. A class is
assignable to any tenant/extension when Asterisk can actually play it. Ownership
only governs whether Connect may rewrite the tenant's **native** `music_group_id`.

New pure helpers (`packages/shared/src/mohCatalog.ts`, fully unit-tested):
- `classifyMohOrigin` → `tenant | main | global_default | connect_upload | unassigned`.
- `computeMohPlayability` → `{ selectable, unavailableReason, filesPresent }`
  (`deactivated` > `not_loaded` > `no_files`; `loadedInAsterisk=null` = unknown → not blocking).
- `decideNativeMohSync` → run native sync **only** for an owned class; skip
  (`foreign_class_native_sync_suppressed`) for main/other/unassigned; resolver-only
  otherwise. **This is the defect fix.**

## C. Behaviour changes

| Area | Before | After |
|------|--------|-------|
| Refresh (`syncMohClassesFromOmbutelMysql`) | imported all groups; no playability | computes `origin`+`selectable`; optional **read-only** live `moh show classes` probe merge (graceful if helper lacks `/moh-classes`) |
| Readiness (`evaluateMohRuntimeReadiness`) | native branch required tenant/null/main ownership; only checked row exists | assignable across owners; **gates on playability** (`moh_class_not_loaded` / `moh_class_no_files`) |
| Native sync (`syncNativeInboundRoutesMoh`) | stamped `music_group_id` for tenant/null/main class | stamps **only** owned classes; foreign/main → skipped, resolver-only |
| `GET /voice/moh/pbx-classes` | class list | + `origin`, `selectable`, `unavailableReason`, `filesPresent` |
| Portal picker | listed all active classes | unavailable classes shown **disabled** with reason; unavailable count surfaced |

## D. Files changed (Part C)
- `packages/shared/src/mohCatalog.ts` (new) + `mohCatalog.test.ts` (new, 17 tests)
- `packages/shared/src/index.ts` (export)
- `packages/db/prisma/schema.prisma` — `PbxMohClass`: `origin`, `loadedInAsterisk`,
  `selectable`, `unavailableReason`, `lastProbedAt` (+ index)
- `packages/db/prisma/migrations/20260701160000_moh_catalog_playability/{migration,ROLLBACK}.sql` (additive)
- `apps/api/src/pbxOmbutelMohClassSync.ts` — origin/playability + live-probe param
- `apps/api/src/pbxInboundRouteHelperClient.ts` — `getPbxMohClasses` (read-only)
- `apps/api/src/server.ts` — readiness gate, native-sync ownership rule, classes
  endpoint fields, auto-sync live probe
- `apps/portal/app/(platform)/pbx/moh-scheduling/page.tsx` — disabled unavailable
  options + reason (+ fixed pre-existing missing `apiPut` import)

## E. Migration impact
Additive only. All new `PbxMohClass` columns nullable/defaulted (`selectable`
default `true`); values recomputed on next refresh. `ROLLBACK.sql` drops them.
No other table affected. **Not applied to production.**

## F. Tests + results
- `mohCatalog` unit: **17/17 pass** (origin incl. main/default; playability incl.
  fileless-block, not-loaded-block, stream-ok; native-sync owned-runs /
  foreign-skips / connect-skip / no-link-skip; `moh2→moh5→moh2` selectable).
- All MOH shared suites together: **67/67 pass.**
- `apps/api` tsc: 36 **pre-existing** errors, **0** in changed files/regions.
- `apps/portal` tsc: MOH page **clean** after `apiPut` import fix.
- Lint: clean.

## G. What is fixed immediately WITHOUT the per-source resolver / any PBX change
- Foreign/main class assignment no longer corrupts a tenant's native
  `music_group_id` (resolver-only path). This alone prevents the `moh5→T2` silence.
- Fileless/unloaded classes are blocked at publish (readiness gate) and disabled
  in the UI.
- Assigning any **file-backed** class (e.g. main‑tenant `moh5`, 40 files) to any
  tenant is allowed; `moh2 → moh5 → moh2` flips `active_moh_class`/`moh_class` and
  the resolver sets `CHANNEL(musicclass)` accordingly.

## H. Requires an owner-side PBX helper addition (optional, additive)
The live `moh show classes` probe reads a new **read-only** helper endpoint
`GET /moh-classes`. Until the owner adds it, `loadedInAsterisk` stays `null`
(unknown) and playability falls back to file-count — nothing breaks.

## I. Safe rollout plan
1. Validate schema+logic on throwaway Postgres (`scripts/validation/moh_db_validation.ts`); no prod.
2. (Optional) owner adds read-only `/moh-classes` to the PBX route helper.
3. Deploy API+portal via approved blue/green **after approval only**.
4. Owner runs “Refresh from PBX” → catalog populates `origin`/`selectable`.
5. Re-test `moh2 → moh5 → moh2` on T2: `moh5` publish must report native sync
   `skipped: foreign_class_native_sync_suppressed`; audio still changes via resolver.
6. No per-source resolver installer in this rollout.

## J. Deployment confirmation (addendum)
Branch-only. No deploy, no production migration, no PBX installer, no new resolver.
The only production write was the **approved T2 base-MOH repair** via the existing
publish path (§A).

## K. Inbound hold coverage — caller-leg MOH in `[sub-local-dialing]` (production-proven 2026-07-01)

### K.1 Root cause — called-leg hooks are insufficient for inbound hold
Asterisk plays the **held party's own `CHANNEL(musicclass)`**. For an inbound
call the held party is the **caller / Local leg** that executes VitalPBX
`[sub-local-dialing]`:

- **Inbound direct DID** → held leg is the inbound trunk channel in `[sub-local-dialing]`.
- **Inbound via IVR / ring group / queue post-answer bridge** → held leg is the
  `Local/<ext>@T<tid>_<ctx>;2` channel that runs `[sub-local-dialing]`.

Every Connect MOH hook shipped before this change fires on the **called PJSIP
endpoint leg**, never on that held caller/Local leg:

| Hook | Dial flag | Runs on | Covers |
|------|-----------|---------|--------|
| `${TENANT_PREFIX}before-connecting-call-hook` | `b(sub-before-connecting-call)` | called endpoint, pre-dial | endpoint only |
| `${TENANT_PREFIX}before-bridging-call-hook` + `global-before-bridging-call-hook` | `U(sub-before-bridging-call)` | called endpoint, post-answer | endpoint only |

VitalPBX itself only sets the caller/Local leg's `musicclass` in two narrow
cases — **hotdesk** (`sub-set-moh`) and **queue with `FORCE_QUEUE_MOH`** — neither
of which applies to a normal inbound extension call, so the held leg stays at
`default`.

**Production evidence:** switching T2's class via AstDB changed **outbound** hold
(held leg = called trunk = covered by `global-before-bridging`) but **not inbound**
hold. PJSIP `moh_suggest` on the endpoint (**Candidate B**) was tested and did
**not** drive the held peer — closed as unreliable. Adding a caller-leg hook that
sets `CHANNEL(musicclass)` inside `[sub-local-dialing]` **before `Dial()`**
(**Candidate A**) fixed inbound hold on the first live test.

> **Conclusion (branch note):** *Called-leg (before-connecting / before-bridging)
> hooks are insufficient for inbound hold. Caller-leg coverage in
> `[sub-local-dialing]` before `Dial()` is required.*

### K.2 The fix (installer-managed, idempotent)
`scripts/pbx/install-connect-caller-leg-moh.sh`:

1. Inserts **one** guarded line into VitalPBX-core `[sub-local-dialing]`,
   immediately **after** the unique `U(sub-before-bridging-call` anchor (i.e. after
   VitalPBX's own MOH/hotdesk/queue logic) and **before** `Dial(${DIAL_STRING}…)`:

   ```
   same => n,GosubIf($[${DIALPLAN_EXISTS(${TENANT_PREFIX}before-local-dial-moh-hook,s,1)}=1]?${TENANT_PREFIX}before-local-dial-moh-hook,s,1)
   ```

   `DIALPLAN_EXISTS` guard ⇒ **pure no-op** for any tenant without a hook context.
   It does **not** alter `Dial()`, `Answer()`, `Playback()`, Local channels,
   routes, trunks, queues, IVRs, ring groups, or extensions.
2. Writes a **separate, Connect-owned** file
   `extensions__67_connect_localdial_moh.conf` with **one hook per tenant that has
   PUBLISHED Connect MOH** (`connect/pbx_tenant_map/<tid>/{slug,moh_class}` both
   present). Each hook is self-contained + fail-safe:

   ```
   [T<tid>_before-local-dial-moh-hook]
   exten => s,1,NoOp(...)
    same => n,Set(CONNECT_MOH_CLASS=${DB(connect/t_<slug>/moh_class)})
    same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_<slug>/active_moh_class)}))
    same => n,GotoIf($["${CONNECT_MOH_CLASS}" = ""]?done)
    same => n,Set(CHANNEL(musicclass)=${CONNECT_MOH_CLASS})
    same => n,Set(__CONNECT_MOH=${CONNECT_MOH_CLASS})
    same => n(done),Return()
   ```

   Sets **only** `CHANNEL(musicclass)` + `__CONNECT_MOH`. Missing slug/class ⇒
   `Return()` with musicclass untouched.
3. `#tryinclude`s the `__67` file from the Connect hub `extensions__60_custom.conf`.

**Safety invariants (locked by tests):**
- Refuses if the anchor is missing or duplicated (`count != 1`).
- Idempotent + re-apply-safe: re-running is a no-op when the marker is present;
  after VitalPBX "Apply Changes"/upgrade regenerates the baseplan (dropping the
  line — the `__67` file and `#tryinclude` survive), re-running restores it.
- Writes **no** AstDB keys; touches **no** `pjsip__*`, `musiconhold__*`,
  `extensions__50-*`, `queues__*` file. Baseplan is modified **only** by inserting
  the single guarded line (timestamped backup + surgical rollback).
- Non-enabled tenants no-op via `DIALPLAN_EXISTS` (no context generated for them).

### K.3 Coverage matrix (proof)

| Scenario | Held leg | Covered by | Result |
|----------|----------|------------|--------|
| **Inbound direct** hold | inbound trunk in `[sub-local-dialing]` | caller-leg GosubIf before `Dial()` | ✅ tenant class (live-proven on T2) |
| **Inbound IVR → extension** hold | `Local/<ext>@…;2` in `[sub-local-dialing]` | caller-leg GosubIf before `Dial()` | ✅ tenant class |
| **Inbound ring group** hold | `Local/<ext>@…;2` in `[sub-local-dialing]` | caller-leg GosubIf before `Dial()` | ✅ tenant class |
| **Queue WAITING** music (pre-answer) | app_queue caller channel | native queue `music_group_id` (untouched) | ✅ native/separate — deliberately **not** overridden |
| **Queue POST-answer bridge** hold | `Local/<ext>@…;2` in `[sub-local-dialing]` | caller-leg GosubIf before `Dial()` | ✅ tenant class |
| **Outbound** hold | called **trunk** leg | existing `global-before-bridging-call-hook` (unchanged) | ✅ no regression |

Why queue **waiting** stays native: the caller channel is inside `app_queue`, not
`[sub-local-dialing]`, when it hears waiting music — the hook never runs there, so
queue MOH remains the queue's own `music_group_id`. The **post-answer** bridge hold
(agent puts caller on hold after answer) *does* traverse `[sub-local-dialing]` on
the agent-dial Local leg and is therefore covered.

### K.4 Automated tests
`scripts/pbx/install-connect-caller-leg-moh.test.ts` (19 cases, `tsx --test`,
**all green**) — string-shape regression identical in style to the cos-wake
overlay tests. Locks: single guarded GosubIf at the correct seam; anchor
missing/duplicate refusal; idempotency/marker guard; per-tenant hooks emitted
**only** for published-MOH tenants; hook sets **only** `CHANNEL(musicclass)` +
`__CONNECT_MOH`; fail-safe class guard precedes the musicclass set;
metadata-only (no Answer/Dial/Local/Playback); no AstDB writes; no
pjsip/musiconhold/route file writes; `--check` is read-only; surgical rollback.

A throwaway functional sandbox (real constants + generator vs. a fixture
baseplan) additionally confirmed: line lands between the anchor and `Dial()`,
`Dial()` untouched, idempotent re-run, rollback restores the file, and
anchor-count 0/2 both trip the refusal.

### K.5 Rollback
```
sudo scripts/pbx/install-connect-caller-leg-moh.sh --rollback
```
Removes **only** the Connect-owned baseplan line (exact-marker `grep -vF`), the
`__67` hook file, and its `#tryinclude`, then reloads. AstDB classes and all
native/VitalPBX config are left intact. The current live proof patch on T2 is
**not** rolled back by this branch work (no deploy performed).

### K.6 Deployment status
Branch-only. **No deploy, no migration, no PBX installer executed from this branch.**
The productionized installer supersedes the ad-hoc `/root/connect_t2_localdial_moh.sh`
prototype used for the T2 live proof; deploying it fleet-wide is a separate,
owner-approved step.
