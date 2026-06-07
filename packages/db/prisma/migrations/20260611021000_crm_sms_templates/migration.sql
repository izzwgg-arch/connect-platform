-- Add tenant-scoped reusable SMS templates for the CRM contact SMS workspace.
CREATE TABLE IF NOT EXISTS "CrmSmsTemplate" (
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
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmSmsTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrmSmsTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CrmSmsTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CrmSmsTemplate_tenantId_isArchived_updatedAt_idx"
  ON "CrmSmsTemplate"("tenantId", "isArchived", "updatedAt");

CREATE INDEX IF NOT EXISTS "CrmSmsTemplate_tenantId_createdByUserId_idx"
  ON "CrmSmsTemplate"("tenantId", "createdByUserId");

CREATE INDEX IF NOT EXISTS "CrmSmsTemplate_tenantId_isFavorite_updatedAt_idx"
  ON "CrmSmsTemplate"("tenantId", "isFavorite", "updatedAt");
