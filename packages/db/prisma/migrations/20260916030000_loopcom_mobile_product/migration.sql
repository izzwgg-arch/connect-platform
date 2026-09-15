-- LoopCom Mobile product build-out (2026-09-16, after mockup approval):
-- subscribers, per-tenant + platform settings, the separate LM- invoice
-- ledger, and line-level subscriber/E911/usage-alert fields.
-- PURELY ADDITIVE AND SAFE ON A LIVE DATABASE: four new tables plus nullable/
-- defaulted columns on MobileLine. No existing row is touched or rewritten.

-- CreateTable
CREATE TABLE "MobileSubscriber" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "portalUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileTenantSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "usageWarnPct" INTEGER NOT NULL DEFAULT 90,
    "billingEmails" JSONB NOT NULL DEFAULT '[]',
    "notifyUsage" BOOLEAN NOT NULL DEFAULT true,
    "notifyPorts" BOOLEAN NOT NULL DEFAULT true,
    "notifyInvoices" BOOLEAN NOT NULL DEFAULT true,
    "notifyNewDevice" BOOLEAN NOT NULL DEFAULT false,
    "memberCanPause" BOOLEAN NOT NULL DEFAULT true,
    "memberCanChangePlan" BOOLEAN NOT NULL DEFAULT false,
    "memberCanReportLost" BOOLEAN NOT NULL DEFAULT true,
    "memberCanPort" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileTenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobilePlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "defaultPlanId" TEXT,
    "spnName" TEXT NOT NULL DEFAULT 'LoopCom',
    "balanceFloorCents" INTEGER NOT NULL DEFAULT 5000,
    "anomalyMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "simReorderFloor" INTEGER NOT NULL DEFAULT 20,
    "staleEsimNudgeDays" INTEGER NOT NULL DEFAULT 7,
    "selfServeLines" BOOLEAN NOT NULL DEFAULT false,
    "topUpsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'LM-',
    "maxLinesPerTenant" INTEGER NOT NULL DEFAULT 50,
    "maxEsimReplacementsPer30" INTEGER NOT NULL DEFAULT 3,
    "codeReadAlertPerHour" INTEGER NOT NULL DEFAULT 5,
    "deadLetterAlert" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobilePlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "totalCents" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "note" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileInvoice_pkey" PRIMARY KEY ("id")
);

-- AlterTable (all nullable or defaulted -- no rewrite of existing rows)
ALTER TABLE "MobileLine" ADD COLUMN "subscriberId" TEXT;
ALTER TABLE "MobileLine" ADD COLUMN "e911Status" TEXT NOT NULL DEFAULT 'missing';
ALTER TABLE "MobileLine" ADD COLUMN "e911Address" JSONB;
ALTER TABLE "MobileLine" ADD COLUMN "usageAlertSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MobileSubscriber_tenantId_idx" ON "MobileSubscriber"("tenantId");
CREATE UNIQUE INDEX "MobileTenantSettings_tenantId_key" ON "MobileTenantSettings"("tenantId");
CREATE UNIQUE INDEX "MobileInvoice_number_key" ON "MobileInvoice"("number");
CREATE UNIQUE INDEX "MobileInvoice_tenantId_periodStart_key" ON "MobileInvoice"("tenantId", "periodStart");
CREATE INDEX "MobileInvoice_tenantId_issuedAt_idx" ON "MobileInvoice"("tenantId", "issuedAt");
CREATE INDEX "MobileLine_subscriberId_idx" ON "MobileLine"("subscriberId");

-- AddForeignKey
ALTER TABLE "MobileSubscriber" ADD CONSTRAINT "MobileSubscriber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileTenantSettings" ADD CONSTRAINT "MobileTenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileInvoice" ADD CONSTRAINT "MobileInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileLine" ADD CONSTRAINT "MobileLine_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "MobileSubscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
