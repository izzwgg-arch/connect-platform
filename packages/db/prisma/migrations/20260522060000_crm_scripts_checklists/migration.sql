-- Phase 2C: CRM Scripts + Checklists
-- ALTER TYPE must run outside a transaction block in PostgreSQL.
-- Prisma handles this by wrapping in a DO $$ ... $$ block when needed,
-- but we do it explicitly to be safe.

ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'CHECKLIST_COMPLETED';

-- CrmScript: call script templates
CREATE TABLE "CrmScript" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "body"            TEXT NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmScript_pkey" PRIMARY KEY ("id")
);

-- CrmChecklist: call checklist templates
CREATE TABLE "CrmChecklist" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmChecklist_pkey" PRIMARY KEY ("id")
);

-- CrmChecklistItem: items inside a checklist template
CREATE TABLE "CrmChecklistItem" (
  "id"          TEXT NOT NULL,
  "checklistId" TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "required"    BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CrmChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CrmChecklistResponse: agent's filled response for a call
CREATE TABLE "CrmChecklistResponse" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "checklistId"       TEXT NOT NULL,
  "contactId"         TEXT NOT NULL,
  "linkedId"          TEXT,
  "completedByUserId" TEXT NOT NULL,
  "answers"           JSONB NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmChecklistResponse_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "CrmScript"
  ADD CONSTRAINT "CrmScript_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmScript_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CrmChecklist"
  ADD CONSTRAINT "CrmChecklist_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmChecklist_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CrmChecklistItem"
  ADD CONSTRAINT "CrmChecklistItem_checklistId_fkey"
    FOREIGN KEY ("checklistId") REFERENCES "CrmChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmChecklistResponse"
  ADD CONSTRAINT "CrmChecklistResponse_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmChecklistResponse_checklistId_fkey"
    FOREIGN KEY ("checklistId") REFERENCES "CrmChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmChecklistResponse_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmChecklistResponse_completedByUserId_fkey"
    FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "CrmScript_tenantId_isActive_createdAt_idx"    ON "CrmScript"("tenantId", "isActive", "createdAt");
CREATE INDEX "CrmChecklist_tenantId_isActive_createdAt_idx" ON "CrmChecklist"("tenantId", "isActive", "createdAt");
CREATE INDEX "CrmChecklistItem_checklistId_sortOrder_idx"   ON "CrmChecklistItem"("checklistId", "sortOrder");
CREATE INDEX "CrmChecklistResponse_tenantId_contactId_createdAt_idx" ON "CrmChecklistResponse"("tenantId", "contactId", "createdAt");
CREATE INDEX "CrmChecklistResponse_contactId_createdAt_idx"          ON "CrmChecklistResponse"("contactId", "createdAt");
