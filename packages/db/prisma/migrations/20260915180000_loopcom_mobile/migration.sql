-- LoopCom Mobile (2026-09-15): tenant-scoped mobile service on Telnyx wireless.
-- PURELY ADDITIVE AND SAFE ON A LIVE DATABASE: seven new tables, no existing
-- table or row is touched. Generated with prisma migrate diff from the prior
-- schema; reviewed by hand.

-- CreateTable
CREATE TABLE "MobilePlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "monthlyPriceCents" INTEGER NOT NULL,
    "activationFeeCents" INTEGER NOT NULL DEFAULT 0,
    "simFeeCents" INTEGER NOT NULL DEFAULT 0,
    "esimFeeCents" INTEGER NOT NULL DEFAULT 0,
    "includedDataMb" INTEGER,
    "includedVoiceMinutes" INTEGER,
    "includedSms" INTEGER,
    "dataOverageBehavior" TEXT NOT NULL DEFAULT 'block',
    "dataOverageCentsPerGb" INTEGER NOT NULL DEFAULT 0,
    "roamingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "telnyxCostCentsEstimate" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobilePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "planId" TEXT,
    "phoneNumber" TEXT,
    "telnyxPhoneNumberId" TEXT,
    "telnyxMobilePhoneNumberId" TEXT,
    "simId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "needsReconcile" BOOLEAN NOT NULL DEFAULT false,
    "reconcileReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileSim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "telnyxSimId" TEXT NOT NULL,
    "iccid" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT,
    "esimInstallationStatus" TEXT,
    "eid" TEXT,
    "msisdn" TEXT,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "simCardGroupId" TEXT,
    "dataLimitMb" INTEGER,
    "activationCodeEnc" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "replacedBySimId" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileSim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileSimOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "telnyxOrderId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT,
    "costAmount" TEXT,
    "costCurrency" TEXT,
    "trackingUrl" TEXT,
    "raw" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileSimOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobilePortRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lineId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "telnyxPortingOrderId" TEXT,
    "carrier" TEXT,
    "focDate" TIMESTAMP(3),
    "detail" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobilePortRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileUsageRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "lineId" TEXT,
    "simId" TEXT,
    "telnyxSimId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'detail_record',
    "providerRecordId" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileWebhookEvent" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "tenantId" TEXT,
    "telnyxSimId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "MobileWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MobileLine_simId_key" ON "MobileLine"("simId");

-- CreateIndex
CREATE INDEX "MobileLine_tenantId_status_idx" ON "MobileLine"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MobileLine_phoneNumber_idx" ON "MobileLine"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MobileSim_telnyxSimId_key" ON "MobileSim"("telnyxSimId");

-- CreateIndex
CREATE INDEX "MobileSim_tenantId_status_idx" ON "MobileSim"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MobileSim_iccid_idx" ON "MobileSim"("iccid");

-- CreateIndex
CREATE UNIQUE INDEX "MobileSimOrder_telnyxOrderId_key" ON "MobileSimOrder"("telnyxOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "MobilePortRequest_telnyxPortingOrderId_key" ON "MobilePortRequest"("telnyxPortingOrderId");

-- CreateIndex
CREATE INDEX "MobilePortRequest_tenantId_status_idx" ON "MobilePortRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MobileUsageRecord_tenantId_recordedAt_idx" ON "MobileUsageRecord"("tenantId", "recordedAt");

-- CreateIndex
CREATE INDEX "MobileUsageRecord_telnyxSimId_recordedAt_idx" ON "MobileUsageRecord"("telnyxSimId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileUsageRecord_kind_providerRecordId_key" ON "MobileUsageRecord"("kind", "providerRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "MobileWebhookEvent_providerEventId_key" ON "MobileWebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "MobileWebhookEvent_eventType_receivedAt_idx" ON "MobileWebhookEvent"("eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "MobileWebhookEvent_status_receivedAt_idx" ON "MobileWebhookEvent"("status", "receivedAt");

-- AddForeignKey
ALTER TABLE "MobileLine" ADD CONSTRAINT "MobileLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileLine" ADD CONSTRAINT "MobileLine_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MobilePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileLine" ADD CONSTRAINT "MobileLine_simId_fkey" FOREIGN KEY ("simId") REFERENCES "MobileSim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileSim" ADD CONSTRAINT "MobileSim_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileSimOrder" ADD CONSTRAINT "MobileSimOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobilePortRequest" ADD CONSTRAINT "MobilePortRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobilePortRequest" ADD CONSTRAINT "MobilePortRequest_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "MobileLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileUsageRecord" ADD CONSTRAINT "MobileUsageRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileUsageRecord" ADD CONSTRAINT "MobileUsageRecord_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "MobileLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileUsageRecord" ADD CONSTRAINT "MobileUsageRecord_simId_fkey" FOREIGN KEY ("simId") REFERENCES "MobileSim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

