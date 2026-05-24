-- CRM Email Templates (Phase 1)
CREATE TABLE "CrmEmailTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'SHARED',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmEmailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmEmailTemplate_tenantId_isArchived_updatedAt_idx" ON "CrmEmailTemplate"("tenantId", "isArchived", "updatedAt");
CREATE INDEX "CrmEmailTemplate_tenantId_createdByUserId_idx" ON "CrmEmailTemplate"("tenantId", "createdByUserId");

ALTER TABLE "CrmEmailTemplate" ADD CONSTRAINT "CrmEmailTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmEmailTemplate" ADD CONSTRAINT "CrmEmailTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
