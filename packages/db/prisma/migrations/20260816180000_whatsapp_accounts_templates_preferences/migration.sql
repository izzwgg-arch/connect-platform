-- WhatsApp accounts, templates, contact preferences and the policy audit trail.
--
-- These six models have been declared in schema.prisma since ee78362c
-- (2026-05-24) with no migration behind them, so production has never had the
-- tables. This creates them, and adds the one field the per-tenant hosting
-- decision needs.
--
-- WhatsAppHostingMode is the switch:
--   PLATFORM — the number lives under Connect's own WABA. Nothing for the
--              customer to set up; Connect is billed by Meta and rebills.
--              ⛔ The quality rating is SHARED. Ordinary recipients blocking
--              ordinary compliant messages still drags it down for every tenant
--              on it, and no send guard can prevent that — no rule was broken.
--   OWN      — the customer's own WABA and their own rating, so a problem stays
--              theirs. Requires Tech Provider status, which requires business
--              verification, so it cannot be switched on yet.
--
-- ⛔ Both modes must resolve credentials through ONE resolver. Two credential
-- paths is precisely the shape that shipped the two IVR publish paths and the
-- two welcome-email paths half-fixed in this repo.
--
-- Purely additive: 6 tables, 17 indexes, 11 foreign keys, no DROP of any kind.
-- Verified by extracting only WhatsApp statements from a full
-- `prisma migrate diff` against production and asserting zero destructive verbs.
--
-- ⛔ DO NOT generate migrations here with a full `prisma migrate diff` or
-- `prisma migrate dev`. schema.prisma and production disagree in ~50 unrelated
-- places (extra columns, defaults, foreign keys and indexes that hand-written
-- migrations added and Prisma does not model). A whole-schema diff proposes
-- dropping ConnectCdr.recordingStatus, CrmLeadDocument.leadId, ~25 foreign keys
-- and 4 indexes from live data. `prisma migrate deploy` never diffs, so the
-- drift is inert in normal operation — but it is a live trap for anyone
-- regenerating migrations.
--
-- WhatsAppUsageEvent and WhatsAppPricingRate are created as drafted in May and
-- are UNUSED — metering and rebilling are deferred. Their shape is provisional;
-- an empty table costs nothing and settles the schema drift.

-- CreateEnum
CREATE TYPE "WhatsAppHostingMode" AS ENUM ('PLATFORM', 'OWN');
-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "WhatsAppProviderType" NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "wabaId" TEXT,
    "messagingServiceSid" TEXT,
    "displayName" TEXT,
    "profilePhotoUrl" TEXT,
    "aboutText" TEXT,
    "verificationStatus" TEXT,
    "lifecycleStatus" TEXT,
    "verificationMethod" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastVerificationAttemptAt" TIMESTAMP(3),
    "lastProviderError" TEXT,
    "webhookStatus" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "ownershipKind" TEXT NOT NULL DEFAULT 'TENANT',
    "ownerUserId" TEXT,
    "providerConfigId" TEXT,
    "hostingMode" "WhatsAppHostingMode" NOT NULL DEFAULT 'PLATFORM',
    "accessTokenEncrypted" TEXT,
    "settings" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "whatsappAccountId" TEXT NOT NULL,
    "provider" "WhatsAppProviderType" NOT NULL,
    "providerTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "bodyPreview" TEXT,
    "variableSchema" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WhatsAppUsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "whatsappAccountId" TEXT,
    "provider" "WhatsAppProviderType" NOT NULL,
    "category" TEXT NOT NULL,
    "country" TEXT,
    "conversationId" TEXT,
    "externalMessageId" TEXT,
    "connectChatMessageId" TEXT,
    "templateId" TEXT,
    "providerCostMinor" INTEGER,
    "markupBps" INTEGER,
    "billAmountMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "mediaBytes" INTEGER,
    "pricingCountry" TEXT,
    "pricingCategory" TEXT,
    "pricingEffectiveAt" TIMESTAMP(3),
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'estimated',
    "reconciledAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "providerMetadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppUsageEvent_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WhatsAppPricingRate" (
    "id" TEXT NOT NULL,
    "provider" "WhatsAppProviderType" NOT NULL,
    "country" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "providerCostMinor" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppPricingRate_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WhatsAppContactPreference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactE164" TEXT NOT NULL,
    "optedInAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockReason" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppContactPreference_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WhatsAppPolicyAuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "threadId" TEXT,
    "connectChatMessageId" TEXT,
    "whatsappAccountId" TEXT,
    "provider" "WhatsAppProviderType",
    "eventType" TEXT NOT NULL,
    "detail" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppPolicyAuditEvent_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "WhatsAppAccount_tenantId_provider_phoneNumberId_idx" ON "WhatsAppAccount"("tenantId", "provider", "phoneNumberId");
-- CreateIndex
CREATE INDEX "WhatsAppAccount_tenantId_isEnabled_idx" ON "WhatsAppAccount"("tenantId", "isEnabled");
-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_tenantId_provider_phoneE164_key" ON "WhatsAppAccount"("tenantId", "provider", "phoneE164");
-- CreateIndex
CREATE INDEX "WhatsAppTemplate_tenantId_provider_status_idx" ON "WhatsAppTemplate"("tenantId", "provider", "status");
-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_tenantId_provider_whatsappAccountId_name_l_key" ON "WhatsAppTemplate"("tenantId", "provider", "whatsappAccountId", "name", "language");
-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppUsageEvent_idempotencyKey_key" ON "WhatsAppUsageEvent"("idempotencyKey");
-- CreateIndex
CREATE INDEX "WhatsAppUsageEvent_tenantId_occurredAt_idx" ON "WhatsAppUsageEvent"("tenantId", "occurredAt");
-- CreateIndex
CREATE INDEX "WhatsAppUsageEvent_whatsappAccountId_occurredAt_idx" ON "WhatsAppUsageEvent"("whatsappAccountId", "occurredAt");
-- CreateIndex
CREATE INDEX "WhatsAppUsageEvent_provider_category_occurredAt_idx" ON "WhatsAppUsageEvent"("provider", "category", "occurredAt");
-- CreateIndex
CREATE INDEX "WhatsAppUsageEvent_conversationId_idx" ON "WhatsAppUsageEvent"("conversationId");
-- CreateIndex
CREATE INDEX "WhatsAppUsageEvent_connectChatMessageId_idx" ON "WhatsAppUsageEvent"("connectChatMessageId");
-- CreateIndex
CREATE INDEX "WhatsAppPricingRate_provider_country_category_effectiveFrom_idx" ON "WhatsAppPricingRate"("provider", "country", "category", "effectiveFrom");
-- CreateIndex
CREATE INDEX "WhatsAppContactPreference_tenantId_optedOutAt_idx" ON "WhatsAppContactPreference"("tenantId", "optedOutAt");
-- CreateIndex
CREATE INDEX "WhatsAppContactPreference_tenantId_blockedAt_idx" ON "WhatsAppContactPreference"("tenantId", "blockedAt");
-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppContactPreference_tenantId_contactE164_key" ON "WhatsAppContactPreference"("tenantId", "contactE164");
-- CreateIndex
CREATE INDEX "WhatsAppPolicyAuditEvent_tenantId_createdAt_idx" ON "WhatsAppPolicyAuditEvent"("tenantId", "createdAt");
-- CreateIndex
CREATE INDEX "WhatsAppPolicyAuditEvent_tenantId_eventType_createdAt_idx" ON "WhatsAppPolicyAuditEvent"("tenantId", "eventType", "createdAt");
-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_providerConfigId_fkey" FOREIGN KEY ("providerConfigId") REFERENCES "WhatsAppProviderConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppTemplate" ADD CONSTRAINT "WhatsAppTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppTemplate" ADD CONSTRAINT "WhatsAppTemplate_whatsappAccountId_fkey" FOREIGN KEY ("whatsappAccountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppUsageEvent" ADD CONSTRAINT "WhatsAppUsageEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppUsageEvent" ADD CONSTRAINT "WhatsAppUsageEvent_whatsappAccountId_fkey" FOREIGN KEY ("whatsappAccountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppUsageEvent" ADD CONSTRAINT "WhatsAppUsageEvent_connectChatMessageId_fkey" FOREIGN KEY ("connectChatMessageId") REFERENCES "ConnectChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppUsageEvent" ADD CONSTRAINT "WhatsAppUsageEvent_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WhatsAppTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppContactPreference" ADD CONSTRAINT "WhatsAppContactPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WhatsAppPolicyAuditEvent" ADD CONSTRAINT "WhatsAppPolicyAuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
