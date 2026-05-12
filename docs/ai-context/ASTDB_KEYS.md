# AstDB Key Reference (Option A)

> **Documentation only.** This file *describes* the runtime AstDB keys
> Connect writes/reads on VitalPBX. **Do not change any of these
> behaviors from this doc** — the canonical contract lives in:
>
> - `docs/pbx/option-a-runtime-keys.md` — full schema, defaults, and
>   fallback semantics.
> - `docs/pbx/option-a-custom-context.conf` — the dialplan that reads the
>   keys (the **only** Asterisk-side consumer of `connect/t_<slug>`).
> - `apps/telephony/src/routes/telephony.ts` (lines ~335–500) — the
>   `internal/ivr-publish` and `internal/astdb-read-family` writers, and
>   the family-scope guard.
>
> If those three diverge from this cheat sheet, **the canonical files
> win**. This file is a lookup index.

---

## Family scoping (security boundary)

Connect's tenant isolation in AstDB is enforced by **family-name
prefixing**. Any AMI `DBPut` / `DBGet` whose family does not match the
tenant's slug is rejected by the telephony service (HTTP 400
`family_scope_mismatch`).

Three families are recognized:

| Family | Scope | Purpose |
|---|---|---|
| `connect/t_<tenant_slug>` | per-tenant | IVR routing, MOH, hold announcements, schedule mode, override state |
| `connect/didmap/<e164>` and `connect/didmap/<digits>` | per-DID | DID-level overrides (tenant lookup, profile, MOH class, hold) |
| `connect/system` | global | runtime configuration shared by all tenants (wake API URL, secret, wait time) |

`tenant_slug` is computed from `Tenant.name` by:

```
slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
```

The slug-builder lives in two places that **must remain identical**:

- `toIvrSlug` in `apps/api/src/server.ts`
- `ivrToIvrSlug` in `apps/worker/src/main.ts`

If they drift, publishes from the API and the worker write to different
families and the dialplan reads stale data.

---

## Family A — `connect/t_<slug>` (per-tenant runtime)

### Phase 1 — single-destination router (`[connect-tenant-router]`)

| Key | Type | Allowed values | Default | Read by |
|---|---|---|---|---|
| `mode` | string | `business` \| `afterhours` \| `holiday` \| `override` | (absent ⇒ fallback) | `[connect-tenant-router]` |
| `dest_business` | string | `<context>,<exten>,<priority>` or `""` | `""` | router when `mode=business` |
| `dest_afterhours` | string | same | `""` | router when `mode=afterhours` |
| `dest_holiday` | string | same | `""` | router when `mode=holiday` |
| `dest_override` | string | same | `""` | router when `mode=override` |
| `override_expires` | string | unix epoch seconds (integer) | `"0"` | advisory only — Connect enforces the actual expiry |

### Phase 2 — Connect-owned IVR menu (`[connect-tenant-ivr]`)

These are the per-digit option keys plus greeting / retry control.

| Key | Type | Allowed values | Default | Read by |
|---|---|---|---|---|
| `active_prompt` | string | VitalPBX recording ref (e.g. `custom/acme_normal`, no extension) or `""` | `""` ⇒ play `vm-enter-num-to-call` | `[connect-tenant-ivr]` |
| `active_prompt_invalid` | string | recording ref or `""` | `""` ⇒ skip | `[connect-tenant-ivr]` `i` exten |
| `active_prompt_timeout` | string | recording ref or `""` | `""` ⇒ skip | `[connect-tenant-ivr]` WaitExten loop |
| `timeout_seconds` | string (int) | `1`..`60` | `7` | `[connect-tenant-ivr]` WaitExten |
| `max_retries` | string (int) | `1`..`10` | `3` | retry counter |
| `opt_0/dest` … `opt_9/dest` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-option-router]` |
| `opt_star/dest` | string | same | `""` | when digit = `*` |
| `opt_hash/dest` | string | same | `""` | when digit = `#` |
| `opt_<digit>/type` | string | `extension` \| `queue` \| `ring_group` \| `voicemail` \| `ivr` \| `announcement` \| `external_number` \| `terminate` \| `custom` \| `""` | `""` | metadata only — not consumed by dialplan |

> **Fixed-size key set.** Every publish writes every digit slot (empty
> string for unused digits) so the family has a deterministic shape and
> rollback is lossless.

### MOH / Hold (still under `connect/t_<slug>`)

Written by `runMohScheduleCycle()` in `apps/worker/src/main.ts` and by
`/voice/moh/*` in `apps/api`.

| Key | Type | Purpose |
|---|---|---|
| `active_moh_class` | string | active MOH class name (e.g. `default`, `tenant_acme`) — primary |
| `moh_class` | string | duplicate of `active_moh_class` for legacy consumers |
| `hold_mode` | string | `quiet`, `music`, or scheduled-mode label |
| `hold_announcement_enabled` | string | `"1"` / `"0"` |
| `hold_announcement_ref` | string | VitalPBX recording ref or `""` |
| `hold_announcement_interval` | string (int) | seconds between repeats (default `30`) |
| `hold_announce` | string | resolved announcement ref (only when enabled) — convenience read for dialplan |

### Per-extension MOH overrides (Phase 3A writer 2026-05-11; resolver = Phase 3B, preflight-only 2026-05-12)

Subfamily under `connect/t_<slug>/extensions/<extension>/*`. Written by
`apps/api` `POST /voice/moh/publish` (`doMohPublish`) and by its rollback
counterpart, both via `apps/api/src/mohExtensionOverride.ts` helpers.
**No Asterisk consumer yet** — the installed `[sub-connect-tenant-moh]`
resolver still reads only the tenant-scope keys. Phase 3B will splice in
the per-extension read path; the design is pinned in
`docs/pbx/phase-3b-moh-extension-resolver-design.md` and its install gate
is the read-only diagnostic
`scripts/pbx/diag-connect-moh-extension-key-readiness.sh` (must exit 0
on the canary PBX before any resolver edit).

| Family | Key | Type | Purpose |
|---|---|---|---|
| `connect/t_<slug>/extensions/<ext>` | `moh_class` | string | per-extension MOH class override (mirrors tenant-default `moh_class`) |
| `connect/t_<slug>/extensions/<ext>` | `active_moh_class` | string | duplicate alias for legacy/dual-read consumers |

- `<ext>` is the canonical channel-name token (the second segment of
  `PJSIP/T<id>_<extension>-…`), validated as `[A-Za-z0-9_-]{1,32}`.
- Empty-string is a **tombstone** written by the rollback handler when
  the rolled-back publish ADDED keys that did not exist before. The
  Phase 3B resolver MUST treat empty `moh_class` under this family as
  "no override — fall through to tenant default."
- Helpers `extensionMohClassFamily` / `extensionMohClassKey` /
  `extensionActiveMohClassKey` build the canonical strings; do not
  hand-concatenate.

### Push-wake (lives under `connect/t_<slug>` per tenant)

Written by `apps/api/src/server.ts` and by the IVR publish path. Read by
the wake-then-dial wrapper in
`scripts/pbx/install-connect-wake-dialplan.sh`.

| Key | Type | Purpose |
|---|---|---|
| `wake_user_<ext>` | string | per-extension routing hint for push-wake (UNKNOWN — verify exact value shape before changing; check `install-connect-wake-dialplan.sh`) |

> The wake wrapper also reads three **global** keys under
> `connect/system/*` (see Family C below).

---

## Family B — `connect/didmap/<e164>` (per-DID overrides)

Written by `apps/api` `/voice/did/*` (DID-routing UI). Read by the
shared inbound-routing custom contexts. **Both `+E.164` and raw-digits
forms are accepted** so dialplan lookups don't need to format-massage.

| Key | Type | Purpose |
|---|---|---|
| `tenant` | string | `tenant_slug` for the DID's owning tenant |
| `profile_id` | string | active `IvrRouteProfile.id` or `""` |
| `moh_class` | string | resolved MOH class name or `""` |
| `hold_announce` | string | hold announcement recording ref or `""` |
| `hold_repeat` | string (int) | seconds between hold-announcement repeats |

These keys are referenced in `schema.prisma` near `model DidRouteMapping`
(line ~2465) which also documents the field meanings.

---

## Family D — `connect_vm_dial` and `connect_vm_context` (PBX helper — vm-record)

These two families are written by the **PBX helper** (`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`) directly via `asterisk -rx "database put …"` — **not** via `apps/telephony`'s AMI proxy. They are read exclusively by the `[connect-vm-greeting-dispatch]` dialplan context installed by the same helper. They have no family-scope guard and are intentionally local to the PBX.

| Family | Key | Type | Purpose | Written by |
|---|---|---|---|---|
| `connect_vm_dial` | `T<tenant>_<ext>` | string | PJSIP dial string for all registered endpoints (e.g. `PJSIP/T21_101&PJSIP/T21_101_1`) — read by dispatch to fan-out the recording call | `vm_record_call()` in PBX helper before originate |
| `connect_vm_context` | `T<tenant>_<ext>` | string | Resolved VitalPBX voicemail context name (e.g. `test-voicemail`) — read by dispatch dialplan and passed as `ARG1` to `connect-vm-greeting-record-sub` so recordings go to the correct spool path | `vm_record_call()` after calling `resolve_voicemail_context_from_conf()` |

**Why `connect_vm_context` is needed:** VitalPBX names each tenant's voicemail context after the tenant's slug (`test-voicemail`, `comfort_control-voicemail`, etc.), not the numeric tenant id (`21`). The dialplan must write to `/var/spool/asterisk/voicemail/<context>/<ext>/` — not `/var/spool/asterisk/voicemail/21/<ext>/`. Phase C (2026-05-07) introduced this key to bridge the helper's resolved context to the dialplan.

**Fallback:** If `connect_vm_context/T<n>_<ext>` is absent or empty in AstDB (e.g. tenant never triggered a new vm-record originate after Phase C deployed), the dispatch dialplan falls back to `${CONNECT_VM_TENANT}` (the raw numeric tenant id from the extension number), preserving pre-Phase-C behavior.

---

## Family C — `connect/system` (global)

Single global family used by every tenant's wake-then-dial wrapper. No
per-tenant data lives here. Allowed from any `tenantSlug` request body
because the wrapper needs these three keys for *any* tenant's call.

| Key | Type | Purpose | Source |
|---|---|---|---|
| `wake_api_url` | string | URL to POST the call-wake notification to | written by Connect API on system bootstrap |
| `wake_api_secret` | string | bearer secret for the wake POST | same |
| `wake_wait_secs` | string (int) | seconds the wrapper waits for `DEVICE_REGISTER_COMPLETE` before fall-through | same |

If `wake_api_url` is empty/absent, the wrapper short-circuits the wake
step (PBX-only behavior). Reference: lines ~323–325 of
`scripts/pbx/install-connect-wake-dialplan.sh`.

---

## Writers / readers by service

| Service | File | Writes | Reads |
|---|---|---|---|
| `apps/api` | `apps/api/src/server.ts` (`/voice/ivr/*`, `/voice/moh/*`, `/voice/did/*`) | all three families via `/telephony/internal/ivr-publish` | snapshots via `/telephony/internal/astdb-read-family` |
| `apps/worker` | `apps/worker/src/main.ts` — `runIvrScheduleCycle()`, `runMohScheduleCycle()` | `connect/t_<slug>/*` (mode flips, MOH publishes) | snapshots before write |
| `apps/telephony` | `apps/telephony/src/routes/telephony.ts` | proxies `DBPut` / `DBGet` to AMI; enforces `family_scope_mismatch` | n/a |
| Asterisk dialplan | `docs/pbx/option-a-custom-context.conf` + `scripts/pbx/install-connect-wake-dialplan.sh` | nothing | every read on every call |

---

## Validation rules (all enforced by `apps/telephony`)

1. `tenantSlug` must match `^[a-z0-9_]+$`.
2. `keys` array must have 1..N entries; each entry must have string
   `family`, `key`, `value`.
3. `family` must start with `connect/t_<tenantSlug>` **or** equal
   `connect/system` **or** equal `connect/didmap/<e164>` (when
   `didE164` is supplied in the request).
4. `didE164`, when supplied, must match `^\+?\d{7,20}$`. Both `+E.164`
   and digits-only families are accepted.
5. AMI must be connected (returns `503 ami_not_connected` otherwise).
6. Snapshot reads (`/internal/astdb-read-family`) cap `keys` at 32 per
   request — bigger snapshots must be paginated by the caller.

---

## Risk assessment

| Class of change | Risk |
|---|---|
| Read a key (snapshot) | **LOW** |
| Add a new key under `connect/t_<slug>` | **HIGH** — dialplan side must be updated in lock-step (`option-a-custom-context.conf`) and a multi-release rollout used: writer-on → reader-on. |
| Rename an existing key | **EXTREME** — equivalent to a breaking API change. Requires migration on the dialplan side too. |
| Change family-scope guard in `apps/telephony` | **EXTREME** — this is the primary cross-tenant defense. |
| Bump `timeout_seconds` / `max_retries` defaults | **LOW** at the schema level (just defaults), but **HIGH** if you change the value in production for an existing tenant — confirm with that tenant first. |

---

## Quick lookup: "where is this key written?"

```
# Find every place a given key name is mentioned (PowerShell):
Select-String -Path apps,packages,scripts,docs -Pattern '"opt_0/dest"' -Recurse
```

```bash
# Or with grep:
grep -rn '"opt_0/dest"' apps packages scripts docs
```

The grep should always yield (a) one or more writer sites (api/worker)
and (b) one or more dialplan sites (`docs/pbx/`,
`scripts/pbx/install-connect-wake-dialplan.sh`). If only one side
shows up, that's a bug — fix it before publishing.

---

## Validation requirements before any change

If a change to AstDB key shape, family scope, or guard rules is
proposed:

1. **Read** `docs/pbx/option-a-runtime-keys.md` end-to-end. It is the
   canonical contract.
2. **Read** `docs/pbx/option-a-custom-context.conf` to confirm what the
   dialplan reads. Keys that nobody reads are dead; keys nobody writes
   are broken.
3. Write a **publish + rollback** plan that:
   - Snapshots the old keys via `/internal/astdb-read-family` first.
   - Writes the new keys via `/internal/ivr-publish`.
   - Stores the snapshot in `IvrPublishRecord.previousKeys` (or
     `MohPublishRecord.previousKeysSnapshot`) so rollback is lossless.
4. **Test on one tenant first** (preferably an internal test tenant).
   Verify `ConnectCdr` rows from real calls show the expected route
   before rolling the change out.
5. **Capture an `astdb show like 'connect/t_<slug>%'` output** before
   and after the publish so the change is auditable.

> **Never bypass `/internal/ivr-publish` and call AMI directly.** The
> family-scope guard is the only thing preventing a misconfigured
> writer from stamping on another tenant's keys.
