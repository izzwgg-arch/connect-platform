# Phase 3B — Per-extension MOH resolver design (preflight only)

**Status:** Preflight design. No PBX install, resolver change, trunk-wrapper
edit, portal UI, worker bulk job, or deploy is shipping in this phase.

**Scope of this doc:** the resolver snippet Phase 3B would splice into
`[sub-connect-tenant-moh]`, the install gate, the rollback contract, and the
risks. The only code shipping alongside this doc is the read-only diagnostic
`scripts/pbx/diag-connect-moh-extension-key-readiness.sh`.

---

## 1. Context

- **Phase 3A** (`apps/api/src/server.ts` `doMohPublish` and its rollback
  handler) writes two AstDB keys per enabled `MohExtensionOverride` on every
  `POST /voice/moh/publish`:
  - `connect/t_<slug>/extensions/<ext>/moh_class`
  - `connect/t_<slug>/extensions/<ext>/active_moh_class`
  Tombstone contract: rollback writes empty-string for keys that the
  rolled-back publish ADDED. The existing AstDB write channel cannot DEL.
- **Asterisk has no reader for this family yet.** The currently-installed
  resolver `[sub-connect-tenant-moh]` (heredoc'd inside
  `scripts/pbx/install-connect-tenant-moh-dialplan.sh`, approx. line 947)
  only reads `connect/t_<slug>/moh_class` with `active_moh_class` fallback.
- Per-extension overrides are therefore persisted and snapshotted on every
  publish but **functionally inert on live calls**. The tenant default still
  plays on hold for every extension.

Phase 3B closes that gap. This document pins the resolver design before any
installer edit is attempted.

---

## 2. Insertion point

The Phase 3B snippet inserts between the existing tenant-id/slug resolution
and the existing tenant-default `moh_class` read — approximately between
`same => n,GotoIf($["${TENANT_SLUG_LOCAL}" = ""]?done)` and
`same => n,Set(MOH_CLASS_LOCAL=${DB(connect/t_${TENANT_SLUG_LOCAL}/moh_class)})`
in the installed heredoc. Nothing above or below this block changes.

Preconditions the existing code already enforces:

- `TENANT_ID` is a non-empty numeric VitalPBX tenant id (from
  `TRANSFER_CONTEXT` / `HINTS_CONTEXT` / `FOLLOWME_CONTEXT` /
  `QUEUE_AGENTS_CONTEXT` via `CUT(…,_,1)`, or from `ARG1` when numeric).
- `TENANT_SLUG_LOCAL` is the Connect slug resolved through
  `DB(connect/pbx_tenant_map/${TENANT_ID}/slug)`.
- If either is empty, the existing `done` branch returns without touching
  `CHANNEL(musicclass)`. The Phase 3B block is unreachable in that case, so
  it inherits the existing fail-safe behaviour.

---

## 3. Resolver snippet

```asterisk
; ── Phase 3B insertion — per-extension MOH override lookup ────────────────
 same => n,Set(EXT_OVR=)
 same => n,Set(CHAN_ENDPOINT=${CHANNEL(pjsip,endpoint)})
 same => n,ExecIf($["${CHAN_ENDPOINT}" = ""]?Set(CHAN_NAME_LOCAL=${CHANNEL(name)}))
 same => n,ExecIf($["${CHAN_ENDPOINT}" = ""]?Set(CHAN_NAME_LOCAL=${CUT(CHAN_NAME_LOCAL,/,2-)}))
 same => n,ExecIf($["${CHAN_ENDPOINT}" = ""]?Set(CHAN_ENDPOINT=${REGEX("^(.+)-[0-9a-fA-F]+$" ${CHAN_NAME_LOCAL})}))
 same => n,Set(CH_HEAD=${CUT(CHAN_ENDPOINT,_,1)})
 same => n,Set(CH_TAIL=${CUT(CHAN_ENDPOINT,_,2-)})
 same => n,GotoIf($["${CH_HEAD:0:1}" != "T"]?skip_ext_ovr)
 same => n,Set(CH_TID=${FILTER(0-9,${CH_HEAD:1})})
 same => n,GotoIf($["${CH_TID}" = ""]?skip_ext_ovr)
 same => n,GotoIf($["${CH_TID}" != "${TENANT_ID}"]?skip_ext_ovr)
 same => n,GotoIf($["${CH_TAIL}" = ""]?skip_ext_ovr)
 same => n,Set(CH_EXT_SAFE=${FILTER(A-Za-z0-9_-,${CH_TAIL})})
 same => n,GotoIf($["${CH_EXT_SAFE}" != "${CH_TAIL}"]?skip_ext_ovr)
 same => n,GotoIf($[${LEN(${CH_EXT_SAFE})} > 32]?skip_ext_ovr)
 same => n,Set(EXT_OVR=${DB(connect/t_${TENANT_SLUG_LOCAL}/extensions/${CH_EXT_SAFE}/moh_class)})
 same => n,ExecIf($["${EXT_OVR}" = ""]?Set(EXT_OVR=${DB(connect/t_${TENANT_SLUG_LOCAL}/extensions/${CH_EXT_SAFE}/active_moh_class)}))
 same => n,GotoIf($["${EXT_OVR}" = ""]?skip_ext_ovr)
 same => n,Set(CHANNEL(musicclass)=${EXT_OVR})
 same => n,Set(__CONNECT_MOH=${EXT_OVR})
 same => n,NoOp(Connect tenant MOH per-extension override applied tenant_id=${TENANT_ID} slug=${TENANT_SLUG_LOCAL} ext=${CH_EXT_SAFE} class=${EXT_OVR})
 same => n,Return()
 same => n(skip_ext_ovr),NoOp(Connect tenant MOH per-extension override skipped tenant_id=${TENANT_ID} slug=${TENANT_SLUG_LOCAL} ch=${CHAN_ENDPOINT})
; Fall through to existing tenant-default read.
```

---

## 4. Contract / invariants

### 4.1 Tenant-id cross-check (MANDATORY)

The extension override MUST only be applied when the tenant id parsed from
`CHANNEL(name)` (or `CHANNEL(pjsip,endpoint)`) equals the `TENANT_ID`
resolved through channel-context vars. This is the cross-tenant defence —
the channel-context vars are the authoritative tenant identity for the
call; the channel-name parse only provides the extension token and a
sanity check on which tenant owns that extension. A mismatch means the
channel has been re-pathed into a foreign tenant context (attended
transfer, misrouted trunk dial, Local channel leak) and reading the
foreign tenant's extension keys under the resolved tenant's slug would be
both wrong and a data-leak vector. **Fail closed to tenant default.**

### 4.2 Extension whitelist

Extension token must match `^[A-Za-z0-9_-]{1,32}$`, mirroring
`EXTENSION_RE` in `apps/api/src/mohExtensionOverride.ts`. Enforced via
`FILTER(A-Za-z0-9_-, …)` equality and `LEN(...)`. A token failing this
check is dropped because it could not have produced a valid write-side
AstDB key family in the first place.

### 4.3 Empty-string is a tombstone, not a value

`Phase 3A` rollback writes `""` to clear keys the rolled-back publish
added. The resolver MUST treat empty-string values as "no override — fall
through to tenant default." `GotoIf($["${EXT_OVR}" = ""]?skip_ext_ovr)`
after both reads honours this. Phase 3A never writes empty-string as a
normal class value, so empty is unambiguous.

### 4.4 Channel-name parse fallbacks

- Preferred: `${CHANNEL(pjsip,endpoint)}`. Returns the clean endpoint name
  (e.g. `T3_302` or `T3_ext-7`) without the hash suffix. No ambiguity with
  `-` inside extension tokens.
- Fallback: parse `${CHANNEL(name)}` = `PJSIP/<endpoint>-<hash>`. Strip
  `PJSIP/` via `CUT(…,/,2-)`, then strip the trailing `-<hash>` via
  `REGEX("^(.+)-[0-9a-fA-F]+$")`. Required for Asterisk builds where
  `CHANNEL(pjsip,endpoint)` is unavailable.

The diagnostic (`diag-connect-moh-extension-key-readiness.sh`, probe 9)
reports which path applies on the canary.

### 4.5 Leg semantics

- **Called / trunk leg** (U-flag path via `[global-before-bridging-call-hook]`):
  `CHANNEL(name)` is the trunk channel (e.g. `PJSIP/trunk33-…`).
  `CH_HEAD` will not start with `T<digits>`; the whitelist check trips
  and the override is skipped. Tenant default applies. This is correct —
  per Asterisk hold semantics, MOH is played to the bridge peer using
  **that peer's** `CHANNEL(musicclass)`. The peer of the trunk leg is the
  extension leg; the extension's musicclass is set by the connect-leg
  shim path below.
- **Caller / connect leg** (shim path via
  `[connect-tenant-moh-connect-shim]` → per-tenant
  `[T<id>_before-connecting-call-hook]`): `CHANNEL(name)` is the
  originating PJSIP endpoint (e.g. `PJSIP/T3_302-<hash>`). The extension
  override resolves correctly here and sets the caller leg's musicclass.
  That is the leg whose audio the extension's user hears when the remote
  side holds. ✅ Matches what an admin expects.
- **Canary outbound trunk wrapper
  (`--enable-trk-wrapper=33`, lines ~784-820 of the installer):**
  The wrapper currently applies tenant default **before** the connect-leg
  shim runs for trunk 33 / tenant T3, so per-extension overrides are a
  no-op on that specific path. This is a known follow-up (separate from
  Phase 3B) and is out of scope here.

### 4.6 No new inheritable vars

`EXT_OVR`, `CHAN_ENDPOINT`, `CHAN_NAME_LOCAL`, `CH_HEAD`, `CH_TAIL`,
`CH_TID`, `CH_EXT_SAFE` are all non-inheritable. `__CONNECT_MOH` is
already set by the pre-existing tenant-default path and its value is
overwritten here.

### 4.7 AstDB read cost

Two additional `DB()` reads per bridged leg on the caller side, both
Berkeley DB point lookups (sub-millisecond). Negligible.

---

## 5. Install gate (required before Phase 3B ships)

1. `sudo bash scripts/pbx/diag-connect-moh-extension-key-readiness.sh`
   exits 0 on the canary PBX.
2. `sudo bash scripts/pbx/diag-connect-moh-preflight-snapshot.sh --tag before-3b`
   captured and retained.
3. At least one non-zero `MohExtensionOverride` row exists for a mapped
   tenant (otherwise the resolver change ships untested).
4. `sudo /root/install-connect-tenant-moh-dialplan.sh --check` exits 0
   (current state is healthy before we edit it).
5. When the Phase 3B installer edit ships, `--check` gets a new HARD
   probe that greps the loaded resolver for the sentinel
   `per-extension override applied` NoOp.
6. Deploy ONLY via the deploy queue per `AGENTS.md` §Hard rules.
7. Rollout: canary tenant (T3 / Secro) only for the first 24h. Sign-off
   requires a live hold test on an extension that has an override
   configured, plus a ConnectCdr check.

---

## 6. Rollback

Zero new rollback surface. Use the existing command
(`install-connect-tenant-moh-dialplan.sh:609-682`):

```bash
ssh connect-pbx "sudo /root/install-connect-tenant-moh-dialplan.sh --rollback"
```

Removes the Connect-owned include, reloads dialplan, restores
byte-identical pre-install behaviour. The per-extension AstDB keys
written by Phase 3A remain; they are inert without the resolver.

Data rollback is independent and continues to be handled by the Phase 3A
rollback handler (tombstone writes) via
`POST /voice/moh/publish/:id/rollback`.

Partial-fail (resolver loads but plays the wrong class): operator runs
`--rollback`, then checks out the previous installer SHA and reinstalls.

---

## 7. Risks

1. **`CHANNEL(pjsip,endpoint)` availability drift** — mitigated by the
   regex fallback; the diagnostic reports which path is active.
2. **VitalPBX endpoint-naming change** — `T<id>_<ext>` is the shape on
   this build. A rename by a future VitalPBX release would trip the
   `CH_HEAD:0:1 != "T"` guard; resolver fails closed to tenant default.
   Caught by live hold test + diagnostic probe 6.
3. **Tombstone collision** — impossible. Phase 3A never writes empty as a
   normal class value.
4. **Cross-tenant guard bypass** — not reachable. `TENANT_ID` is resolved
   from channel-context vars before the Phase 3B block; any divergence
   from `CH_TID` skips the override.
5. **Trunk-33 wrapper pre-empts override** — known gap. Resolved in a
   follow-up that is NOT part of Phase 3B.
6. **AstDB read performance regression** — negligible per §4.7.
7. **Maintainer drift** — a future contributor removing the cross-tenant
   guard or whitelist would silently open a tenant-isolation leak. The
   installer heredoc and this design doc both document the invariants
   explicitly; `SAFE_CHANGE_ZONES.md` classifies any edit to
   `[sub-connect-tenant-moh]` as EXTREME.

---

## 8. What ships alongside this doc (preflight only)

- `scripts/pbx/diag-connect-moh-extension-key-readiness.sh` — read-only
  diagnostic (details in its own header; exit 0 is the Phase 3B install
  gate).
- This design doc.
- Doc updates in `docs/ai-context/{TELEPHONY,DEBUGGING,KNOWN_ISSUES,ASTDB_KEYS}.md`.

Nothing else. No installer edit, no dialplan reload, no deploy.
