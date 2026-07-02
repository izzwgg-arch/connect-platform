-- Reference rollback for 20260702000000_moh_control_and_admin_schedules.
-- Reverses the additive control-mode + admin-schedule + verify columns/tables.
-- Non-destructive to any pre-existing MOH data. Run ONLY as part of an approved
-- rollback (never by the deploy path). Drop tables before columns they don't
-- depend on; FKs cascade with the table drops.

DROP TABLE IF EXISTS "MohAdminScheduleActivation";
DROP TABLE IF EXISTS "MohAdminScheduleTarget";
DROP TABLE IF EXISTS "MohAdminSchedule";
DROP TABLE IF EXISTS "MohExtensionControl";

ALTER TABLE "MohLastPublishedState" DROP COLUMN IF EXISTS "verifiedAt";
ALTER TABLE "MohLastPublishedState" DROP COLUMN IF EXISTS "activeClassObserved";
ALTER TABLE "MohLastPublishedState" DROP COLUMN IF EXISTS "controlMode";

ALTER TABLE "MohPublishRecord" DROP COLUMN IF EXISTS "controlMode";
ALTER TABLE "MohPublishRecord" DROP COLUMN IF EXISTS "verifyStatus";
ALTER TABLE "MohPublishRecord" DROP COLUMN IF EXISTS "verifiedActiveClass";
ALTER TABLE "MohPublishRecord" DROP COLUMN IF EXISTS "verifiedAt";

ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "mohControlMode";
