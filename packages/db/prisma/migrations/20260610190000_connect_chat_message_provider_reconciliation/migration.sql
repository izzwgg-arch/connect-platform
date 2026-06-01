-- Unified provider reconciliation fields for Connect Chat messages (SMS, WhatsApp, etc.).
-- Nullable columns only; existing rows remain valid without backfill.

ALTER TABLE "ConnectChatMessage"
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalMessageId" TEXT,
  ADD COLUMN "externalConversationId" TEXT,
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerMetadata" JSONB,
  ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE INDEX "ConnectChatMessage_tenantId_externalProvider_externalMessageId_idx"
  ON "ConnectChatMessage"("tenantId", "externalProvider", "externalMessageId");

CREATE INDEX "ConnectChatMessage_tenantId_externalConversationId_idx"
  ON "ConnectChatMessage"("tenantId", "externalConversationId");
