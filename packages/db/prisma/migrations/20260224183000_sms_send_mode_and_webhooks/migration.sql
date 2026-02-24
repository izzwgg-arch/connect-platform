DO $$ BEGIN
  CREATE TYPE "SmsSendMode" AS ENUM ('TEST', 'LIVE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "smsSendMode" "SmsSendMode" NOT NULL DEFAULT 'TEST',
  ADD COLUMN IF NOT EXISTS "smsLiveEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "smsLiveEnabledByUserId" TEXT;

ALTER TABLE "Tenant"
  DROP CONSTRAINT IF EXISTS "Tenant_smsLiveEnabledByUserId_fkey",
  ADD CONSTRAINT "Tenant_smsLiveEnabledByUserId_fkey"
    FOREIGN KEY ("smsLiveEnabledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsMessage"
  ADD COLUMN IF NOT EXISTS "providerStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "lastProviderUpdateAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveryUpdatedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "SmsWebhookEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "provider" "IntegrationProvider" NOT NULL,
  "messageId" TEXT,
  "providerMessageId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SmsWebhookEvent_provider_providerMessageId_idx"
  ON "SmsWebhookEvent"("provider", "providerMessageId");

CREATE INDEX IF NOT EXISTS "SmsWebhookEvent_tenantId_receivedAt_idx"
  ON "SmsWebhookEvent"("tenantId", "receivedAt");

ALTER TABLE "SmsWebhookEvent"
  DROP CONSTRAINT IF EXISTS "SmsWebhookEvent_tenantId_fkey",
  ADD CONSTRAINT "SmsWebhookEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsWebhookEvent"
  DROP CONSTRAINT IF EXISTS "SmsWebhookEvent_messageId_fkey",
  ADD CONSTRAINT "SmsWebhookEvent_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "SmsMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
