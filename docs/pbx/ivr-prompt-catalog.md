# IVR Prompt Catalog — tenant-filtered recording dropdowns

This document covers the Connect-owned catalog of VitalPBX System Recordings
that powers the **Greeting / Invalid / Timeout** dropdowns in the IVR Routing
page.

The golden rule: **Connect NEVER queries the PBX at page-render time.** The
dropdowns are always served from Connect's `TenantPbxPrompt` table. The PBX
is only ever read during a controlled, admin-triggered sync.

---

## Data model

Table: `TenantPbxPrompt` (see `packages/db/prisma/schema.prisma`).

| Column | Purpose |
|--------|---------|
| `id` | Primary key |
| `tenantId` | FK → `Tenant.id`. `null` = unassigned / unknown tenant |
| `tenantSlug` | Denormalised tenant slug (`toIvrSlug(tenant.name)`) for debugging |
| `promptRef` | Canonical dialplan ref, e.g. `custom/acme_normal` — unique |
| `fileBaseName` | Basename without path/extension, e.g. `acme_normal` |
| `relativePath` | Same as `promptRef` today; reserved for future non-`custom/` paths |
| `displayName` | Human label shown in the dropdown |
| `category` | `greeting` / `invalid` / `timeout` / `general` / `unknown` |
| `source` | `pbx_sync` / `manual` / `import` |
| `isActive` | Soft-delete flag; inactive rows disappear from dropdowns |
| `firstSeenAt` / `lastSeenAt` | Audit of sync runs |

Indexed on: `tenantId`, `tenantSlug`, `tenantId + isActive`, `isActive`, and a
unique index on `promptRef`.

The actual audio is **not** stored here — only pointers. Files remain on the
VitalPBX host under `/var/lib/asterisk/sounds/custom/`.

---

## Tenant assignment — slug-prefix matching

VitalPBX stores recordings in a shared global namespace. Connect assigns each
recording to a tenant by matching the **filename prefix** against each
tenant's `toIvrSlug(name)` slug, longest match wins:

| Recording ref | Tenant slug | Match? |
|---------------|-------------|--------|
| `custom/acme_normal` | `acme` | ✔ (prefix `acme_`) |
| `custom/acme-closed` | `acme` | ✔ (prefix `acme-`) |
| `custom/acme` | `acme` | ✔ (exact) |
| `custom/acme2_main` | `acme` | ✘ (next char must be `_` or `-`) |
| `custom/trimpro_main` | `trimpro` | ✔ |
| `custom/generic_hold` | (none) | ✘ → stored with `tenantId = null` |

**Naming convention that must be followed** when ops creates recordings in
VitalPBX: `custom/<tenant_slug>_<purpose>` or `custom/<tenant_slug>-<purpose>`.
Unassigned recordings are never shown in tenant-scoped dropdowns (only visible
to super-admins via `?tenantId=__all__`).

---

## How the catalog gets populated

The catalog has three population paths. **Option 1 (Auto-Sync) is the default
and works out of the box when the PBX instance already has a read-only
`ombutel` MySQL URL configured** — which it does if DID sync is working.

### Option 1 — Auto-Sync from VitalPBX (recommended, one click)

1. A super-admin opens **IVR Routing → Route Profiles**.
2. Clicks **Auto-Sync from VitalPBX**.
3. Connect reads the System Recordings table directly from the PBX's
   `ombutel` MariaDB (same read-only connection used by DID sync), maps each
   recording's PBX `tenant_id` to a Connect tenant via `TenantPbxLink`, and
   upserts into `TenantPbxPrompt`.

Endpoint: `POST /voice/ivr/prompts/auto-sync` (super-admin JWT).

Tenant assignment uses the PBX's own `tenant_id` foreign key, not filename
guessing — so cross-tenant leakage is structurally impossible.

**PBX load**: one indexed `SELECT` on `INFORMATION_SCHEMA` + one `SELECT` on
the recordings table (`LIMIT 5000`). Zero filesystem work. Zero AMI traffic.
Admin-gated and manual — never a polling loop.

Requires the `PbxInstance.ombuMysqlUrlEncrypted` column to be set (an
`encryptJson({ mysqlUrl: "mysql://user:pass@host:3306/ombutel" })` blob).
If unset, Auto-Sync returns `{ok: false, skipReason, hint}` instead of
erroring, and the UI tells the admin what to do.

### Option 2 — Manual paste (fallback)

1. Same page, click **Paste list…**.
2. Paste recording names — one per line, comma-separated, or space-separated.
   File extensions and leading `custom/` are optional.
3. Click **Sync**. Connect upserts every row, auto-matches to tenants by
   slug-prefix, and returns `{ created, updated, unassigned, total }`.

**PBX load**: zero. The admin is typing, not scanning.

### Option 3 — PBX-host cron (large installs without the MySQL link)

Run this one-liner on the VitalPBX host on a schedule chosen by ops (daily is
typical; hourly is fine — the command is O(filesystem) and takes well under a
second for thousands of recordings):

```bash
#!/usr/bin/env bash
# /etc/cron.daily/connect-prompt-sync
set -euo pipefail

CONNECT_URL="https://connect.example.com"
CONNECT_SECRET="$(cat /etc/connect/cdr_ingest_secret)"  # same value as CDR_INGEST_SECRET
SOUNDS_DIR="/var/lib/asterisk/sounds/custom"

REFS=$(find "$SOUNDS_DIR" -maxdepth 1 -type f \
  \( -name '*.wav' -o -name '*.gsm' -o -name '*.ulaw' -o -name '*.g722' -o -name '*.sln*' \) \
  -printf '%f\n' \
  | sed -E 's/\.(wav|gsm|ulaw|g722|sln[0-9]*)$//' \
  | sort -u \
  | awk '{print "custom/"$0}' \
  | jq -R . | jq -s .)

curl -sfS --max-time 10 \
  -H "Content-Type: application/json" \
  -H "x-cdr-secret: $CONNECT_SECRET" \
  -d "{\"refs\": $REFS, \"source\": \"pbx_sync\"}" \
  "$CONNECT_URL/voice/ivr/prompts/sync"
```

**PBX load**: one `find` over a single directory, once per day. Effectively
zero.

---

## API reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/voice/ivr/prompts?tenantId=<id>&category=<c>` | JWT (`can_view_customers`) | List prompts for the tenant |
| `POST` | `/voice/ivr/prompts` | JWT (`can_manage_ivr_prompts`) | Create/upsert one row |
| `PATCH` | `/voice/ivr/prompts/:id` | JWT (`can_manage_ivr_prompts`) | Rename, recategorise, deactivate |
| `DELETE` | `/voice/ivr/prompts/:id` | JWT (`can_manage_ivr_prompts`) | Soft-delete (sets `isActive=false`) |
| `POST` | `/voice/ivr/prompts/sync` | `x-cdr-secret` **or** super-admin JWT | Bulk upsert from a list of refs |
| `POST` | `/voice/ivr/prompts/auto-sync` | super-admin JWT | One-click read from the PBX's `ombutel` MariaDB into the catalog |

`GET /voice/ivr/prompts` behaviour:

- Tenant admins are **always** scoped to their own `tenantId` — they cannot
  view another tenant's recordings regardless of the query string.
- Super-admins can pass `?tenantId=<id>` to scope to a specific tenant, or
  `?tenantId=__all__` to see every row (including unassigned).
- Inactive rows are hidden by default; pass `?includeInactive=1` to include
  them (e.g. for a catalog admin tool).

`POST /voice/ivr/prompts/sync` behaviour:

- Accepts up to 5000 refs per call (plenty for any real deployment).
- `source: "pbx_sync"` (default) vs `"manual"` — manual-sourced rows are
  preserved during later pbx_sync runs (their `displayName`/`category` won't
  be overwritten).
- `deactivateMissing: true` (default `false`) will mark rows NOT in the
  uploaded list as inactive. Off by default so stale IVR profiles keep
  resolving even if the cron is late.

---

## Dropdown UI behaviour

In the IVR Routing → Route Profiles card:

- Each of the three prompt fields (Greeting / Invalid / Timeout) renders a
  dropdown populated from `GET /voice/ivr/prompts?tenantId=<current>`.
- If the profile has a saved value that is **not** in the catalog (legacy row
  or not yet synced), it appears at the top of the dropdown flagged as
  "legacy (not in catalog)" so data is never silently lost on save.
- A **Type custom value** toggle switches to a free-text input for edge cases
  (e.g. immediately after adding a new recording in VitalPBX, before the next
  sync).
- If the tenant has zero catalog rows, the field auto-opens in manual-entry
  mode.

---

## Validation rules (server-side)

In `ivrValidatePromptRefForTenant()` (see `apps/api/src/server.ts`):

1. `null` / empty → accepted (dialplan plays a safe built-in default).
2. Format must match `IVR_PROMPT_REF_REGEX = /^[a-zA-Z0-9/_\-]{1,128}$/`.
3. If the ref exists in `TenantPbxPrompt` and is assigned to a **different**
   tenant → **rejected** with `invalid_prompt_ref`. This blocks tenant admins
   from selecting another tenant's recording.
4. If the ref doesn't exist in the catalog → **accepted** (legacy-safe). The
   UI marks this case visibly.

Cross-tenant leakage is impossible through the API and the UI:

- `GET /voice/ivr/prompts` scopes tenant admins to their own `tenantId`
  server-side, regardless of query params.
- `POST/PATCH/DELETE /voice/ivr/prompts/:id` all check `existing.tenantId`
  against `user.tenantId` for non-super-admins.
- `PATCH /voice/ivr/route-profiles/:id` runs `ivrValidatePromptRefForTenant`
  against the profile's own `tenantId`, so even a tenant admin with a stolen
  catalog ID cannot persist a cross-tenant ref on their own profile.

---

## CPU safety proof

| Action | PBX CPU cost |
|--------|--------------|
| User opens the IVR Routing page | **0** — catalog read from Connect DB only |
| User opens the Route Profile edit modal | **0** — uses already-loaded catalog |
| Tenant admin edits a prompt | **0** — DB write + AstDB publish only on explicit Publish |
| Auto-Sync button (one click) | Two `SELECT`s on `ombutel` MySQL; ~ms |
| Paste-list button (manual fallback) | **0** — admin is typing, no PBX call |
| PBX-host cron (Option 3) | One `find` per day, ~ms |
| Background workers | **0** — no worker reads the prompt catalog from the PBX |

Connect's `GET /voice/ivr/prompts` handler does a single indexed SELECT on
`TenantPbxPrompt` and returns. It does not call VitalPBX. This holds under
any load.
