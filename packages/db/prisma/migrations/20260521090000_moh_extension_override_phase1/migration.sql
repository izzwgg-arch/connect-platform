-- Phase 1 of per-extension MOH overrides: data foundation only.
--
-- Adds two new tables (`MohExtensionOverride`, `MohAssignmentJob`) and one
-- nullable JSON column on `MohPublishRecord`. Strictly additive: no existing
-- column is altered or dropped, no FK on an existing table is changed, no
-- data backfill is required.
--
-- Phase 1 does NOT write to AstDB during normal tenant publish, does NOT add
-- API routes, and does NOT change the runtime PBX dialplan. The new tables
-- are inert until a future phase wires them into the publish helper.

-- ── 1. MohPublishRecord: add extensionOverridesSnapshot ─────────────────
-- Default '[]' so every existing row reads as a valid JSON array without
-- a backfill step. Mirrors the convention of `previousKeysSnapshot`.
ALTER TABLE "MohPublishRecord"
  ADD COLUMN "extensionOverridesSnapshot" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── 2. MohExtensionOverride ─────────────────────────────────────────────
-- One row per (tenantId, extension). Source of truth (in a future phase)
-- for the per-extension AstDB keys
--   connect/t_<slug>/extensions/<extension>/moh_class
--   connect/t_<slug>/extensions/<extension>/active_moh_class
CREATE TABLE "MohExtensionOverride" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "extension"            TEXT NOT NULL,
  "vitalPbxMohClassName" TEXT NOT NULL,
  "mohProfileId"         TEXT,
  "enabled"              BOOLEAN NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  "createdBy"            TEXT,
  "updatedBy"            TEXT,
  CONSTRAINT "MohExtensionOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MohExtensionOverride_tenantId_extension_key"
  ON "MohExtensionOverride"("tenantId", "extension");

CREATE INDEX "MohExtensionOverride_tenantId_idx"
  ON "MohExtensionOverride"("tenantId");

CREATE INDEX "MohExtensionOverride_enabled_idx"
  ON "MohExtensionOverride"("enabled");

ALTER TABLE "MohExtensionOverride"
  ADD CONSTRAINT "MohExtensionOverride_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohExtensionOverride"
  ADD CONSTRAINT "MohExtensionOverride_mohProfileId_fkey"
  FOREIGN KEY ("mohProfileId") REFERENCES "MohProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. MohAssignmentJob ────────────────────────────────────────────────
-- Bulk-assignment audit/work table. Deliberately no FK to Tenant —
-- `targetTenantIds` is an opaque string array so deleting a tenant does
-- not cascade-delete history.
CREATE TABLE "MohAssignmentJob" (
  "id"                   TEXT NOT NULL,
  "scope"                TEXT NOT NULL,
  "targetTenantIds"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "targetExtensions"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "vitalPbxMohClassName" TEXT NOT NULL,
  "mohProfileId"         TEXT,
  "mode"                 TEXT NOT NULL,
  "requestedBy"          TEXT,
  "status"               TEXT NOT NULL DEFAULT 'pending',
  "appliedAt"            TIMESTAMP(3),
  "error"                TEXT,
  "summary"              JSONB,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MohAssignmentJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MohAssignmentJob_status_idx"
  ON "MohAssignmentJob"("status");

CREATE INDEX "MohAssignmentJob_createdAt_idx"
  ON "MohAssignmentJob"("createdAt");
