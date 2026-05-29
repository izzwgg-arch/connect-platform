DO $$
BEGIN
  CREATE TYPE "CrmVoicemailDropStatus" AS ENUM ('READY', 'PROCESSING', 'FAILED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'VOICEMAIL_DROP';

CREATE TABLE IF NOT EXISTS "CrmVoicemailDrop" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "campaignId" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "status" "CrmVoicemailDropStatus" NOT NULL DEFAULT 'PROCESSING',
  "durationSeconds" INTEGER,
  "originalFileName" TEXT,
  "originalMimeType" TEXT,
  "originalStorageKey" TEXT,
  "pbxStorageKey" TEXT,
  "pbxFileBaseName" TEXT,
  "pbxFormat" TEXT,
  "contentHash" TEXT,
  "sizeBytes" INTEGER,
  "conversionStatus" TEXT NOT NULL DEFAULT 'pending',
  "conversionError" TEXT,
  "usageCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmVoicemailDrop_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "CrmVoicemailDrop"
    ADD CONSTRAINT "CrmVoicemailDrop_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmVoicemailDrop"
    ADD CONSTRAINT "CrmVoicemailDrop_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmVoicemailDrop"
    ADD CONSTRAINT "CrmVoicemailDrop_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "CrmCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "CrmVoicemailDrop_tenantId_status_updatedAt_idx" ON "CrmVoicemailDrop"("tenantId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "CrmVoicemailDrop_tenantId_isDefault_idx" ON "CrmVoicemailDrop"("tenantId", "isDefault");
CREATE INDEX IF NOT EXISTS "CrmVoicemailDrop_tenantId_campaignId_idx" ON "CrmVoicemailDrop"("tenantId", "campaignId");
CREATE INDEX IF NOT EXISTS "CrmVoicemailDrop_tenantId_createdAt_idx" ON "CrmVoicemailDrop"("tenantId", "createdAt");
