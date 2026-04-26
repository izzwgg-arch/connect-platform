-- Connect unified chat + VoIP.ms SMS tables

CREATE TYPE "ConnectChatThreadType" AS ENUM ('SMS', 'DM', 'GROUP', 'TENANT_GROUP');
CREATE TYPE "ConnectChatMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');
CREATE TYPE "ConnectChatMessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'VOICE_NOTE', 'FILE', 'LOCATION', 'SYSTEM');
CREATE TYPE "ConnectChatParticipantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

CREATE TABLE "GlobalVoipMsConfig" (
    "id" TEXT NOT NULL,
    "credentialsEncrypted" TEXT,
    "credentialsKeyId" TEXT NOT NULL DEFAULT 'v1',
    "apiBaseUrl" TEXT,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mmsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookSecretEncrypted" TEXT,
    "lastDidsSyncAt" TIMESTAMP(3),
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthOk" BOOLEAN,
    "lastHealthMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GlobalVoipMsConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantSmsNumber" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "provider" "IntegrationProvider" NOT NULL DEFAULT 'VOIPMS',
    "voipmsDid" TEXT,
    "phoneRaw" TEXT,
    "phoneE164" TEXT NOT NULL,
    "smsCapable" BOOLEAN NOT NULL DEFAULT true,
    "mmsCapable" BOOLEAN NOT NULL DEFAULT false,
    "assignedUserId" TEXT,
    "assignedExtensionId" TEXT,
    "isTenantDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantSmsNumber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantSmsNumber_phoneE164_key" ON "TenantSmsNumber"("phoneE164");
CREATE INDEX "TenantSmsNumber_tenantId_active_idx" ON "TenantSmsNumber"("tenantId", "active");
CREATE INDEX "TenantSmsNumber_tenantId_isTenantDefault_idx" ON "TenantSmsNumber"("tenantId", "isTenantDefault");

ALTER TABLE "TenantSmsNumber" ADD CONSTRAINT "TenantSmsNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TenantSmsNumber" ADD CONSTRAINT "TenantSmsNumber_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenantSmsNumber" ADD CONSTRAINT "TenantSmsNumber_assignedExtensionId_fkey" FOREIGN KEY ("assignedExtensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ConnectChatThread" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ConnectChatThreadType" NOT NULL,
    "title" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDefaultTenantGroup" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "dedupeKey" TEXT NOT NULL,
    "tenantSmsRaw" TEXT,
    "tenantSmsE164" TEXT,
    "externalSmsRaw" TEXT,
    "externalSmsE164" TEXT,
    "smsInboxOwnerUserId" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "ConnectChatThread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectChatThread_dedupeKey_key" ON "ConnectChatThread"("dedupeKey");
CREATE INDEX "ConnectChatThread_tenantId_lastMessageAt_idx" ON "ConnectChatThread"("tenantId", "lastMessageAt");
CREATE INDEX "ConnectChatThread_tenantId_type_idx" ON "ConnectChatThread"("tenantId", "type");
CREATE INDEX "ConnectChatThread_tenantSmsE164_externalSmsE164_idx" ON "ConnectChatThread"("tenantSmsE164", "externalSmsE164");

ALTER TABLE "ConnectChatThread" ADD CONSTRAINT "ConnectChatThread_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConnectChatParticipant" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "participantKey" TEXT NOT NULL,
    "userId" TEXT,
    "extensionId" TEXT,
    "role" "ConnectChatParticipantRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "archivedForUser" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ConnectChatParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectChatParticipant_threadId_participantKey_key" ON "ConnectChatParticipant"("threadId", "participantKey");
CREATE INDEX "ConnectChatParticipant_userId_idx" ON "ConnectChatParticipant"("userId");

ALTER TABLE "ConnectChatParticipant" ADD CONSTRAINT "ConnectChatParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ConnectChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectChatParticipant" ADD CONSTRAINT "ConnectChatParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectChatParticipant" ADD CONSTRAINT "ConnectChatParticipant_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConnectChatMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderUserId" TEXT,
    "senderExtensionId" TEXT,
    "direction" "ConnectChatMessageDirection" NOT NULL,
    "type" "ConnectChatMessageType" NOT NULL DEFAULT 'TEXT',
    "body" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "replyToMessageId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedForEveryoneAt" TIMESTAMP(3),
    "deletedForUserIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "smsProviderMessageId" TEXT,
    "deliveryStatus" TEXT,
    "deliveryError" TEXT,
    CONSTRAINT "ConnectChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConnectChatMessage_threadId_createdAt_idx" ON "ConnectChatMessage"("threadId", "createdAt");
CREATE INDEX "ConnectChatMessage_tenantId_createdAt_idx" ON "ConnectChatMessage"("tenantId", "createdAt");
CREATE INDEX "ConnectChatMessage_smsProviderMessageId_idx" ON "ConnectChatMessage"("smsProviderMessageId");

ALTER TABLE "ConnectChatMessage" ADD CONSTRAINT "ConnectChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ConnectChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectChatMessage" ADD CONSTRAINT "ConnectChatMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConnectChatMessage" ADD CONSTRAINT "ConnectChatMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "ConnectChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ConnectChatMessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentHash" TEXT,
    "scanStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectChatMessageAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConnectChatMessageAttachment_tenantId_idx" ON "ConnectChatMessageAttachment"("tenantId");
CREATE INDEX "ConnectChatMessageAttachment_messageId_idx" ON "ConnectChatMessageAttachment"("messageId");

ALTER TABLE "ConnectChatMessageAttachment" ADD CONSTRAINT "ConnectChatMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConnectChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConnectChatMessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectChatMessageReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectChatMessageReaction_messageId_userId_emoji_key" ON "ConnectChatMessageReaction"("messageId", "userId", "emoji");
CREATE INDEX "ConnectChatMessageReaction_messageId_idx" ON "ConnectChatMessageReaction"("messageId");

ALTER TABLE "ConnectChatMessageReaction" ADD CONSTRAINT "ConnectChatMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConnectChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SmsRoutingLog" (
    "id" TEXT NOT NULL,
    "rawFrom" TEXT,
    "rawTo" TEXT,
    "normalizedFrom" TEXT,
    "normalizedTo" TEXT,
    "direction" TEXT NOT NULL,
    "resolvedTenantId" TEXT,
    "resolvedUserId" TEXT,
    "resolvedExtensionId" TEXT,
    "resolvedThreadId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmsRoutingLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SmsRoutingLog_createdAt_idx" ON "SmsRoutingLog"("createdAt");
CREATE INDEX "SmsRoutingLog_normalizedTo_createdAt_idx" ON "SmsRoutingLog"("normalizedTo", "createdAt");

ALTER TABLE "SmsRoutingLog" ADD CONSTRAINT "SmsRoutingLog_resolvedTenantId_fkey" FOREIGN KEY ("resolvedTenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
