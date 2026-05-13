-- CRM Phase 1C: Timeline events and contact notes.
-- Append-only timeline log + structured per-author notes.
-- No existing tables modified. CDR event types reserved but not yet written.

-- CreateEnum
CREATE TYPE "CrmTimelineEventType" AS ENUM (
  'CONTACT_CREATED',
  'STAGE_CHANGED',
  'NOTE_ADDED',
  'NOTE_EDITED',
  'CDR_INBOUND',
  'CDR_OUTBOUND'
);

-- CreateTable: CrmTimelineEvent
CREATE TABLE "CrmTimelineEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" "CrmTimelineEventType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "metadata" JSONB,
    "linkedId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmContactNote
CREATE TABLE "CrmContactNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContactNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: CrmTimelineEvent
CREATE INDEX "CrmTimelineEvent_tenantId_contactId_createdAt_idx" ON "CrmTimelineEvent"("tenantId", "contactId", "createdAt");
CREATE INDEX "CrmTimelineEvent_tenantId_type_createdAt_idx" ON "CrmTimelineEvent"("tenantId", "type", "createdAt");
CREATE INDEX "CrmTimelineEvent_contactId_createdAt_idx" ON "CrmTimelineEvent"("contactId", "createdAt");

-- CreateIndex: CrmContactNote
CREATE INDEX "CrmContactNote_tenantId_contactId_createdAt_idx" ON "CrmContactNote"("tenantId", "contactId", "createdAt");
CREATE INDEX "CrmContactNote_contactId_createdAt_idx" ON "CrmContactNote"("contactId", "createdAt");

-- AddForeignKey: CrmTimelineEvent
ALTER TABLE "CrmTimelineEvent" ADD CONSTRAINT "CrmTimelineEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmTimelineEvent" ADD CONSTRAINT "CrmTimelineEvent_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmTimelineEvent" ADD CONSTRAINT "CrmTimelineEvent_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: CrmContactNote
ALTER TABLE "CrmContactNote" ADD CONSTRAINT "CrmContactNote_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmContactNote" ADD CONSTRAINT "CrmContactNote_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmContactNote" ADD CONSTRAINT "CrmContactNote_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
