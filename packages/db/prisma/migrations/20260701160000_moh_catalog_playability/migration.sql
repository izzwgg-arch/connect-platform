-- Additive MOH catalog / playability columns on PbxMohClass.
-- All columns are nullable or defaulted so existing rows are unaffected; the
-- values are (re)computed on the next MOH class refresh sync. No data loss.
ALTER TABLE "PbxMohClass" ADD COLUMN "origin" TEXT;
ALTER TABLE "PbxMohClass" ADD COLUMN "loadedInAsterisk" BOOLEAN;
ALTER TABLE "PbxMohClass" ADD COLUMN "selectable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PbxMohClass" ADD COLUMN "unavailableReason" TEXT;
ALTER TABLE "PbxMohClass" ADD COLUMN "lastProbedAt" TIMESTAMP(3);

CREATE INDEX "PbxMohClass_pbxInstanceId_selectable_idx" ON "PbxMohClass"("pbxInstanceId", "selectable");
