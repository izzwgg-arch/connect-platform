DO $$ BEGIN
  CREATE TYPE "SmsProviderRoutingMode" AS ENUM ('SINGLE_PRIMARY', 'FAILOVER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "smsRoutingMode" "SmsProviderRoutingMode" NOT NULL DEFAULT 'FAILOVER',
  ADD COLUMN IF NOT EXISTS "smsPrimaryProvider" "IntegrationProvider" NOT NULL DEFAULT 'TWILIO',
  ADD COLUMN IF NOT EXISTS "smsSecondaryProvider" "IntegrationProvider" DEFAULT 'VOIPMS',
  ADD COLUMN IF NOT EXISTS "smsProviderLock" "IntegrationProvider",
  ADD COLUMN IF NOT EXISTS "smsProviderLockReason" TEXT,
  ADD COLUMN IF NOT EXISTS "smsProviderLockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "smsProviderLockedByUserId" TEXT;

ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_smsProviderLockedByUserId_fkey"
  FOREIGN KEY ("smsProviderLockedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsMessage"
  ADD COLUMN IF NOT EXISTS "provider" "IntegrationProvider",
  ADD COLUMN IF NOT EXISTS "providerErrorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "providerAttemptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "providerRoute" TEXT;

CREATE TABLE IF NOT EXISTS "ProviderHealth" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "provider" "IntegrationProvider" NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "circuitOpenUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderHealth_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderHealth_tenantId_provider_windowStart_key"
  ON "ProviderHealth"("tenantId", "provider", "windowStart");

CREATE INDEX IF NOT EXISTS "ProviderHealth_tenantId_provider_idx"
  ON "ProviderHealth"("tenantId", "provider");
