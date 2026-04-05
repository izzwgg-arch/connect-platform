-- CreateTable
CREATE TABLE "PbxTenantDirectory" (
    "id" TEXT NOT NULL,
    "pbxInstanceId" TEXT NOT NULL,
    "vitalTenantId" TEXT NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "tenantCode" TEXT NOT NULL,
    "displayName" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxTenantDirectory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PbxTenantDirectory_pbxInstanceId_vitalTenantId_key" ON "PbxTenantDirectory"("pbxInstanceId", "vitalTenantId");

-- CreateIndex
CREATE INDEX "PbxTenantDirectory_pbxInstanceId_tenantCode_idx" ON "PbxTenantDirectory"("pbxInstanceId", "tenantCode");

-- CreateIndex
CREATE INDEX "PbxTenantDirectory_pbxInstanceId_tenantSlug_idx" ON "PbxTenantDirectory"("pbxInstanceId", "tenantSlug");

-- AddForeignKey
ALTER TABLE "PbxTenantDirectory" ADD CONSTRAINT "PbxTenantDirectory_pbxInstanceId_fkey" FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "TenantPbxLink" ADD COLUMN "pbxTenantCode" TEXT;

-- AlterTable
ALTER TABLE "ConnectCdr" ADD COLUMN "pbxVitalTenantId" TEXT;
ALTER TABLE "ConnectCdr" ADD COLUMN "pbxTenantCode" TEXT;
ALTER TABLE "ConnectCdr" ADD COLUMN "tenantResolutionSource" TEXT;
ALTER TABLE "ConnectCdr" ADD COLUMN "dcontextsSeen" JSONB;
