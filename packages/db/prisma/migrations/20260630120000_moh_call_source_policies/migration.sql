-- Per-call-source MOH policies + schedule extension/call-type targeting.
--
-- Strictly additive. No existing column is dropped or retyped; the two new
-- MohScheduleRule columns and one MohSourcePolicy table default such that all
-- existing rows keep their exact current behavior (tenant-wide, all call
-- sources). Inert until the publish path folds these into the additive AstDB
-- keys `connect/t_<slug>/moh/src/<source>` — the dialplan falls through to the
-- existing tenant/extension default keys when no per-source policy exists.

-- ── 1. MohScheduleRule: targeting columns ───────────────────────────────────
-- Defaults chosen so legacy rows behave identically: scope='tenant',
-- extension='' (tenant-wide), callSource='' (all call sources).
ALTER TABLE "MohScheduleRule"
  ADD COLUMN "scope"      TEXT NOT NULL DEFAULT 'tenant',
  ADD COLUMN "extension"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "callSource" TEXT NOT NULL DEFAULT '';

CREATE INDEX "MohScheduleRule_scheduleId_scope_extension_idx"
  ON "MohScheduleRule"("scheduleId", "scope", "extension");

-- ── 2. MohSourcePolicy ──────────────────────────────────────────────────────
-- One row per (tenantId, extension, source). extension='' => tenant scope.
CREATE TABLE "MohSourcePolicy" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "scope"                TEXT NOT NULL,
  "extension"            TEXT NOT NULL DEFAULT '',
  "source"               TEXT NOT NULL,
  "vitalPbxMohClassName" TEXT NOT NULL,
  "mohProfileId"         TEXT,
  "enabled"              BOOLEAN NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  "createdBy"            TEXT,
  "updatedBy"            TEXT,
  CONSTRAINT "MohSourcePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MohSourcePolicy_tenantId_extension_source_key"
  ON "MohSourcePolicy"("tenantId", "extension", "source");

CREATE INDEX "MohSourcePolicy_tenantId_idx"
  ON "MohSourcePolicy"("tenantId");

CREATE INDEX "MohSourcePolicy_tenantId_scope_idx"
  ON "MohSourcePolicy"("tenantId", "scope");

CREATE INDEX "MohSourcePolicy_tenantId_extension_idx"
  ON "MohSourcePolicy"("tenantId", "extension");

CREATE INDEX "MohSourcePolicy_enabled_idx"
  ON "MohSourcePolicy"("enabled");

ALTER TABLE "MohSourcePolicy"
  ADD CONSTRAINT "MohSourcePolicy_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohSourcePolicy"
  ADD CONSTRAINT "MohSourcePolicy_mohProfileId_fkey"
  FOREIGN KEY ("mohProfileId") REFERENCES "MohProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. MohGlobalConfig (singleton) ──────────────────────────────────────────
CREATE TABLE "MohGlobalConfig" (
  "id"                   TEXT NOT NULL DEFAULT 'global',
  "vitalPbxMohClassName" TEXT,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  "updatedBy"            TEXT,
  CONSTRAINT "MohGlobalConfig_pkey" PRIMARY KEY ("id")
);
