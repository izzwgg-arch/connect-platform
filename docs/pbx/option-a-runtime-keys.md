# Connect Option A — Runtime Key Scheme (Canonical)

> **Source of truth for Option A's AstDB schema.** Anything that writes or
> reads these keys (Connect API, Connect worker, telephony service, PBX
> custom context) **must** match this document. When changing this, you
> change all four.

## Family (tenant-scoped)

```
connect/t_<tenant_slug>
```

- `tenant_slug` is derived from `Tenant.name` via:

  ```
  slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  ```

  (See `toIvrSlug` in `apps/api/src/server.ts` and the matching `ivrToIvrSlug`
  in `apps/worker/src/main.ts` — they **must** stay identical.)

- No shared/global keys. Every key lives under this family. The telephony
  service rejects any `DBPut` or `DBGet` whose family does not start with
  `connect/t_<slug>` where `<slug>` matches the tenant slug in the request
  body — that is the primary line of tenant-isolation defense.

## Keys

### Phase 1 — single-destination routing (consumed by `[connect-tenant-router]`)

| Key | Type | Allowed values | Default (if absent) | Read by |
|-----|------|----------------|---------------------|---------|
| `mode` | string | `business` \| `afterhours` \| `holiday` \| `override` | — (absent → fallback) | `[connect-tenant-router]` |
| `dest_business` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=business` |
| `dest_afterhours` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=afterhours` |
| `dest_holiday` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=holiday` |
| `dest_override` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=override` |
| `override_expires` | string | unix epoch seconds (integer) or `"0"` | `"0"` | advisory only (Connect enforces expiry) |

### Phase 2 — per-digit IVR menu + greeting control (consumed by `[connect-tenant-ivr]`)

These additional keys drive the Connect-owned IVR menu. Tenants still on
`[connect-tenant-router]` will have them written to AstDB but ignored — no
behavior change for existing tenants.

| Key | Type | Allowed values | Default (if absent) | Read by |
|-----|------|----------------|---------------------|---------|
| `active_prompt` | string | VitalPBX recording ref (e.g. `custom/acme_normal`, no extension) or `""` | `""` → dialplan plays `vm-enter-num-to-call` | `[connect-tenant-ivr]` |
| `active_prompt_invalid` | string | recording ref or `""` | `""` → skip, re-prompt immediately | `[connect-tenant-ivr]` `i` exten |
| `active_prompt_timeout` | string | recording ref or `""` | `""` → skip, re-prompt immediately | `[connect-tenant-ivr]` WaitExten loop |
| `timeout_seconds` | string (int) | `1`..`60` | `7` | `[connect-tenant-ivr]` WaitExten |
| `max_retries` | string (int) | `1`..`10` | `3` | `[connect-tenant-ivr]` loop counter |
| `opt_0/dest` .. `opt_9/dest` | string | `<context>,<exten>,<priority>` or `""` | `""` → fallback | `[connect-option-router]` |
| `opt_star/dest` | string | same | `""` | `[connect-option-router]` when digit is `*` |
| `opt_hash/dest` | string | same | `""` | `[connect-option-router]` when digit is `#` |
| `opt_<digit>/type` | string | `extension` \| `queue` \| `ring_group` \| `voicemail` \| `ivr` \| `announcement` \| `external_number` \| `terminate` \| `custom` \| `""` | `""` | metadata only — not consumed by dialplan |

**Fixed-size key set.** Every publish writes every digit slot (empty string
for unused digits) so the AstDB family has a deterministic shape. This makes
rollback/snapshot round-trips lossless across publishes that add or remove
digit mappings.

**Value format for `dest_*` and `opt_*/dest`:** a single string
`"<context>,<exten>,<priority>"` suitable for direct `Goto(${DEST})`.
Example: `from-did-direct,s,1`.

**Why not separate context/exten/priority keys?** The dialplan uses exactly
one `DB()` read per `Goto` — keeping them concatenated costs one read, not
three, per call. Small but meaningful at scale.

**Why `opt_star` / `opt_hash` instead of `opt_*` / `opt_#`?** Asterisk's
AstDB tolerates most characters in key names, but `*` and `#` are historically
fragile across AstDB/CLI tooling. The dialplan translates them in the digit
handlers so this stays opaque to admins.

## Fallback behavior

### `[connect-tenant-router]` (Phase 1)

Falls through to `[connect-default-fallback]` when:

- `TENANT_SLUG` channel variable is empty.
- `mode` key is missing or empty.
- `dest_${mode}` key is missing or empty.

### `[connect-tenant-ivr]` (Phase 2)

Falls through to `[connect-default-fallback]` when:

- `TENANT_SLUG` channel variable is empty.
- `RETRIES` reaches `max_retries` without a valid digit.

The Phase 2 dialplan degrades gracefully (never crashes) when:

- `active_prompt` is empty → plays the built-in `vm-enter-num-to-call`.
- `active_prompt_invalid` / `active_prompt_timeout` are empty → skips the
  announcement and re-prompts immediately.
- `timeout_seconds` / `max_retries` are empty or non-numeric → uses defaults
  (`7` and `3`).
- `opt_<digit>/dest` is empty → `[connect-option-router]` falls back to
  `[connect-default-fallback]`.
- A valid `opt_<digit>/dest` points at a non-existent context → Asterisk
  dispatches the `t` (timeout) exten back into the prompt loop, bounded by
  `max_retries`.

`[connect-default-fallback]` plays `vm-goodbye` and hangs up cleanly — calls
are never dropped silently, never spin, never cause a dialplan error.

## Writer contracts

### `apps/api/src/server.ts` — on-demand publish (user-initiated)

- Computes mode via `computeCurrentMode(schedule, override)`.
- Builds the six keys via `buildIvrKeys(slug, mode, profiles, override)`.
- **Snapshots the current values first** via
  `POST /telephony/internal/astdb-read-family` and stores them as
  `IvrPublishRecord.previousKeys`.
- Writes via `POST /telephony/internal/ivr-publish`.

### `apps/worker/src/main.ts` — automated publish (scheduled)

- Runs `runIvrScheduleCycle()` hourly and whenever the computed mode differs
  from the last successful publish.
- Uses the same snapshot-then-write sequence as the API, so worker-generated
  records are fully rollback-able from the UI.

### Telephony — `apps/telephony/src/routes/telephony.ts`

- `POST /telephony/internal/ivr-publish` — `DBPut` per key. Rejects any
  family outside `connect/t_<tenantSlug>`.
- `POST /telephony/internal/astdb-read-family` — `DBGet` per key. Same
  family-scope guard as publish.

## Reader contract

### PBX custom context — `docs/pbx/option-a-custom-context.conf`

Only `[connect-tenant-router]` and `[connect-default-fallback]` read these
keys. They are the **only** Asterisk-side consumers of the `connect/t_<slug>`
family. No other custom context, dialplan hook, or AGI script should read
or write this family.

## Rollback semantics

- Every successful publish writes `IvrPublishRecord.previousKeys` =
  pre-publish AstDB snapshot for the six keys above.
- `POST /voice/ivr/rollback/:publishId` writes `previousKeys` back via
  `DBPut`. A rollback itself snapshots the current state into the new
  rollback record, so "rollback of rollback" (redo) is also supported.
- Records predating snapshot capture (previousKeys = `[]`) return HTTP 409
  `no_snapshot_available`. They are **never** silently re-applied.

## Tenant isolation — four layers

1. **API** — every `/voice/ivr/*` write calls `assertIvrTenantAccess(user, tenantId)`.
2. **DB** — `IvrOverrideState.profileId` and `IvrScheduleConfig.*ProfileId`
   references are validated against `profile.tenantId === request.tenantId`.
3. **API→Telephony** — the request body's `tenantSlug` and every key's
   `family` are cross-checked; mismatch → 400 `family_scope_mismatch`.
4. **Asterisk** — AstDB families under `connect/t_<slug>` are per-tenant by
   construction; no shared/global key exists.

## Versioning & compatibility

- Key **names** are considered stable API. Do not rename without migrating
  both Connect code paths AND the PBX dialplan.
- Adding a new key is backwards compatible: existing dialplan reads unchanged,
  new readers handle absence gracefully.
- Removing a key requires a multi-release rollout (stop writing → stop
  reading → remove from dialplan).
