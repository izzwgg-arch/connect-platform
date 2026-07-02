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

## L. Control mode + admin multi-tenant schedules (2026-07-02)

Commit `23ea6c6b` (branch `feature/moh-per-call-source`) adds the long-term control
system on top of the caller-leg fix (§K). This section is the design/proof record.

### L.1 Required statements (authoritative)
1. **Candidate A caller-leg coverage is required.** Inbound hold renders from the
   held caller/Local leg in `[sub-local-dialing]`; setting `CHANNEL(musicclass)`
   there before `Dial()` is the proven fix (§K).
2. **Called-leg hooks alone are insufficient.** `before-connecting` /
   `before-bridging` run on the called PJSIP endpoint (covers outbound only), never
   the inbound held caller/Local leg.
3. **PBX-control mode removes Connect overrides.** Setting `Tenant.mohControlMode=pbx`
   (or an extension's `MohExtensionControl.controlMode=pbx`) makes the reconciler
   tombstone **every** Connect key for that scope (`computePbxControlTombstones`),
   and the caller-leg installer emits **no** hook context for a tenant whose
   `moh_class` is empty — native VitalPBX MOH takes over with no stale keys.
4. **Admin multi-tenant schedules override extension pins only while active.** The
   admin overlay (`connect/t_<slug>/admin_moh_class`, `…/extensions/<ext>/admin_moh_class`)
   is read first by both resolvers, so an active admin window (e.g. Yom Tov / holiday)
   beats an extension static pin. When the window ends the overlay keys are
   tombstoned and the pin returns exactly.
5. **Normal tenant schedules do not override pinned extension settings.** Per-tenant
   schedules are folded into the tenant-scope keys at publish time; the resolver
   still prefers an extension pin (`extension_source` > `tenant_*`). Proof:
   `mohAdminSchedule.test.ts` "extension static override beats a tenant schedule".
6. **Queue waiting MOH remains native/separate.** The waiting caller is inside
   `app_queue`, not `[sub-local-dialing]`, so the caller-leg hook never runs there;
   queue waiting music stays the queue's own `music_group_id`. Only the queue
   **post-answer** bridge hold (agent-dial Local leg) is covered.
7. **The live T2 proof patch exists and will be replaced/owned by the installer
   during an approved deploy.** The ad-hoc `/root/connect_t2_localdial_moh.sh`
   remains live on the PBX; the productionized installer supersedes it fleet-wide
   on the next owner-approved deploy. This branch does not touch it.
8. **No deploy has happened yet.** Branch-only; the additive migration
   `20260702000000_moh_control_and_admin_schedules` is committed but **not run**
   anywhere.

### L.2 Final priority order (design choice 1 — Option C, approved 2026-07-01)
Highest → lowest, implemented by `resolveEffectiveMohClass` (`mohCallSource.ts`)
and mirrored in the dialplan resolver read order:

1. Admin multi-tenant active schedule (global takeover; beats ext pins)
2. Extension active schedule
3. Extension static override
4. Tenant active schedule (folded → per-scope, never surprises a pin)
5. Tenant static override
6. Global/admin default (if enabled) — `connect/system/moh_default_class`
7. PBX / native control

### L.3 Data model (design choices 2, 3, 4)
- **Control mode (choice 2 — tenant + extension):** `Tenant.mohControlMode`
  (`connect`|`pbx`); `MohExtensionControl.controlMode` (`inherit`|`connect`|`pbx`).
  Per-source control mode is **intentionally not implemented** this pass (too risky).
- **Admin schedules (choice 3 — separate models):** `MohAdminSchedule`,
  `MohAdminScheduleTarget`, `MohAdminScheduleActivation` — kept fully separate from
  the single-tenant `MohScheduleConfig`/`MohScheduleRule` (undamaged).
- **Fallback (choice 4):** `MohAdminSchedule.fallbackMode` default
  `restore_previous` + optional `fallbackClass`. Activation snapshots
  `previousClass`/`previousControlMode`/`previousKeysSnapshot`/`appliedClass` for
  exact restore. `resolveAdminScheduleFallback()` (`mohSourcePublish.ts`, pure +
  unit-tested) decides `restore_previous` vs `set_class`.

### L.4 Publisher / reconciler (worker)
`apps/worker/src/main.ts`:
- `runMohScheduleCycle()` — per-tenant publish; **skips** tenants with
  `mohControlMode=pbx`.
- `runMohAdminScheduleCycle()` — runs **every 60s AND once on startup**
  (missed activations/restores reconciled). Ledger-driven + idempotent:
  OPEN activations for new winners (snapshotting prior state), RESTORE (tombstone
  overlay-only keys) for ended/disabled/deleted windows. Restart-safe.

### L.5 Coverage matrix (tests — all green)
| Requirement | Proof (test) | Status |
|---|---|---|
| tenant switch A→B→A, no stale keys | `mohAdminSchedule` "tenant switch A→B→A" | ✅ |
| tenant/ext Connect↔PBX control | `mohControl` normalize + `computePbxControlTombstones` | ✅ |
| stale tenant/ext keys removed | `mohAdminSchedule` `computeForwardKeyClears` / `isClearableForwardKey` | ✅ |
| unavailable playlist refused | `mohCatalog` playability (`no_files`/`not_loaded`/`deactivated`) | ✅ |
| ext override beats tenant static / schedule | `mohAdminSchedule`, `mohScenarios` 5 | ✅ |
| ext inherits tenant default; ext PBX control | `mohControl` `effectiveExtensionControlMode` | ✅ |
| tenant schedule activate/deactivate | `mohScenarios` 10/11 | ✅ |
| admin beats ext static / ext schedule / tenant static | `mohAdminSchedule` (4 tests) | ✅ |
| admin restore_previous exact | `mohAdminSchedule` restore proofs | ✅ |
| admin explicit fallback decision | `mohAdminSchedule` `resolveAdminScheduleFallback` (3 tests) | ✅ (logic; live-wiring deferred, see M) |
| multi-tenant fan-out to many tenants | `mohAdminSchedule` `computeActiveAdminOverrides` | ✅ |
| no stale schedule residue | `mohAdminSchedule` "no stale AstDB keys" | ✅ |
| inbound direct/IVR/RG/post-answer queue hold | installer `.test.ts` + `mohScenarios` 1-4 | ✅ |
| queue waiting native; outbound not regressed | installer `.test.ts`; `mohScenarios` 6 | ✅ |
| transfers not misclassified | `mohScenarios` 7/8 | ✅ |
| non-enabled / PBX-controlled tenants no-op | installer "emitted ONLY for tenants with slug+moh_class" | ✅ |
| installer rollback removes only its own lines/files | installer `.test.ts` rollback | ✅ |
| live loaded selectable / unplayable blocked | `mohCatalog` playability | ✅ |
| main/global cross-tenant; foreign native-sync skip | `mohCatalog` origin + native-sync-skip | ✅ |
| live post-publish verify reads back state | `mohControl` `classifyMohVerify` | ✅ |

Totals: `@connect/shared` MOH suites **70**, `apps/api mohControl` **6**,
caller-leg installer **20** = **96 pass / 0 fail**.

## M. Phase 9 — production-safety deliverable

1. **Code diff summary (this pass, on top of `23ea6c6b`):** pure helper
   `resolveAdminScheduleFallback` (`packages/shared/src/mohSourcePublish.ts`) + 3
   unit tests; docs (`ASTDB_KEYS.md`, this file, `DATA_MODEL.md`, `CHANGELOG_AI.md`).
   No runtime/reconcile/installer behavior changed in this pass.
2. **Schema diff summary:** none new. `Tenant.mohControlMode` +
   `MohExtensionControl` + `MohAdminSchedule(+Target,+Activation)` +
   `MohPublishRecord`/`MohLastPublishedState` verify/control columns — all authored
   in `23ea6c6b`, fully additive (nullable/defaulted), nothing dropped/back-filled.
3. **Exact migration files:**
   `packages/db/prisma/migrations/20260702000000_moh_control_and_admin_schedules/{migration.sql,ROLLBACK.sql}`
   — committed, **NOT run** anywhere.
4. **Exact files changed (this pass):** `packages/shared/src/mohSourcePublish.ts`,
   `packages/shared/src/mohAdminSchedule.test.ts`,
   `docs/pbx/connect-moh-per-source-phase2-proof.md`,
   `docs/ai-context/ASTDB_KEYS.md`, `docs/ai-context/DATA_MODEL.md`,
   `docs/ai-context/CHANGELOG_AI.md`.
5. **Exact docs updated:** the four docs in (4).
6. **Tests run + results:** `@connect/shared` MOH suites, `apps/api mohControl`,
   caller-leg + tenant-moh installer string-shape suites — **all green** (see §L.5),
   plus `tsc` typecheck for shared/api/worker.
7. **Exact installer behavior:** caller-leg installer (`§K`) inserts one guarded
   `GosubIf` in `[sub-local-dialing]`, emits `[T<id>_before-local-dial-moh-hook]`
   only for tenants with a published `moh_class` (PBX-controlled/empty-class ⇒ no
   context ⇒ no-op), reads `admin_moh_class`→`moh_class`→`active_moh_class`,
   idempotent + anchor-guarded + `--rollback`. Tenant-moh installer emits
   `[sub-connect-tenant-moh]` with the full precedence incl. admin overlay + global
   default.
8. **Rollback plan:** installer `--rollback` (surgical); AstDB overlay/per-source
   keys are tombstoned by the reconciler on config change; DB `ROLLBACK.sql` drops
   the new tables/columns (additive, safe). No prod state touched by this branch.
9. **Tenant-by-tenant risk:** default `mohControlMode=connect` preserves current
   behavior for every existing tenant; admin schedules are opt-in (none seeded);
   per-tenant publish unchanged until an owner acts. T2 unaffected by this pass.
10. **Live T2 proof patch:** untouched; remains active. Will be owned/replaced by
    the productionized caller-leg installer on the next approved deploy.
11. **Will the branch installer cleanly replace the live proof patch?** Yes — the
    installer writes the same `[T2_before-local-dial-moh-hook]` context + the single
    guarded `GosubIf`, idempotently; running it supersedes the ad-hoc script. Verify
    with `--check` post-deploy.
12. **Exact deploy commands (NOT run):** apply migration only via the api deploy
    path (`scripts/deploy-api.sh`, runs `prisma migrate deploy` when
    `packages/db/prisma/**` changed); deploy api+portal+worker via approved
    blue/green (`scripts/deploy-direct.sh api|portal --branch …`); run
    `sudo scripts/pbx/install-connect-caller-leg-moh.sh` +
    `install-connect-tenant-moh-dialplan.sh` on the PBX (owner-approved).
13. **What was not touched:** no live PBX, no AstDB write, no Apply Changes, no
    migration run, no deploy, no wake/cos-wake/mobile files, no queue/trunk/route/IVR/
    ring-group config, no unrelated dirty working-tree files.
14. **No unrelated files committed:** only the MOH files in (4) are staged/committed.

### M.1 One deferred item (explicit-fallback live wiring) — ✅ DONE (see §N)
`resolveAdminScheduleFallback` (choice 4's optional explicit fallback) was previously
implemented + tested as pure logic while the worker reconciler only implemented the
**default** `restore_previous`. That gap is now **closed** — see §N below.

---

## N. Explicit admin-schedule fallback — LIVE-WIRED (2026-07-01)

The admin (multi-tenant) schedule reconciler now honors **both** end-of-window
modes on the live worker path (`apps/worker/src/main.ts` → `runMohAdminScheduleCycle`).

### N.0 The naming trap that was fixed
The persisted/API `fallbackMode` token is **`"explicit"`** (`apps/api`
`adminScheduleBodySchema` = `z.enum(["restore_previous","explicit"])`), but the
original pure helper only matched `"fallback_class"`. It therefore could **never**
have fired on real data. `resolveAdminScheduleFallback` now treats **`"explicit"`**
as the live token and keeps `"fallback_class"` as a tolerated alias.

### N.1 Semantics (exactly as wired)
- **`restore_previous` / empty / unknown mode** → tombstone ONLY the admin-overlay
  keys (unchanged). The untouched extension/tenant/PBX-control keys re-take effect
  with zero stale keys. **No class is written.**
- **`explicit`** → in addition to clearing the overlay, publish the fallback class as
  the **tenant-level** Connect-managed default (`connect/t_<slug>/moh_class` +
  `active_moh_class`) for the affected tenant, and persist it to
  `MohLastPublishedState.mohClass` so later admin OPENs snapshot the right baseline.
- **Extension precedence after end:** the fallback lands at **tenant** scope, and the
  resolver reads extension keys BEFORE tenant defaults — so a pinned extension still
  wins after the overlay clears. The explicit fallback is the tenant post-schedule
  baseline, **not** a permanent extension override.
  - **Owner-review note (RESOLVED — see Section O):** the earlier build published an
    *extension-scoped* target's explicit fallback at **tenant** scope. That is now
    corrected — extension-scoped explicit fallback is **blocked** (API + worker), and
    only **whole-tenant** targets can set a tenant-level explicit fallback class.

### N.2 Safety gates (design-C)
1. **Invalid/unsafe class** → refused via the same `isValidMohRuntimeClass` publish
   validation and **fails safe to `restore_previous`** (never publishes a broken
   state); a warning is logged with the refused class.
2. **Missing/empty class** → `restore_previous` (fail-safe, no warning).
3. **PBX-controlled tenant** (`Tenant.mohControlMode="pbx"`) → the explicit fallback is
   **skipped** (never forces Connect control onto a native-MOH tenant); logged.
4. **Highest-priority** valid explicit fallback wins when multiple activations end at
   once; each tenant resolves independently (multi-tenant safe).

### N.3 Idempotency / restart / partial-failure safety
- The per-slug **signature guard** (`_mohAdminSignature`) means an unchanged desired
  key set is a no-op; a re-tick never double-writes.
- **Publish happens BEFORE the ledger is closed.** On a publish failure the signature
  and the activation ledger are left intact, so the whole transition (overlay
  tombstone + fallback publish + ledger close) is retried on the next 60 s tick and on
  startup. This closes the "ledger closed but publish failed" gap for the fallback
  path specifically.
- The fallback `moh_class`/`active_moh_class` keys are tenant-default keys (never
  overlay keys), so they are **never** tombstoned by the overlay-clear logic.

### N.4 Pure, unit-tested decision layer
All decisions live in pure, tested helpers in `packages/shared/src/mohSourcePublish.ts`:
- `resolveAdminScheduleFallback` — token mapping (`explicit`/alias) → set_class.
- `planAdminScheduleFallback` — layers `isValidMohRuntimeClass` (design-C validity).
- `selectAdminFallbackTenantClass` — PBX-skip + highest-priority + refusal collection.
- `buildAdminFallbackTenantClassKeys` / `tenantDefaultClassKeys` — the tenant-level keys.
The worker is a thin caller of these. Coverage: `mohAdminSchedule.test.ts` (explicit
token, valid/invalid/missing, custom validator, PBX skip, multi-tenant, extension-pin
precedence return, deterministic key set).

### N.5 Test results (this pass)
- `@connect/shared` MOH suites (incl. `mohAdminSchedule.test.ts`): **99 passed / 0 failed**.
- `apps/api` `mohControl.test.ts`: **6 passed / 0 failed**.
- Installer string-shape suites (caller-leg + tenant-moh-dialplan): **72 passed / 0 failed**.
- `tsc` on `@connect/shared` + `apps/worker`: MOH files clean; only the known,
  unrelated pre-existing `webrtcGlobalOutageAlerts.test.ts` / `@connect/shared/*`
  subpath tsc-direct errors remain (out of scope).

### N.6 Guardrails honored
- **No schema change** — `fallbackMode`/`fallbackClass` already existed.
- **No migration run**, **no deploy**, **no live PBX**, **no AstDB write**, **no
  installer run**, **no Apply Changes**.
- **Live T2 proof patch untouched.**
- The separate `20260426020000` from-empty migration replay bug is **not** touched in
  this branch (tracked in `docs/ops/FOLLOWUP-migration-replay-storageKey.md`).

## O. Target-scope fallback correction (2026-07-01)

**Business rule enforced:** *admin schedule fallback must follow the target scope.*
An extension-targeted schedule must never permanently alter tenant-level defaults.

### O.1 Behavior chosen for extension-scoped explicit fallback → **BLOCK**
Extension-level explicit fallback is **not safely supportable with the current key
model**: the only extension-default key (`connect/t_<slug>/extensions/<ext>/moh_class` /
`active_moh_class`) is **owned and rewritten by the extension static-override publish
path**. Writing it from the admin-fallback path would (a) clobber the extension's own
pin and (b) leave an **untracked ghost key** (there is no per-extension
`MohLastPublishedState` to rewrite it). So the mission's **"OR block"** branch is taken:

| Target scope | `restore_previous` | `explicit` fallback |
| --- | --- | --- |
| Whole-tenant (`extension=""`) | tombstone overlay only | **allowed** → tenant-level `moh_class`/`active_moh_class` + `MohLastPublishedState.mohClass` |
| Extension (`extension="<ext>"`) | tombstone overlay only | **blocked** — must use `restore_previous` |

### O.2 Two-layer enforcement
1. **API (write-time):** `adminScheduleTargetScopeError` (`apps/api/src/mohControl.ts`)
   rejects create/patch of an admin schedule with `fallbackMode="explicit"` (or the
   `fallback_class` alias) when **any** target is extension-scoped →
   `400 extension_scoped_explicit_fallback_unsupported`. Wired into both
   `POST` and `PATCH /voice/moh/admin-schedules`.
2. **Worker (runtime fail-safe / defense-in-depth):** `selectAdminFallbackTenantClass`
   only lets **whole-tenant** (`extension===""`) candidates produce a tenant-level
   `appliedClass`. Any extension-scoped explicit candidate (e.g. a legacy row created
   before the API block) is recorded in `blockedExtensionScoped` and falls back to
   `restore_previous` — it **can never** write `connect/t_<slug>/moh_class`. Logged per
   schedule id.

### O.3 What is unchanged
- Tenant-scoped explicit fallback: **unchanged** (still tenant-level).
- `restore_previous`: **unchanged** at every scope (tenant and extension) — the default,
  safest behavior; extension overlays clear and the pinned/default class re-takes effect.
- PBX-controlled tenants: **unchanged** (explicit fallback still skipped, never forced).
- No stale keys / no ghost tenant override: an extension schedule never writes a tenant
  or extension default key on end — it only tombstones its own overlay.

### O.4 Tests (this pass — focused MOH suites only)
- `packages/shared/src/mohAdminSchedule.test.ts`: **36 passed / 0 failed** — incl.
  tenant-scoped explicit *writes* tenant class, extension-scoped explicit does **not**
  (blocked → `blockedExtensionScoped`), mixed targets (only whole-tenant lands even at
  lower priority), extension `restore_previous` not flagged.
- `apps/api/src/mohControl.test.ts`: **9 passed / 0 failed** — `adminScheduleTargetScopeError`
  allow whole-tenant explicit, block extension explicit + alias + mixed, allow
  `restore_previous`/unknown at any scope.
- Installer string-shape suites (caller-leg + tenant-moh-dialplan): **72 passed / 0 failed**.

### O.5 Guardrails honored
- **No schema change** (target `extension` already exists on `MohAdminScheduleTarget`).
- **No migration run**, **no deploy**, **no production DB**, **no live PBX**, **no AstDB
  write**, **no installer run**, **no Apply Changes**.
- **Live T2 proof patch untouched.** `20260426020000` replay bug untouched.

## P. Long-term caller-leg hardening — generic runtime hook (2026-07-02)

**Goal.** Make the caller-leg (inbound-hold) MOH coverage independent of *"did this
tenant have MOH published when the installer last ran."* Previously
`install-connect-caller-leg-moh.sh` generated one `[T<tid>_before-local-dial-moh-hook]`
context per tenant that had a published class in `connect/pbx_tenant_map` — which is why
only `T2 T3 T21` were live. A tenant that published (or was first mapped) later stayed a
no-op until someone re-ran the installer, and `--check` false-negatived (see P.6).

**Branch:** `feature/moh-long-term-hardening` (from `feature/moh-per-call-source-clean`
@ `8d92ba13`). **Repo-only** — no deploy, no live PBX, no AstDB write, no installer run,
no Apply Changes, no migration. No app/worker/portal/schema change (none needed).

### P.1 Decision — generic runtime hook (preferred), not per-tenant generation
The installer now installs **ONE** Connect-owned context, `[connect-localdial-moh]`, in
`extensions__67_connect_localdial_moh.conf`. It resolves the tenant at **call time** from
`${TENANT_PREFIX}` + AstDB — the exact dynamic-resolution technique already proven in
production by the called-leg resolver `[sub-connect-tenant-moh]`
(`install-connect-tenant-moh-dialplan.sh` / `extensions__65`). The baseplan GosubIf is
migrated to dispatch to the **fixed** context name (no `${TENANT_PREFIX}` in the dispatch):

```
; [sub-local-dialing], immediately after the U(sub-before-bridging-call anchor:
same => n,GosubIf($[${DIALPLAN_EXISTS(connect-localdial-moh,s,1)}=1]?connect-localdial-moh,s,1)

[connect-localdial-moh]                      ; the ONE generic context (in __67)
exten => s,1,NoOp(Connect generic caller-leg MOH hook prefix=${TENANT_PREFIX} …)
 same => n,Set(CONNECT_MOH_TID=${FILTER(0-9,${TENANT_PREFIX})})           ; T2_ → 2
 same => n,ExecIf($["${CONNECT_MOH_TID}" = ""]?Set(CONNECT_MOH_TID=${FILTER(0-9,${CUT(TRANSFER_CONTEXT,_,1)})}))
 same => n,GotoIf($["${CONNECT_MOH_TID}" = ""]?done)                       ; no tid ⇒ no-op
 same => n,Set(CONNECT_MOH_SLUG=${FILTER(A-Za-z0-9_-,${DB(connect/pbx_tenant_map/${CONNECT_MOH_TID}/slug)})})
 same => n,GotoIf($["${CONNECT_MOH_SLUG}" = ""]?done)                      ; no slug ⇒ no-op
 same => n,Set(CONNECT_MOH_CLASS=${DB(connect/t_${CONNECT_MOH_SLUG}/admin_moh_class)})
 same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_${CONNECT_MOH_SLUG}/moh_class)}))
 same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_${CONNECT_MOH_SLUG}/active_moh_class)}))
 same => n,GotoIf($["${CONNECT_MOH_CLASS}" = ""]?done)                     ; no class ⇒ no-op
 same => n,Set(CHANNEL(musicclass)=${CONNECT_MOH_CLASS})
 same => n,Set(__CONNECT_MOH=${CONNECT_MOH_CLASS})
 same => n(done),Return()
```

**Feasibility proof (why generic is safe on this build):** every idiom above is already
running in production in `[sub-connect-tenant-moh]` — `FILTER(0-9,…)` tenant-id parse,
`${DB(connect/pbx_tenant_map/${…}/slug)}` dynamic read, `${DB(connect/t_${slug}/…)}`
dynamic class read, and `GotoIf …?done → Return()` fail-safe. `${TENANT_PREFIX}` is
available in `[sub-local-dialing]` (the pre-hardening GosubIf used it; the **live T2 hold
test passed**, i.e. it expanded to `T2_`).

### P.2 How current tenants are covered
Any tenant whose `connect/pbx_tenant_map/<tid>/slug` + a class key
(`admin_moh_class`/`moh_class`/`active_moh_class`) exist resolves at call time — no
per-tenant context, no hard-coded ids. T2/T3/T21 keep working (same keys, same slug).

### P.3 How future tenants are covered — **zero regeneration**
**Linchpin:** `apps/api/src/mohReverseMapPublish.ts` writes
`connect/pbx_tenant_map/<pbxTenantId>/{slug,moh_class}` on **every** MOH publish (rollback
mirrors it). So the first time *any* tenant (existing or brand-new) publishes MOH, its
reverse-map slug + class appear, and the generic hook resolves it on the very next held
call — **without** re-running the installer or regenerating any PBX file.

### P.4 What happens when no MOH is published / native control / deleted
Missing tenant map, missing slug, empty/tombstoned class, or a tenant handed back to
PBX/native control (all Connect keys tombstoned) ⇒ each `GotoIf …?done` fires ⇒ bare
`Return()` ⇒ `CHANNEL(musicclass)` untouched ⇒ native VitalPBX `default`. Never hangs up,
redirects, or alters CDR/recording.

### P.5 What happens after VitalPBX "Apply Changes"
Apply Changes / upgrade rewrites `extensions__20-baseplan.conf` and drops the inserted
GosubIf line (the `__67` file + `#tryinclude` survive). Re-running the installer
re-inserts the single line, idempotently. Until then the caller-leg hook is simply a
no-op (called-leg/outbound MOH is unaffected).

### P.6 `--check` false-negative — root cause + fix
**Root cause:** the old `do_health_check` sampled the **lowest** tid from
`connect/pbx_tenant_map` (which contains *all* mapped tenants — 1, 8, 29, 33, 35…) and
grepped `dialplan show T<tid>_before-local-dial-moh-hook`. Since hooks existed only for
published T2/T3/T21, sampling an unpublished low tid returned nothing → **FAIL**, even
though the GosubIf and the real hooks were healthy.
**Fix (falls out of the generic design):** `--check` now verifies the **single**
`[connect-localdial-moh]` context — no per-tenant sampling. It PASSes only when: anchor
count = 1; baseplan carries the generic GosubIf **and** no legacy per-tenant line; `__67`
exists; `__60_custom` `#tryinclude`s it; exactly one on-disk definition of
`[connect-localdial-moh]` owned by `__67`; no leftover `[T<n>_before-local-dial-moh-hook]`
context; no manual `extensions__66*` caller-leg patch; the live `[sub-local-dialing]` shows
the `connect-localdial-moh` token (single-token grep ⇒ tolerant of Asterisk
spacing/formatting); and the live `[connect-localdial-moh]` context shows the official
sentinel NoOp.

### P.7 How to run / re-run / rollback (owner-run later; NOT run here)
- **Install / re-apply / migrate:** `sudo ./install-connect-caller-leg-moh.sh` — idempotent;
  migrates a legacy `${TENANT_PREFIX}before-local-dial-moh-hook` line to the generic line
  (timestamped baseplan backup; surgical).
- **Health check:** `sudo ./install-connect-caller-leg-moh.sh --check` (read-only).
- **Rollback:** `sudo ./install-connect-caller-leg-moh.sh --rollback` — removes only the
  Connect-owned baseplan line(s) (generic **and** any legacy), the `__67` file, and the
  `#tryinclude`. Never touches AstDB, native VitalPBX MOH config, routes/trunks/queues/
  IVRs/ring-groups/extensions, or old manual backups.

### P.8 Validation status
- **Live T2 inbound hold already passed** with `moh2` (2026-07-01, §K) — the generic hook
  resolves T2 via the identical keys, so behavior is preserved.
- **Required after the owner re-runs the hardened installer:** because it changes the
  baseplan line + `__67` shape, re-validate **T2 inbound hold** once, then spot-check
  **T3 / T21** and **at least one previously-unpublished tenant** (publish MOH, place a
  held inbound call, confirm the chosen class plays with no installer re-run).
- **Fleet checklist:** for each tenant — `--check` PASS; `database get connect/t_<slug>
  moh_class` returns the expected class; a held inbound call plays it; unpublished tenants
  play native `default` (no error).
- **No portal branch reconciliation was performed** here — the production portal is a
  separate live line carrying voicemail/roles/permissions work; this branch changes only
  the PBX installer, its tests, and docs.

### P.9 Tests
`bash -n scripts/pbx/install-connect-caller-leg-moh.sh` clean; string-shape suite
`scripts/pbx/install-connect-caller-leg-moh.test.ts` **32 passed / 0 failed** (generic
dispatch, TENANT_PREFIX derivation, no-op guards for missing tid/slug/class, admin→moh→
active order, metadata-only, legacy→generic migration, duplicate/`__66`/legacy-context
`--check` failures, read-only `--check`, surgical rollback).

### P.10 Guardrails honored
- **No deploy, no live PBX, no installer run, no `--rollback`, no AstDB mutation, no Apply
  Changes, no `database put/del/deltree`, no Asterisk reload/restart, no production DB, no
  API/worker/portal deploy, no migration.**
- **No app/worker/portal/schema change** — the generic hook reads keys the API/worker
  already publish.
- **Unrelated dirty files (mobile/telephony/wake/cos-wake/`_latency_logs`) untouched.**
