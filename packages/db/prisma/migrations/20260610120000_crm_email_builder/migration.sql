-- CRM Email Template Builder
-- Backward-compatible: existing CrmEmailTemplate.bodyText records remain valid.

ALTER TABLE "CrmEmailSendLog"
  ADD COLUMN IF NOT EXISTS "attachmentSnapshot" JSONB;

ALTER TABLE "CrmEmailTemplate"
  ADD COLUMN IF NOT EXISTS "previewText" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'Custom',
  ADD COLUMN IF NOT EXISTS "isFavorite" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isDraft" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "usageCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bodyHtml" TEXT,
  ADD COLUMN IF NOT EXISTS "bodyJson" JSONB,
  ADD COLUMN IF NOT EXISTS "builderVersion" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS "CrmEmailTemplate_tenantId_category_isArchived_idx"
  ON "CrmEmailTemplate"("tenantId", "category", "isArchived");

CREATE INDEX IF NOT EXISTS "CrmEmailTemplate_tenantId_isFavorite_updatedAt_idx"
  ON "CrmEmailTemplate"("tenantId", "isFavorite", "updatedAt");

CREATE TABLE IF NOT EXISTS "CrmEmailBranding" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "logoUrl" TEXT,
  "logoStorageKey" TEXT,
  "logoMimeType" TEXT,
  "logoFileName" TEXT,
  "businessName" TEXT,
  "tagline" TEXT,
  "website" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "facebookUrl" TEXT,
  "instagramUrl" TEXT,
  "linkedinUrl" TEXT,
  "xUrl" TEXT,
  "createdByUserId" TEXT,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmEmailBranding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmEmailBranding_tenantId_key"
  ON "CrmEmailBranding"("tenantId");

CREATE INDEX IF NOT EXISTS "CrmEmailBranding_tenantId_updatedAt_idx"
  ON "CrmEmailBranding"("tenantId", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrmEmailBranding_tenantId_fkey'
  ) THEN
    ALTER TABLE "CrmEmailBranding"
      ADD CONSTRAINT "CrmEmailBranding_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CrmEmailSignature" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "senderName" TEXT,
  "senderTitle" TEXT,
  "companyName" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "website" TEXT,
  "logoUrl" TEXT,
  "avatarUrl" TEXT,
  "facebookUrl" TEXT,
  "instagramUrl" TEXT,
  "linkedinUrl" TEXT,
  "xUrl" TEXT,
  "legalDisclaimer" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmEmailSignature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmEmailSignature_tenantId_userId_key"
  ON "CrmEmailSignature"("tenantId", "userId");

CREATE INDEX IF NOT EXISTS "CrmEmailSignature_tenantId_idx"
  ON "CrmEmailSignature"("tenantId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrmEmailSignature_tenantId_fkey'
  ) THEN
    ALTER TABLE "CrmEmailSignature"
      ADD CONSTRAINT "CrmEmailSignature_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrmEmailSignature_userId_fkey'
  ) THEN
    ALTER TABLE "CrmEmailSignature"
      ADD CONSTRAINT "CrmEmailSignature_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CrmEmailTemplateAttachment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "uploadedByUserId" TEXT,
  "originalFileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "disposition" TEXT NOT NULL DEFAULT 'ATTACHMENT',
  "isOptional" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmEmailTemplateAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmEmailTemplateAttachment_tenantId_templateId_idx"
  ON "CrmEmailTemplateAttachment"("tenantId", "templateId");

CREATE INDEX IF NOT EXISTS "CrmEmailTemplateAttachment_tenantId_createdAt_idx"
  ON "CrmEmailTemplateAttachment"("tenantId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrmEmailTemplateAttachment_tenantId_fkey'
  ) THEN
    ALTER TABLE "CrmEmailTemplateAttachment"
      ADD CONSTRAINT "CrmEmailTemplateAttachment_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrmEmailTemplateAttachment_templateId_fkey'
  ) THEN
    ALTER TABLE "CrmEmailTemplateAttachment"
      ADD CONSTRAINT "CrmEmailTemplateAttachment_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "CrmEmailTemplate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CrmEmailTemplateAttachment_uploadedByUserId_fkey'
  ) THEN
    ALTER TABLE "CrmEmailTemplateAttachment"
      ADD CONSTRAINT "CrmEmailTemplateAttachment_uploadedByUserId_fkey"
      FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
