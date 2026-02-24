DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM ('NONE','TRIALING','ACTIVE','PAST_DUE','CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('PENDING','SUCCEEDED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "smsSubscriptionRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "smsBillingEnforced" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "Subscription" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "planCode" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'NONE',
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "provider" TEXT NOT NULL DEFAULT 'SOLA_CARDKNOX',
  "providerCustomerId" TEXT,
  "providerSubscriptionId" TEXT,
  "providerPaymentMethodId" TEXT,
  "paymentMethodBrand" TEXT,
  "paymentMethodLast4" TEXT,
  "paymentMethodExpMonth" TEXT,
  "paymentMethodExpYear" TEXT,
  "lastPaymentStatus" "PaymentStatus",
  "lastPaymentAt" TIMESTAMP(3),
  "lastFailureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_tenantId_key" ON "Subscription"("tenantId");

CREATE TABLE IF NOT EXISTS "PaymentEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT,
  "type" TEXT NOT NULL,
  "status" "PaymentStatus" NOT NULL,
  "amountCents" INTEGER,
  "currency" TEXT,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PaymentEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PaymentEvent_tenantId_receivedAt_idx" ON "PaymentEvent"("tenantId", "receivedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_provider_providerEventId_key" ON "PaymentEvent"("provider", "providerEventId");

CREATE TABLE IF NOT EXISTS "UsageLedger" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPriceCents" INTEGER NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "referenceId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "UsageLedger_tenantId_occurredAt_idx" ON "UsageLedger"("tenantId", "occurredAt");
