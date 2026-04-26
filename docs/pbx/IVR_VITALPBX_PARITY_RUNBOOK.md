# Connect IVR — VitalPBX Parity (Phase 3) Runbook

This change brings Connect's IVR control plane to 1:1 feature parity with
VitalPBX IVR while keeping the existing architecture (Connect = control
plane, PBX = execution). It is purely additive; legacy profiles keep routing
exactly as they did pre-change.

## What was missing vs VitalPBX

| Capability | Before | After |
|---|---|---|
| Dial-by-extension during IVR (Direct Dial) | ❌ no flag, no multi-digit match | ✅ `directDialEnabled` on profile, `_XXX`/`_XXXX` pattern in dialplan gated by `direct_dial` AstDB key |
| Per-IVR invalid destination after max retries | ❌ always `connect-default-fallback` | ✅ `invalidDestinationType` + `invalidDestinationRef` → `dest_invalid_type` + `dest_invalid` AstDB keys → `[connect-exit-router]` |
| Per-IVR timeout destination after max retries | ❌ always `connect-default-fallback` | ✅ `timeoutDestinationType` + `timeoutDestinationRef` → `dest_timeout_type` + `dest_timeout` |
| VitalPBX-parity "Retry" prompt | ❌ replays main greeting | ✅ `pbxRetryPromptRef` → `active_prompt_retry` AstDB key |
| Default system prompts when user leaves refs blank | ❌ dialplan only fell back on timeout (`vm-enter-num-to-call`); invalid went silent-then-reprompt | ✅ Connect publishes `pbx-invalid` / `vm-enter-num-to-call` as the effective default whenever admin hasn't picked a custom recording — self-documenting in AstDB |
| CEP validation on the profile-level `pbxDestination` | ❌ only `min(1).max(200)` | ✅ regex-validated identical to per-digit options |
| Extension-picker ergonomics in option rows | ❌ free-text | ✅ tenant-scoped datalist when type=extension |
| IVR analytics (DTMF / invalid / timeout) | ❌ no recorded events | ✅ `POST /voice/ivr/events` → `PbxCallEvent` (dialplan hook optional) |

## Files changed

- `packages/db/prisma/schema.prisma` — added 6 columns to `IvrRouteProfile`
- `packages/db/prisma/migrations/20260426040000_ivr_vitalpbx_parity/migration.sql` — additive `ALTER TABLE`
- `apps/api/src/server.ts`
  - `buildIvrKeys()` — emits 5 new AstDB keys + resolves default prompts
  - `POST /voice/ivr/route-profiles` — zod + validation for new fields; CEP check on `pbxDestination`
  - `PATCH /voice/ivr/route-profiles/:id` — same, with partial-update consistency
  - `GET /voice/ivr/preview` — now returns `directDial`, `invalidDestination`, `timeoutDestination`, `prompts.retry`
  - `POST /voice/ivr/events` — new analytics ingest (CDR secret gated)
  - new helper `ivrValidateOptionalDestination()`
- `apps/portal/app/(platform)/pbx/ivr-routing/page.tsx`
  - extended `RouteProfile` / `ProfileFormState` types
  - "Add/Edit Route Profile" modal: Retry prompt picker, Direct Dial toggle, Invalid Handling + Timeout Handling sections
  - inline prompts editor: Retry prompt picker + default-prompt hints
  - Option rows: tenant-scoped extension suggestions via `<datalist>`
- `docs/pbx/option-a-custom-context.conf` — extended `[connect-tenant-ivr]`, added `[connect-exit-router]`
- `docs/pbx/IVR_VITALPBX_PARITY_RUNBOOK.md` — this file

## New DB fields on `IvrRouteProfile`

| Column | Type | Default | Purpose |
|---|---|---|---|
| `directDialEnabled` | `BOOLEAN` | `false` | Allow dial-by-extension during IVR |
| `pbxRetryPromptRef` | `TEXT?` | `null` | VitalPBX-parity retry prompt |
| `invalidDestinationType` | `TEXT?` | `null` | Module type for post-max-retries invalid branch |
| `invalidDestinationRef` | `TEXT?` | `null` | CEP or E.164 |
| `timeoutDestinationType` | `TEXT?` | `null` | Same, for timeouts |
| `timeoutDestinationRef` | `TEXT?` | `null` | |

All nullable / with defaults. Existing rows remain valid and route the same way.

## New AstDB keys (family `connect/t_<slug>/`)

| Key | Value | Consumer |
|---|---|---|
| `active_prompt_retry` | recording ref or `""` | `[connect-tenant-ivr]` at retry iterations |
| `direct_dial` | `"1"` or `"0"` | `[connect-tenant-ivr]` pattern handlers |
| `dest_invalid_type` | module type string | `[connect-exit-router]` (metadata / external_number branch) |
| `dest_invalid` | CEP or E.164 | `[connect-exit-router]` |
| `dest_timeout_type` | module type string | same |
| `dest_timeout` | CEP or E.164 | same |
| `active_prompt_invalid` | **now defaults to `pbx-invalid`** when admin hasn't chosen a custom recording | existing consumer |
| `active_prompt_timeout` | **now defaults to `vm-enter-num-to-call`** | existing consumer |

All keys are always written on every publish so rollback snapshots stay
deterministic. Legacy dialplans that don't read the new keys continue to work.

## UI additions

1. **Add/Edit Route Profile** modal:
   - Direct Dial toggle (with explainer)
   - Retry prompt picker (with "blank = replay greeting" hint)
   - Invalid Handling section (module dropdown + destination input)
   - Timeout Handling section (module dropdown + destination input)
   - Hint text under Invalid/Timeout prompt pickers noting the PBX defaults
2. **Profile summary / inline prompts editor**:
   - "Retry prompt" row
   - Empty-label text for Invalid/Timeout pickers now names the PBX default
3. **Option rows**:
   - Extension destinations show a tenant-scoped datalist of `from-internal,<ext>,1` suggestions
   - Behavior unchanged for other module types (remains free-text CEP / E.164)

## Tenant safety

- All new fields are persisted under the existing `tenantId`-scoped `IvrRouteProfile`
  row; PATCH handlers continue to call `assertIvrTenantAccess()`.
- Extension suggestions are fetched from `/voice/pbx/resources/extensions?tenantId=<id>`
  which already enforces tenant scoping. A super-admin switching tenants picks up
  a fresh list.
- `POST /voice/ivr/events` resolves tenant via explicit `tenantId` or lookup of
  `tenantSlug`; unresolvable events are soft-dropped (202) so a misconfigured
  dialplan can never fail calls.

## Stats

`POST /voice/ivr/events` (guarded by `x-cdr-secret`) accepts:

```json
{
  "tenantId":   "c...",          // or "tenantSlug": "acme"
  "callId":     "1745700000.123",
  "eventType":  "ivr_option_pressed" | "ivr_invalid" | "ivr_timeout" |
                "ivr_direct_dial"    | "ivr_fallback_invalid" | "ivr_fallback_timeout",
  "digit":      "2",              // optional
  "retryCount": 1,                // optional
  "profileId":  "c...",           // optional
  "fromNumber": "+15551234567",
  "toNumber":   "+15551999000",
  "payload":    { "...": "free-form" }
}
```

Writes one row to `PbxCallEvent` with `eventType` preserved. Existing CDR /
call-events reporting picks these up automatically — no schema change.

## Deployment

1. **Push + deploy code**
   ```bash
   git push origin main
   # on the Connect server:
   cd /opt/connectcomms/app
   git fetch origin && git reset --hard origin/main
   docker compose -f docker-compose.app.yml build api portal
   docker compose -f docker-compose.app.yml up -d api portal
   ```
   Prisma migration `20260426040000_ivr_vitalpbx_parity` auto-applies on API
   container startup (additive `ALTER TABLE`, no downtime).

2. **(Optional) Paste updated dialplan into VitalPBX**
   The code works with the legacy dialplan — legacy tenants that don't opt in to
   the new fields see identical behavior. Paste `docs/pbx/option-a-custom-context.conf`
   into `/etc/asterisk/extensions__60_custom.conf` ONLY when you want the new
   fields to actually take effect (Direct Dial, Invalid/Timeout destinations,
   Retry prompt). Run `asterisk -rx "dialplan reload"` on the PBX after pasting.

3. **Re-publish any active tenant's IVR** so the new AstDB keys are written.
   This happens automatically when any admin clicks "Publish" for a tenant.
   Safe to run even if step 2 hasn't been done yet — the keys will just be
   ignored by the legacy dialplan.

## Verification checklist

- [ ] Create a profile without opting into any new fields → existing behavior
      (falls through to `connect-default-fallback` after max retries)
- [ ] Toggle Direct Dial on → dial a 3-digit extension during the greeting →
      call routes to that extension via `from-internal`
- [ ] Toggle Direct Dial off → dial a 3-digit extension → call hits `i`
      (invalid) after the WaitExten timeout
- [ ] Set Invalid Destination = queue `from-internal,700,1` → press invalid
      digits until max retries → call routes to queue 700
- [ ] Set Timeout Destination = voicemail `default,1001,1` → wait silent for
      max retries → call routes to voicemail 1001
- [ ] Leave Invalid/Timeout recording blank → dialplan plays `pbx-invalid` /
      `vm-enter-num-to-call` defaults (check `asterisk -rvvvv` for the
      `Background(pbx-invalid)` line)
- [ ] Set Retry prompt → on retry iteration, caller hears the retry recording
      instead of the main greeting
- [ ] Tenant admin cannot see another tenant's extension suggestions in the
      option-row datalist
- [ ] `SELECT "directDialEnabled", "invalidDestinationType", "invalidDestinationRef",
      "timeoutDestinationType", "timeoutDestinationRef", "pbxRetryPromptRef"
      FROM "IvrRouteProfile" LIMIT 5;` returns the expected values

## Nothing broken

- Legacy option routing (`[connect-option-router]`) is unchanged except for a
  new `NoOp()` and an opt-in `external_number` Dial branch that only fires
  when `opt_<digit>/type = "external_number"` — unchanged for any other type.
- `[connect-tenant-router]` (legacy single-destination router) is untouched.
- `buildIvrKeys()` still returns a fixed-size, deterministic key set — rollback
  snapshots remain round-trip-safe.
- All new API fields are optional; existing clients that don't send them
  continue to get 201/200 responses with default values.
- Extension-suggestion datalist gracefully degrades to free-text on fetch
  failure.
