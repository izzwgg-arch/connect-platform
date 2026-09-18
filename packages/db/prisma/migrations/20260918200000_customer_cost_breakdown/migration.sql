-- Customer cost breakdown (office-only): carrier rates, carrier usage records,
-- feed cursors. Additive only — no existing table is touched.
CREATE TABLE "CarrierRate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(14,6) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TYPED',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarrierRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CarrierRate_key_effectiveFrom_idx" ON "CarrierRate"("key", "effectiveFrom");

CREATE TABLE "CarrierUsageRecord" (
    "id" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "externalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "numberE164" TEXT,
    "subAccount" TEXT,
    "tenantId" TEXT,
    "quantity" DECIMAL(14,4) NOT NULL,
    "cost" DECIMAL(14,6),
    "description" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarrierUsageRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CarrierUsageRecord_carrier_kind_externalId_key" ON "CarrierUsageRecord"("carrier", "kind", "externalId");
CREATE INDEX "CarrierUsageRecord_tenantId_occurredAt_idx" ON "CarrierUsageRecord"("tenantId", "occurredAt");
CREATE INDEX "CarrierUsageRecord_occurredAt_idx" ON "CarrierUsageRecord"("occurredAt");
CREATE INDEX "CarrierUsageRecord_numberE164_idx" ON "CarrierUsageRecord"("numberE164");

CREATE TABLE "CarrierSyncCursor" (
    "id" TEXT NOT NULL,
    "lastDate" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastSummary" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CarrierSyncCursor_pkey" PRIMARY KEY ("id")
);
