-- MANUAL ROLLBACK for 20260630120000_moh_call_source_policies
--
-- Reference only. Prisma executes migration.sql (never this file). Run by a
-- human, under the deploy runbook, ONLY if this migration must be reversed.
-- Order matters: drop the additive table + columns; nothing else is touched.
--
-- Safe to run: everything below is strictly additive in the forward migration,
-- so dropping it restores the exact prior schema and behavior. No existing
-- column is altered, so no data outside these new objects is affected.
--
-- Preconditions: no application build that references MohSourcePolicy /
-- MohGlobalConfig / MohScheduleRule.scope|extension|callSource is running
-- (deploy the reverted API/worker first). Otherwise queries will error.

BEGIN;

-- 3. Global default singleton.
DROP TABLE IF EXISTS "MohGlobalConfig";

-- 2. Per-source policy table (FKs + indexes drop with the table).
DROP TABLE IF EXISTS "MohSourcePolicy";

-- 1. Schedule targeting columns + their composite index.
DROP INDEX IF EXISTS "MohScheduleRule_scheduleId_scope_extension_idx";
ALTER TABLE "MohScheduleRule"
  DROP COLUMN IF EXISTS "callSource",
  DROP COLUMN IF EXISTS "extension",
  DROP COLUMN IF EXISTS "scope";

COMMIT;
