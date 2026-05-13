-- CRM Contacts Phase 1B: CrmContactMeta overlay on existing Contact model.
-- No existing tables modified. Contact data is NOT duplicated.
-- A Contact becomes a CRM contact when a CrmContactMeta row is created for it.

-- CreateEnum
CREATE TYPE "CrmContactStage" AS ENUM ('LEAD', 'CONTACTED', 'QUALIFIED', 'CUSTOMER', 'CLOSED_LOST');

-- CreateTable
CREATE TABLE "CrmContactMeta" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stage" "CrmContactStage" NOT NULL DEFAULT 'LEAD',
    "assignedToUserId" TEXT,
    "doNotCall" BOOLEAN NOT NULL DEFAULT false,
    "doNotSms" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContactMeta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmContactMeta_contactId_key" ON "CrmContactMeta"("contactId");

-- CreateIndex
CREATE INDEX "CrmContactMeta_tenantId_stage_idx" ON "CrmContactMeta"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "CrmContactMeta_tenantId_assignedToUserId_idx" ON "CrmContactMeta"("tenantId", "assignedToUserId");

-- CreateIndex
CREATE INDEX "CrmContactMeta_tenantId_createdAt_idx" ON "CrmContactMeta"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmContactMeta_tenantId_lastActivityAt_idx" ON "CrmContactMeta"("tenantId", "lastActivityAt");

-- AddForeignKey
ALTER TABLE "CrmContactMeta" ADD CONSTRAINT "CrmContactMeta_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactMeta" ADD CONSTRAINT "CrmContactMeta_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactMeta" ADD CONSTRAINT "CrmContactMeta_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
