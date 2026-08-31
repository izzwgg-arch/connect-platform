-- CreateTable
CREATE TABLE "SupportUpdate" (
    "id" TEXT NOT NULL,
    "escalationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "ticketRef" TEXT NOT NULL,
    "technicalReport" TEXT NOT NULL,
    "plainMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "heldReason" TEXT,
    "safetyIssues" JSONB,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "verdict" TEXT,
    "customerNote" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportUpdate_escalationId_key" ON "SupportUpdate"("escalationId");

-- CreateIndex
CREATE INDEX "SupportUpdate_tenantId_status_idx" ON "SupportUpdate"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SupportUpdate_userId_status_idx" ON "SupportUpdate"("userId", "status");

-- CreateIndex
CREATE INDEX "SupportUpdate_status_createdAt_idx" ON "SupportUpdate"("status", "createdAt");

