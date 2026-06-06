-- CRM SMS templates: tenant-scoped reusable snippets for contact SMS composers.

CREATE TABLE "CrmSmsTemplate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "name" TEXT NOT NULL,
  "bodyText" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'SHARED',
  "isFavorite" BOOLEAN NOT NULL DEFAULT false,
  "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "usageCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CrmSmsTemplate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CrmSmsTemplate"
  ADD CONSTRAINT "CrmSmsTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmSmsTemplate"
  ADD CONSTRAINT "CrmSmsTemplate_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CrmSmsTemplate_tenantId_isArchived_updatedAt_idx"
  ON "CrmSmsTemplate"("tenantId", "isArchived", "updatedAt");

CREATE INDEX "CrmSmsTemplate_tenantId_createdByUserId_idx"
  ON "CrmSmsTemplate"("tenantId", "createdByUserId");

CREATE INDEX "CrmSmsTemplate_tenantId_isFavorite_updatedAt_idx"
  ON "CrmSmsTemplate"("tenantId", "isFavorite", "updatedAt");
