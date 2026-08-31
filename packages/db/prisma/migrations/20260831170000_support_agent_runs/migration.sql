-- CreateTable
CREATE TABLE "SupportAgentRun" (
    "id" TEXT NOT NULL,
    "ticketRef" TEXT NOT NULL,
    "escalationId" TEXT,
    "tenantName" TEXT,
    "requestSummary" TEXT,
    "lane" TEXT NOT NULL DEFAULT 'customer',
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "host" TEXT,
    "sessionId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "steps" JSONB,
    "report" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAgentWatcher" (
    "host" TEXT NOT NULL,
    "lastBeatAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "currentTicket" TEXT,
    "usedToday" JSONB,
    "caps" JSONB,
    "lastError" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "version" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAgentWatcher_pkey" PRIMARY KEY ("host")
);

-- CreateIndex
CREATE INDEX "SupportAgentRun_status_startedAt_idx" ON "SupportAgentRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "SupportAgentRun_ticketRef_startedAt_idx" ON "SupportAgentRun"("ticketRef", "startedAt");

