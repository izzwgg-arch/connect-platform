-- Support agent → owner notices, 2026-09-14. The automatic support agent texts
-- the owner what it is changing (scope 'tenant': proceeds unless he replies
-- STOP) or asks before a change that affects every customer (scope 'system':
-- waits for GO). A new table only; nothing existing is altered, so the old api
-- container keeps working through the blue/green swap.

-- CreateTable
CREATE TABLE "SupportAgentNotice" (
    "id" TEXT NOT NULL,
    "escalationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "smsSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedFrom" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAgentNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportAgentNotice_codeHash_key" ON "SupportAgentNotice"("codeHash");

-- CreateIndex
CREATE INDEX "SupportAgentNotice_escalationId_createdAt_idx" ON "SupportAgentNotice"("escalationId", "createdAt");
