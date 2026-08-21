-- CreateTable
CREATE TABLE "DeskPhoneSetupRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "startedByUserId" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "subnet" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'customer',
    "requestedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "resetAuthorizedAt" TIMESTAMP(3),
    "resetAuthorizedByUserId" TEXT,
    "resetAuthorizedPhoneIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskPhoneSetupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskPhoneSetupPhone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "macAddress" TEXT NOT NULL,
    "ipAddress" TEXT,
    "previousIp" TEXT,
    "vendor" TEXT,
    "model" TEXT,
    "firmware" TEXT,
    "provisioningUrl" TEXT,
    "extensionId" TEXT,
    "extNumber" TEXT,
    "displayName" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "customerNote" TEXT,
    "technicalNote" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resetCount" INTEGER NOT NULL DEFAULT 0,
    "resetRequestedAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "haltedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskPhoneSetupPhone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeskPhoneSetupRun_tenantId_startedAt_idx" ON "DeskPhoneSetupRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "DeskPhoneSetupRun_tenantId_status_idx" ON "DeskPhoneSetupRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DeskPhoneSetupPhone_tenantId_state_idx" ON "DeskPhoneSetupPhone"("tenantId", "state");

-- CreateIndex
CREATE INDEX "DeskPhoneSetupPhone_runId_state_idx" ON "DeskPhoneSetupPhone"("runId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DeskPhoneSetupPhone_runId_macAddress_key" ON "DeskPhoneSetupPhone"("runId", "macAddress");

-- AddForeignKey
ALTER TABLE "DeskPhoneSetupRun" ADD CONSTRAINT "DeskPhoneSetupRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskPhoneSetupPhone" ADD CONSTRAINT "DeskPhoneSetupPhone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskPhoneSetupPhone" ADD CONSTRAINT "DeskPhoneSetupPhone_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DeskPhoneSetupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

