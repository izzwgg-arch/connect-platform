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
