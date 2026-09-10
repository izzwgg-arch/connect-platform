-- CreateTable
CREATE TABLE "CarrierMigration" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "connectTenantId" TEXT,
    "tenantNameSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "holdReason" TEXT,
    "voiceCarrier" TEXT NOT NULL DEFAULT 'voipms',
    "smsCarrier" TEXT NOT NULL DEFAULT 'voipms',
    "portReference" TEXT,
    "focDate" TIMESTAMP(3),
    "filedAt" TIMESTAMP(3),
    "filedByUserId" TEXT,
    "landedAt" TIMESTAMP(3),
    "pointedAt" TIMESTAMP(3),
    "swNumberId" TEXT,
    "smsFlippedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierMigration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CarrierMigration_did_key" ON "CarrierMigration"("did");

-- CreateIndex
CREATE INDEX "CarrierMigration_status_idx" ON "CarrierMigration"("status");

-- CreateIndex
CREATE INDEX "CarrierMigration_connectTenantId_idx" ON "CarrierMigration"("connectTenantId");

