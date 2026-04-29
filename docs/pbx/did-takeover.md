# DID Route Takeover — Runbook

Connect can take over a VitalPBX-registered DID so inbound calls enter
`[connect-tenant-ivr]` and our IVR profile answers, and can restore the DID
to its original PBX destination at any time. This document describes the
runtime contract, what gets captured / mutated, and how to recover when
things go sideways.

## What "takeover" means

Before takeover, a DID's inbound-route lives entirely on VitalPBX:

```
+1-800-555-1212  →  destination_type = "ivr"
                     destination      = "<ombutel-ivr-id>"
```

After **Take over** (from the `/pbx/did-routing` page):

```
+1-800-555-1212  →  destination_type   = "custom-destinations"
                     destination        = "connect-tenant-ivr,+18005551212,1"
                     channel_variables  = { TENANT_SLUG: "<slug>" }
```

The call now enters the Connect-managed `[connect-tenant-ivr]` dialplan
context which reads AstDB for tenant, IVR profile, MOH class, and hold
announcement — the same runtime keys `/voice/did/publish` already writes.

Before the PBX PATCH happens we snapshot the **pre-takeover** destination
(`destination_type`, `destination`, `channel_variables`) onto the
`DidRouteMapping` row. **Restore PBX** later PATCHes that exact payload back,
so operators don't have to remember what the DID pointed at before.

## State machine

| From      | Action         | Effect on VitalPBX                       | Effect on Connect DB                                     |
| --------- | -------------- | ---------------------------------------- | -------------------------------------------------------- |
| `pbx`     | Take over      | PATCH `inbound_numbers` → Connect        | Capture `originalPbx*`, set `routingMode="connect"`      |
| `connect` | Restore PBX    | PATCH `inbound_numbers` → stored payload | Set `routingMode="pbx"` (originals kept for re-toggle)   |
| `connect` | Take over (re) | No-op (already on Connect)               | No change                                                |
| `pbx`     | Restore PBX    | No-op                                    | No change                                                |

## API surface

All three endpoints require the `can_publish_did_routing` permission
(`SUPER_ADMIN` + `ADMIN`). PBX mutation is performed through the PBX-side
route helper when configured (`PBX_ROUTE_HELPER_*`), with the old
`PBX_INBOUND_API=true` VitalPBX endpoint kept only as a legacy fallback.

| Method | Path                              | Purpose                                                            |
| ------ | --------------------------------- | ------------------------------------------------------------------ |
| GET    | `/voice/did/capabilities`         | Report whether the PBX route helper or legacy inbound API is enabled |
| GET    | `/voice/did/:id/inspect`          | Read live PBX inbound-number + compute drift vs. stashed original  |
| POST   | `/voice/did/:id/switch-to-connect`| Capture → publish AstDB → PATCH PBX, atomic, inserts audit row     |
| POST   | `/voice/did/:id/switch-to-pbx`    | Restore original (or override) PBX destination, inserts audit row  |

`switch-to-pbx` accepts an optional body for the rare "our snapshot is
stale" case:

```json
{
  "overrideDestinationType":  "ivr",
  "overrideDestination":       "3",
  "overrideChannelVariables":  { "MY_VAR": "x" }
}
```

## Audit trail

Every switch — success or failure — writes a row to `DidRouteSwitchLog`:

- `fromMode` / `toMode` — direction of the flip
- `performedBy` — user id that clicked the button
- `pbxSnapshot` — what the PBX was returning just before we changed it
- `pbxPayload` — what we sent to PATCH `inbound_numbers`
- `status` — `pending` while mid-flight, `success`, or `failed`
- `error` — populated when `status="failed"`

`SELECT * FROM "DidRouteSwitchLog" WHERE "tenantId"=? ORDER BY "performedAt" DESC LIMIT 20`
gives you a full recent history for post-mortems.

## Failure modes

Every failure path leaves Connect in a **consistent, conservative** state so
re-trying is safe.

| Failure                                      | Connect DB outcome                                                                 | PBX outcome                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| PBX read fails before takeover               | No DB write. HTTP 502.                                                             | Untouched                           |
| PBX says number not found                    | No DB write. HTTP 404.                                                             | Untouched                           |
| AstDB publish fails mid-takeover             | `originalPbx*` captured (safe — describes PBX reality), `routingMode` stays `pbx` | Untouched                           |
| PBX PATCH fails during takeover              | `originalPbx*` captured, `routingMode` stays `pbx`, `lastSwitchError` populated   | Untouched                           |
| PBX PATCH succeeds, DB write fails (rare)    | Log row proves we did it; next `/inspect` will show `routingMode=pbx` + drift     | Connect-tenant-ivr already written  |
| PBX PATCH fails during restore               | `routingMode` stays `connect`, `lastSwitchError` populated                        | Untouched                           |

## Recovering from lost originals

If `originalPbxDestination` is `NULL` (e.g. Connect DB was restored from a
backup that predates takeover) and the DID is stuck on Connect IVR, the
operator can:

1. `GET /voice/did/:id/inspect` — check live PBX state (usually
   `custom-destinations → connect-tenant-ivr,...`).
2. `POST /voice/did/:id/switch-to-pbx` with an `override*` body built from
   the DID's intended destination (e.g. VitalPBX extension, IVR id, or
   queue).
3. On success, `originalPbx*` stays null — future takeovers will re-capture
   from live PBX state, so this is self-healing.

If the PBX itself was reinstalled and the original destination id no
longer exists, use the `override*` fields to point at whatever the new
destination should be. `switch-to-pbx` doesn't validate that the target
destination exists on VitalPBX — that's VitalPBX's job.

## Drift detection

While `routingMode=connect`, Connect expects VitalPBX to have
`destination_type=custom-destinations` and `destination` starting with
`connect-tenant-ivr,`. If a human edits the inbound route directly on
VitalPBX to something else, `GET /inspect` returns
`driftDetected=true, driftReason="pbx_destination_drifted"` and the portal
row shows a yellow warning. The fix is either:

- **Keep Connect in charge**: click _Re-read live PBX_, then _Restore PBX_
  followed by _Take over_ again to re-assert Connect's payload. Connect's
  `originalPbx*` fields are preserved across this cycle.
- **Hand control back to PBX**: the human edit on VitalPBX is now the
  intended destination. Use _Restore PBX_ with the `override*` body to
  sync Connect's stashed original to whatever VitalPBX is currently
  serving, then the DID stays on `routingMode=pbx`.

## Gating / environment

- Preferred: install the PBX-side helper from
  [`inbound-route-helper.md`](./inbound-route-helper.md) and set either:
  - `PBX_ROUTE_HELPER_BASE_URL`, `PBX_ROUTE_HELPER_SECRET`,
    `PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID`
  - or `PBX_ROUTE_HELPER_BY_INSTANCE_JSON` for per-PBX configuration.

- Legacy fallback: `PBX_INBOUND_API=true` in the Connect API environment uses
  VitalPBX's `/tenants/:id/inbound_numbers` endpoint. This endpoint does not
  work on every VitalPBX build and may only add/remove tenant numbers rather
  than change route destinations.

- When neither helper nor legacy API is configured:
  - Switch endpoints return `503 pbx_inbound_api_disabled`
  - `/voice/did/capabilities` reports `routeHelperEnabled: false` and
    `inboundApiEnabled: false`
  - The DID Routing portal page renders a yellow banner for super-admins
  - Take-over and Restore buttons still render, but fail on click with a
    clear error toast

- `assertIvrTenantAccess(user, mapping.tenantId)` is enforced on every
  endpoint — tenant admins cannot take over another tenant's DIDs even
  if they somehow obtain the mapping id.

## Non-goals

- **Bulk switch**: per-DID only. Bulk tools are trivial to add on top of
  the single-DID endpoint but were intentionally scoped out to avoid
  "click once, break 100 lines" mistakes.
- **Broad Ombutel writes**: Connect never receives direct MySQL write access.
  The PBX helper uses a narrowly-scoped local MySQL user that can only
  `SELECT` route/destination rows and `UPDATE ombu_inbound_routes.destination_id`.
- **Editing `/etc/asterisk/extensions_custom.conf`**: zero dialplan
  changes at runtime. `[connect-tenant-ivr]` is installed once at PBX
  provisioning time; takeover just repoints existing routes at it.
