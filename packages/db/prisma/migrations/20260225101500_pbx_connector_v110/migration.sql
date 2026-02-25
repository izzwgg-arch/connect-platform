-- CreateEnum
CREATE TYPE "PbxLinkStatus" AS ENUM ('LINKED', 'UNLINKED', 'ERROR');

-- CreateEnum
CREATE TYPE "PbxRouteType" AS ENUM ('MAIN_IVR', 'RING_GROUP', 'QUEUE', 'EXTENSION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PbxJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'FAILED', 'COMPLETED');

-- AlterTable
ALTER TABLE "PhoneNumber" ALTER COLUMN "provider" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProviderCredential" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extNumber" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxInstance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiAuthEncrypted" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantPbxLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pbxInstanceId" TEXT NOT NULL,
    "pbxTenantId" TEXT,
    "pbxDomain" TEXT,
    "status" "PbxLinkStatus" NOT NULL DEFAULT 'LINKED',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPbxLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxExtensionLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "pbxExtensionId" TEXT NOT NULL,
    "pbxSipUsername" TEXT NOT NULL,
    "pbxDeviceId" TEXT,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxExtensionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxDidLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "pbxDidId" TEXT NOT NULL,
    "routeType" "PbxRouteType" NOT NULL,
    "routeTarget" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxDidLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxCdrCursor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pbxInstanceId" TEXT NOT NULL,
    "lastSeenCdrId" TEXT,
    "lastSeenTimestamp" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxCdrCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "disposition" TEXT,
    "pbxCallId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pbxInstanceId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PbxJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Extension_tenantId_status_idx" ON "Extension"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Extension_tenantId_extNumber_key" ON "Extension"("tenantId", "extNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TenantPbxLink_tenantId_key" ON "TenantPbxLink"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PbxExtensionLink_extensionId_key" ON "PbxExtensionLink"("extensionId");

-- CreateIndex
CREATE INDEX "PbxExtensionLink_pbxExtensionId_idx" ON "PbxExtensionLink"("pbxExtensionId");

-- CreateIndex
CREATE UNIQUE INDEX "PbxExtensionLink_tenantId_extensionId_key" ON "PbxExtensionLink"("tenantId", "extensionId");

-- CreateIndex
CREATE INDEX "PbxDidLink_tenantId_pbxDidId_idx" ON "PbxDidLink"("tenantId", "pbxDidId");

-- CreateIndex
CREATE UNIQUE INDEX "PbxDidLink_tenantId_phoneNumberId_key" ON "PbxDidLink"("tenantId", "phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "PbxCdrCursor_tenantId_key" ON "PbxCdrCursor"("tenantId");

-- CreateIndex
CREATE INDEX "CallRecord_tenantId_startedAt_idx" ON "CallRecord"("tenantId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallRecord_tenantId_pbxCallId_key" ON "CallRecord"("tenantId", "pbxCallId");

-- CreateIndex
CREATE INDEX "PbxJob_status_nextRunAt_idx" ON "PbxJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "PbxJob_tenantId_createdAt_idx" ON "PbxJob"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantPbxLink" ADD CONSTRAINT "TenantPbxLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantPbxLink" ADD CONSTRAINT "TenantPbxLink_pbxInstanceId_fkey" FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxExtensionLink" ADD CONSTRAINT "PbxExtensionLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxExtensionLink" ADD CONSTRAINT "PbxExtensionLink_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxDidLink" ADD CONSTRAINT "PbxDidLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxDidLink" ADD CONSTRAINT "PbxDidLink_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxCdrCursor" ADD CONSTRAINT "PbxCdrCursor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxCdrCursor" ADD CONSTRAINT "PbxCdrCursor_pbxInstanceId_fkey" FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallRecord" ADD CONSTRAINT "CallRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxJob" ADD CONSTRAINT "PbxJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxJob" ADD CONSTRAINT "PbxJob_pbxInstanceId_fkey" FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

