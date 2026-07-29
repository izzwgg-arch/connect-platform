-- Exactly-once claim ledger for user-visible mobile alerts.
-- Additive only: new table, no changes to existing tables.
CREATE TABLE "NotificationLedger" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "source" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationLedger_type_entityId_userId_key" ON "NotificationLedger"("type", "entityId", "userId");
CREATE INDEX "NotificationLedger_type_sentAt_idx" ON "NotificationLedger"("type", "sentAt");
CREATE INDEX "NotificationLedger_sentAt_idx" ON "NotificationLedger"("sentAt");

-- Notification reconciler: global recent-inbound message sweep.
CREATE INDEX "ConnectChatMessage_createdAt_idx" ON "ConnectChatMessage"("createdAt");
