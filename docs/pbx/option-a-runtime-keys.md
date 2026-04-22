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

| Key | Type | Allowed values | Default (if absent) | Read by |
|-----|------|----------------|---------------------|---------|
| `mode` | string | `business` \| `afterhours` \| `holiday` \| `override` | — (absent → fallback) | `[connect-tenant-router]` |
| `dest_business` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=business` |
| `dest_afterhours` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=afterhours` |
| `dest_holiday` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=holiday` |
| `dest_override` | string | `<context>,<exten>,<priority>` or `""` | `""` | `[connect-tenant-router]` when `mode=override` |
| `override_expires` | string | unix epoch seconds (integer) or `"0"` | `"0"` | advisory only (Connect enforces expiry) |

**Value format for `dest_*`:** a single string `"<context>,<exten>,<priority>"`
suitable for direct `Goto(${DEST})`. Example: `from-did-direct,s,1`.

**Why not separate context/exten/priority keys?** The dialplan uses exactly
one `DB()` read per `Goto` — keeping them concatenated costs one read, not
three, per call. Small but meaningful at scale.

## Fallback behavior

The custom context `[connect-tenant-router]` falls through to
`[connect-default-fallback]` in any of these cases:

- `TENANT_SLUG` channel variable is empty.
- `mode` key is missing or empty.
- `dest_${mode}` key is missing or empty.

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
