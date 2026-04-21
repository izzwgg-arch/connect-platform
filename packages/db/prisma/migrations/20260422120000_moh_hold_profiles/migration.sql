-- Hold Profile enhancement: add announcement fields to MohProfile,
-- add previousKeysSnapshot to MohPublishRecord,
-- add MohLastPublishedState cache table.

-- Add unified hold announcement fields to MohProfile
ALTER TABLE "MohProfile"
    ADD COLUMN "holdAnnouncementEnabled"    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "holdAnnouncementRef"        TEXT,
    ADD COLUMN "holdAnnouncementIntervalSec" INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN "introAnnouncementRef"       TEXT;

-- Add previousKeysSnapshot to MohPublishRecord (for reliable rollback)
ALTER TABLE "MohPublishRecord"
    ADD COLUMN "previousKeysSnapshot" JSONB NOT NULL DEFAULT '[]';

-- Last-published state cache: one row per tenant, upserted on every successful publish.
-- Used by the reconciliation worker to skip tenants that are already in sync.
CREATE TABLE "MohLastPublishedState" (
    "tenantId"    TEXT        NOT NULL,
    "mohClass"    TEXT        NOT NULL,
    "holdMode"    TEXT        NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MohLastPublishedState_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "MohLastPublishedState"
    ADD CONSTRAINT "MohLastPublishedState_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
