-- CreateTable
CREATE TABLE "ComplianceItem" (
    "id" TEXT NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "recurrence" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "lastCompletedAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceItem_key_key" ON "ComplianceItem"("key");

-- CreateIndex
CREATE INDEX "ComplianceItem_completedAt_dueDate_idx" ON "ComplianceItem"("completedAt", "dueDate");

