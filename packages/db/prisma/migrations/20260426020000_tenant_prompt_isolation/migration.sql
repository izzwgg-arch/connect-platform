-- ═══════════════════════════════════════════════════════════════════════════
-- Tenant isolation fix for TenantPbxPrompt.
--
-- Root cause of the bug being patched:
--   1. `@@unique([promptRef])` made `custom/Main` globally unique — so when
--      two VitalPBX tenants each had a recording named "Main" they
--      collided on one row, and the last upsert's tenantId won.
--   2. The bulk /voice/ivr/prompts/upload endpoint matched catalog rows
--      by fileBaseName across ALL tenants, leaking one tenant's audio
--      bytes onto another tenant's row.
--   3. Audio files were stored flat on disk (no tenant scope), so even
--      with separate rows tenant B's "Main.wav" overwrote tenant A's
--      "Main.wav" bytes.
--
-- What this migration does (safe, idempotent):
--   a. Adds `ownershipConfidence` (default 'unknown') so the list endpoint
--      can freeze rows until ownership is reconfirmed.
--   b. Drops the global promptRef uniqueness and replaces it with a
--      composite unique on (tenantId, promptRef). Tenant A and tenant B
--      can now both own their own `custom/Main` row.
--   c. Marks every existing row as `ownershipConfidence = 'unknown'` and
--      nulls out the audio pointer columns (storageKey/sha256/etc). The
--      physical file bytes on disk are kept for forensic purposes but the
--      stream endpoint will not serve them until a re-sync re-establishes
--      tenant-scoped ownership. PBX-side recordings are NOT touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. New column: how confident are we that this row's tenantId is correct?
ALTER TABLE "TenantPbxPrompt"
  ADD COLUMN IF NOT EXISTS "ownershipConfidence" TEXT NOT NULL DEFAULT 'unknown';

-- 2. Freeze every existing row as `unknown`. Tenant admins will see nothing
--    until the auto-sync pass reconfirms ownership from ombu_recordings.
UPDATE "TenantPbxPrompt"
  SET "ownershipConfidence" = 'unknown';

-- 3. Null out audio pointers so the stream endpoint falls back to
--    "audio_not_synced" until tenant-scoped bytes are re-uploaded.
--    The actual byte files on disk are left alone; a separate cleanup
--    command on the Connect host removes the flat/legacy copies.
UPDATE "TenantPbxPrompt"
  SET "storageKey"  = NULL,
      "sha256"      = NULL,
      "sizeBytes"   = NULL,
      "contentType" = NULL,
      "syncedAt"    = NULL;

-- 4. Drop the old global uniqueness. Name varies by Prisma version; use
--    IF EXISTS on both the constraint and the index.
ALTER TABLE "TenantPbxPrompt"
  DROP CONSTRAINT IF EXISTS "TenantPbxPrompt_promptRef_key";
DROP INDEX IF EXISTS "TenantPbxPrompt_promptRef_key";

-- 5. Add the new scoped uniqueness. Under Postgres NULL-uniqueness
--    semantics multiple rows with tenantId=NULL + same promptRef are
--    allowed; the super-admin cleanup UI can dedupe those manually.
CREATE UNIQUE INDEX IF NOT EXISTS "TenantPbxPrompt_tenantId_promptRef_key"
  ON "TenantPbxPrompt" ("tenantId", "promptRef");
