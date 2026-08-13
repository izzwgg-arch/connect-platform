# IVR Prompt Tenant-Isolation Fix — Deploy Runbook

**Migration:** `20260426020000_tenant_prompt_isolation`
**PR title:** `fix(ivr): enforce tenant isolation for TenantPbxPrompt`

## Root cause summary

Pre-fix, `TenantPbxPrompt.promptRef` was **globally unique**
(`@@unique([promptRef])`), so tenants A and B could not both own
`custom/Main` — the last writer won and the row's `tenantId` was
flipped. The `/voice/ivr/prompts/upload` endpoint additionally matched
rows by `fileBaseName` across all tenants and wrote audio bytes to a
**flat** directory under `PROMPT_STORAGE_DIR`, so a later tenant's
"Main.wav" upload would literally overwrite the bytes belonging to an
earlier tenant's row. Two leak vectors: DB rows, and audio bytes on
disk.

## What the fix does

1. `TenantPbxPrompt`: drops the global uniqueness and replaces it with
   `@@unique([tenantId, promptRef])`. Each tenant has its own
   namespace.
2. Adds `ownershipConfidence` (`exact | path | prefix | manual |
   unknown`). Tenant admins only see rows whose confidence is *not*
   `unknown`.
3. `/voice/ivr/prompts/upload` now **requires** `pbxTenantId` in the
   meta payload. Connect resolves PBX tenant → Connect tenant via
   `TenantPbxLink`. If no link exists the row is stored as
   `tenantId=null, ownershipConfidence="unknown"` and invisible to
   every tenant admin.
4. `promptStorage` writes to **tenant-scoped** directories
   (`tenants/<tenantId>/<base>.ext`); the matcher and the stream
   endpoint refuse legacy flat paths outright.
5. `GET /voice/ivr/prompts` filters strictly by `tenantId` AND by
   `ownershipConfidence !== "unknown"` for non-super-admins. Super
   admins can view `__all__` or `__unassigned__`.
6. `GET /voice/ivr/prompts/:id/stream` refuses to serve rows whose
   ownership is unknown to non-super-admins.
7. Emergency kill-switch: setting `IVR_PROMPT_TENANT_FREEZE=true`
   returns `[]` to every non-super-admin list request.

## Ownership rule used

Priority order (same as the user's spec):

1. **`exact`** — `ombu_recordings.tenant_id` mapped through
   `TenantPbxLink.pbxTenantId` to the Connect `tenantId`.
   Authoritative.
2. **`path`** — folder/path convention (reserved for future
   `custom/<slug>/…` layouts; not used yet).
3. **`prefix`** — filename starts with a tenant slug (older Ombutel
   builds without the FK column).
4. **`manual`** — Connect admin set it via the UI or uploaded via
   `POST /voice/ivr/prompts/:id/audio`.
5. **`unknown`** — nothing matched; hidden from tenant admins.

Fuzzy-name guessing has been removed.

## Files changed

- `packages/db/prisma/schema.prisma`
  - Adds `ownershipConfidence` column.
  - Swaps `@@unique([promptRef])` for `@@unique([tenantId, promptRef])`.
- `packages/db/prisma/migrations/20260426020000_tenant_prompt_isolation/migration.sql`
  - Idempotent migration: adds column, nulls audio pointers, flips
    every row to `ownershipConfidence='unknown'`, replaces the unique
    index.
- `apps/api/src/promptStorage.ts`
  - Tenant-scoped `writePromptFile`, `findCachedAudioForRow`,
    `listStoredAudioFilenames`, `rowHasCachedAudio`.
  - `sanitizeTenantScope`, `buildTenantStorageKey`,
    `isTenantScopedStorageKey` added.
- `apps/api/src/promptStorage.test.ts`
  - Rewritten for tenant isolation; the headline test asserts that
    tenant A's lookup of `custom/Main` never resolves to tenant B's
    bytes even when both exist on disk with identical filenames.
- `apps/api/src/server.ts`
  - `IVR_PROMPT_TENANT_FREEZE` kill-switch.
  - `GET /voice/ivr/prompts` filters `ownershipConfidence !==
    "unknown"` for non-super-admins and exposes the field in the
    response.
  - `GET /voice/ivr/prompts/:id/stream` enforces ownership and
    tenant-scoped storage key.
  - `POST /voice/ivr/prompts/upload` requires `pbxTenantId`,
    scoped upsert, tenant-scoped storage.
  - `POST /voice/ivr/prompts/:id/audio` writes into the tenant dir.
  - `POST /voice/ivr/prompts/` (manual add) is tenant-scoped.
  - `POST /voice/ivr/prompts/sync` upserts scoped by `(tenantId,
    promptRef)` and sets confidence based on resolution method.
  - `ivrValidatePromptRefForTenant` no longer relies on the old
    global uniqueness.
- `apps/api/src/pbxOmbutelPromptSync.ts`
  - Upserts scoped by `(tenantId, promptRef)`; sets
    `ownershipConfidence="exact"` when PBX `tenant_id` resolves, else
    `prefix`, else `unknown`.
- `apps/portal/app/(platform)/pbx/ivr-routing/page.tsx`
  - `PromptCatalogRow.ownershipConfidence` exposed and a badge is
    rendered next to the Audio status pill.
- `docs/pbx/push-prompts-tenant-scoped.sh`
  - New PBX push script that sends `pbxTenantId` in `meta`.

## Deployment sequence

> Run from the Connect host as root.

### 1. Turn on the emergency freeze (optional — if you're nervous)

```bash
# On the Connect host
docker exec app-api-1 sh -c 'echo "IVR_PROMPT_TENANT_FREEZE=true" >> /tmp/.env.freeze'
# Or: add IVR_PROMPT_TENANT_FREEZE=true to .env.platform and restart api.
docker compose up -d --force-recreate api
```

### 2. Deploy the new code

```bash
cd /srv/connect    # or wherever the repo lives on prod
git pull
docker compose build api portal
docker compose up -d api portal
```

### 3. Run the Prisma migration

```bash
docker exec app-api-1 pnpm --filter @connect/db exec prisma migrate deploy
```

Expect one migration applied:
`20260426020000_tenant_prompt_isolation`.

After this step:

- `ownershipConfidence` column exists, defaulted to `'unknown'` for
  every existing row.
- `storageKey/sha256/sizeBytes/contentType/syncedAt` are **NULL** on
  every row — the stream endpoint will correctly respond with
  `audio_not_synced` until we re-push.
- No tenant admin can see any prompt until we re-sync (they're all
  `unknown`). Super admin can still view everything via the
  `__all__` and `__unassigned__` filters.

### 4. Nuke the suspect flat audio files on disk

These are the bytes that may have been cross-written across tenants.
Leaves the new tenant-scoped subdirectories alone.

```bash
docker exec app-api-1 sh -c '
  root=${PROMPT_STORAGE_DIR:-/var/lib/connect/ivr-prompts}
  find "$root" -maxdepth 1 -type f -print -delete
' | tee /tmp/connect-prompt-flat-cleanup.log
wc -l /tmp/connect-prompt-flat-cleanup.log
```

### 5. Re-run the auto-sync from the UI (or via curl)

This rebuilds the catalog with the correct `tenantId` and
`ownershipConfidence`, reading `ombu_recordings.tenant_id`:

```bash
# Super admin JWT required.
curl -sS -X POST \
  -H "Authorization: Bearer $SUPERADMIN_JWT" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  https://app.connectcomunications.com/api/voice/ivr/prompts/auto-sync \
  | jq .
```

Expect the response to report `perTenant` with counts and `sample`
rows showing `method=tenant_id` for each.

### 6. Re-push audio with tenant scoping from the PBX host

```bash
# On the VitalPBX host
scp docs/pbx/push-prompts-tenant-scoped.sh root@<pbx-host>:/tmp/
ssh root@<pbx-host>
export CONNECT_URL="https://app.connectcomunications.com/api"
export SECRET="<PROMPT_SYNC_SHARED_SECRET>"
bash /tmp/push-prompts-tenant-scoped.sh | tee /tmp/push.log
```

Expect a summary like `linked+uploaded=93, unlinked=0, miss=1,
failures=0`. Anything in `unlinked` means that PBX tenant doesn't
have a `TenantPbxLink` row on Connect — create it under **Admin →
PBX Instances** and re-run.

### 7. Turn the freeze off (if you set it in step 1)

```bash
# Remove IVR_PROMPT_TENANT_FREEZE from env, then:
docker compose up -d --force-recreate api
```

### 8. Verify per-tenant isolation

For each of **Landau Home, A Plus Center, Trimpro, Solidify
Concrete**:

1. Log in as a tenant admin of that tenant (or super-admin with the
   tenant switcher pointed at that tenant).
2. Open IVR Routing → any prompt picker.
3. Confirm:
   - Dropdown shows only recordings whose Connect `tenantId` matches
     the current tenant.
   - No recordings from another tenant appear.
   - The Play button fetches audio from
     `tenants/<tenantId>/<base>.wav` (visible in the browser
     devtools Network tab — look at the `storageKey` in the list
     response).
   - `ownershipConfidence` badge shows `exact` (or hidden for the
     good case).

Super admin spot-check:

- Set the tenant switcher to `__unassigned__` — this surface should
  be empty once every PBX tenant is linked.
- Set it to `__all__` — the full catalog should be visible with
  correct per-row `tenantId`.

## Rollback

If step 3 breaks something unexpected:

```bash
docker exec app-api-1 pnpm --filter @connect/db exec prisma migrate resolve --rolled-back 20260426020000_tenant_prompt_isolation
# then apply this cleanup SQL manually if needed:
docker exec app-postgres-1 psql -U connect -c '
  ALTER TABLE "TenantPbxPrompt" DROP COLUMN IF EXISTS "ownershipConfidence";
  DROP INDEX IF EXISTS "TenantPbxPrompt_tenantId_promptRef_key";
  CREATE UNIQUE INDEX IF NOT EXISTS "TenantPbxPrompt_promptRef_key"
    ON "TenantPbxPrompt" ("promptRef");
'
```

> Note: rollback does NOT restore the audio pointers. If you need the
> audio back, re-run the PBX push script (the pre-fix version) to
> reupload the flat files.

## Confirmation checklist (per the user's output requirements)

- [x] **root cause:** `TenantPbxPrompt.@@unique([promptRef])` +
      tenant-blind `/upload` + flat audio storage.
- [x] **exact files changed:** listed above.
- [x] **ownership rule used:** PBX `ombu_recordings.tenant_id` via
      `TenantPbxLink` (`exact`), with prefix / manual fallbacks;
      everything else `unknown`.
- [x] **records fixed:** every existing row is flipped to `unknown`
      by the migration and then re-classified on the next sync /
      push.
- [x] **unknown records hidden:** server enforces
      `ownershipConfidence !== "unknown"` for non-super-admins on
      both list and stream endpoints.
- [x] **proof dropdowns are isolated:** unit test
      `findCachedAudioForRow: tenant A NEVER resolves to tenant B's
      file` plus the manual verification sequence in step 8.
- [x] **no PBX files deleted:** the only deletion is the suspect
      **Connect-side flat audio cache** in step 4, which was never
      authoritative — PBX recordings on `/var/lib/vitalpbx/static`
      are untouched.
