-- DID-level routing + MOH asset uploads (shared-entry architecture).
-- Additive migration: no existing rows touched. All new tables are optional
-- at runtime — publishing an existing IvrRouteProfile still works without
-- DidRouteMapping rows.
--
-- See packages/db/prisma/schema.prisma for full documentation on the model.

-- CreateTable: DidRouteMapping
CREATE TABLE "DidRouteMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "pbxInstanceId" TEXT,
    "pbxInboundRouteId" TEXT,
    "ivrProfileId" TEXT,
    "mohProfileId" TEXT,
    "holdAnnouncePromptRef" TEXT,
    "holdRepeatSec" INTEGER NOT NULL DEFAULT 30,
    "fallbackBehavior" TEXT NOT NULL DEFAULT 'default_ivr',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "DidRouteMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DidRouteMapping_e164_key" ON "DidRouteMapping"("e164");
CREATE INDEX "DidRouteMapping_tenantId_idx" ON "DidRouteMapping"("tenantId");
CREATE INDEX "DidRouteMapping_tenantId_enabled_idx" ON "DidRouteMapping"("tenantId", "enabled");
CREATE INDEX "DidRouteMapping_ivrProfileId_idx" ON "DidRouteMapping"("ivrProfileId");
CREATE INDEX "DidRouteMapping_mohProfileId_idx" ON "DidRouteMapping"("mohProfileId");
CREATE INDEX "DidRouteMapping_pbxInstanceId_idx" ON "DidRouteMapping"("pbxInstanceId");

ALTER TABLE "DidRouteMapping" ADD CONSTRAINT "DidRouteMapping_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DidRouteMapping" ADD CONSTRAINT "DidRouteMapping_ivrProfileId_fkey"
    FOREIGN KEY ("ivrProfileId") REFERENCES "IvrRouteProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DidRouteMapping" ADD CONSTRAINT "DidRouteMapping_mohProfileId_fkey"
    FOREIGN KEY ("mohProfileId") REFERENCES "MohProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DidRouteMapping" ADD CONSTRAINT "DidRouteMapping_pbxInstanceId_fkey"
    FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: MohAsset
CREATE TABLE "MohAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mohClassName" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "mimeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "MohAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MohAsset_tenantId_mohClassName_key" ON "MohAsset"("tenantId", "mohClassName");
CREATE UNIQUE INDEX "MohAsset_contentHash_key" ON "MohAsset"("contentHash");
CREATE INDEX "MohAsset_tenantId_idx" ON "MohAsset"("tenantId");
CREATE INDEX "MohAsset_tenantId_status_idx" ON "MohAsset"("tenantId", "status");
CREATE INDEX "MohAsset_status_idx" ON "MohAsset"("status");

ALTER TABLE "MohAsset" ADD CONSTRAINT "MohAsset_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
