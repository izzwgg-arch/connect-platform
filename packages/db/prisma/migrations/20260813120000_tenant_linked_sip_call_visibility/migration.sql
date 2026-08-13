-- Per-tenant switch: tenant-wide call viewers of this tenant also see call
-- history + recordings for foreign extensions linked in via UserSipAccount.
ALTER TABLE "Tenant" ADD COLUMN "linkedSipCallVisibilityEnabled" BOOLEAN NOT NULL DEFAULT false;
