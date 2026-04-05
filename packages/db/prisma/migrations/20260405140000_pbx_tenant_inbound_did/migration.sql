-- CreateTable
CREATE TABLE "PbxTenantInboundDid" (
    "id" TEXT NOT NULL,
    "pbxInstanceId" TEXT NOT NULL,
    "vitalTenantId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "pbxInboundId" TEXT,
    "rawNumber" TEXT,
    "pbxTenantSlug" TEXT,
    "pbxTenantCode" TEXT,
    "connectTenantId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxTenantInboundDid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PbxTenantInboundDid_pbxInstanceId_e164_key" ON "PbxTenantInboundDid"("pbxInstanceId", "e164");

-- CreateIndex
CREATE INDEX "PbxTenantInboundDid_pbxInstanceId_vitalTenantId_idx" ON "PbxTenantInboundDid"("pbxInstanceId", "vitalTenantId");

-- CreateIndex
CREATE INDEX "PbxTenantInboundDid_e164_idx" ON "PbxTenantInboundDid"("e164");

-- CreateIndex
CREATE INDEX "PbxTenantInboundDid_connectTenantId_idx" ON "PbxTenantInboundDid"("connectTenantId");

-- CreateIndex
CREATE INDEX "PbxTenantInboundDid_pbxInstanceId_active_idx" ON "PbxTenantInboundDid"("pbxInstanceId", "active");

-- AddForeignKey
ALTER TABLE "PbxTenantInboundDid" ADD CONSTRAINT "PbxTenantInboundDid_pbxInstanceId_fkey" FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
