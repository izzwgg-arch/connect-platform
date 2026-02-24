DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus') THEN
    EXECUTE 'ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS ''PENDING''';
  ELSIF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscriptionstatus') THEN
    EXECUTE 'ALTER TYPE subscriptionstatus ADD VALUE IF NOT EXISTS ''PENDING''';
  END IF;
END $$;

ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "billingEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "pastDueSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "Receipt" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Receipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Receipt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Receipt_tenantId_createdAt_idx" ON "Receipt"("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "Alert" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  CONSTRAINT "Alert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Alert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Alert_tenantId_createdAt_idx" ON "Alert"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "Alert_severity_createdAt_idx" ON "Alert"("severity", "createdAt");
