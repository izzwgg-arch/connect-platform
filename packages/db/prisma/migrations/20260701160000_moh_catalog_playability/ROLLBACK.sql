-- Reference rollback for 20260701160000_moh_catalog_playability.
-- Reverses the additive PbxMohClass catalog/playability columns. Non-destructive
-- to any other table. Run ONLY as part of an approved rollback (not by the
-- deploy path). See docs/pbx/connect-moh-per-source-phase2-proof.md.
DROP INDEX IF EXISTS "PbxMohClass_pbxInstanceId_selectable_idx";
ALTER TABLE "PbxMohClass" DROP COLUMN IF EXISTS "lastProbedAt";
ALTER TABLE "PbxMohClass" DROP COLUMN IF EXISTS "unavailableReason";
ALTER TABLE "PbxMohClass" DROP COLUMN IF EXISTS "selectable";
ALTER TABLE "PbxMohClass" DROP COLUMN IF EXISTS "loadedInAsterisk";
ALTER TABLE "PbxMohClass" DROP COLUMN IF EXISTS "origin";
