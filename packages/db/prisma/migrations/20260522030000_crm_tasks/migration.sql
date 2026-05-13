-- CRM Phase 1D: Tasks / Follow-ups.
-- Adds CrmContactTask table + extends CrmTimelineEventType with task event values.
-- No existing tables modified beyond the enum extension.

-- Extend existing CrmTimelineEventType enum (PostgreSQL supports ADD VALUE)
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'TASK_CREATED';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'TASK_COMPLETED';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'TASK_CANCELED';

-- CreateEnum
CREATE TYPE "CrmTaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "CrmTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELED');

-- CreateTable: CrmContactTask
CREATE TABLE "CrmContactTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dueAt" TIMESTAMP(3),
    "assignedToUserId" TEXT,
    "priority" "CrmTaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "CrmTaskStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContactTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmContactTask_tenantId_contactId_status_dueAt_idx"
    ON "CrmContactTask"("tenantId", "contactId", "status", "dueAt");
CREATE INDEX "CrmContactTask_tenantId_assignedToUserId_status_dueAt_idx"
    ON "CrmContactTask"("tenantId", "assignedToUserId", "status", "dueAt");
CREATE INDEX "CrmContactTask_tenantId_status_dueAt_idx"
    ON "CrmContactTask"("tenantId", "status", "dueAt");

-- AddForeignKey
ALTER TABLE "CrmContactTask" ADD CONSTRAINT "CrmContactTask_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmContactTask" ADD CONSTRAINT "CrmContactTask_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmContactTask" ADD CONSTRAINT "CrmContactTask_assignedToUserId_fkey"
    FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmContactTask" ADD CONSTRAINT "CrmContactTask_completedByUserId_fkey"
    FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmContactTask" ADD CONSTRAINT "CrmContactTask_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
