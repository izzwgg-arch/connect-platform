-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "escalationId" TEXT,
    "ticketRef" TEXT,
    "conversationId" TEXT,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportMessage_userId_tenantId_createdAt_idx" ON "SupportMessage"("userId", "tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportMessage_escalationId_createdAt_idx" ON "SupportMessage"("escalationId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportMessage_direction_readAt_createdAt_idx" ON "SupportMessage"("direction", "readAt", "createdAt");

