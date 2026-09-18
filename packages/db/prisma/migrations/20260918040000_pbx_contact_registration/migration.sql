-- One row per PBX contact (per physical device), keyed by the device's own LAN IP
-- from x-ast-orig-host. Additive only.
CREATE TABLE "PbxContactRegistration" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "origIp" TEXT NOT NULL,
    "tenantId" TEXT,
    "extensionId" TEXT,
    "pbxTenantNumber" TEXT,
    "extNumber" TEXT,
    "isWebrtcDevice" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "contactUri" TEXT,
    "userAgent" TEXT,
    "lastRegisteredAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxContactRegistration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PbxContactRegistration_endpoint_origIp_key" ON "PbxContactRegistration"("endpoint", "origIp");
CREATE INDEX "PbxContactRegistration_pbxTenantNumber_isWebrtcDevice_idx" ON "PbxContactRegistration"("pbxTenantNumber", "isWebrtcDevice");
CREATE INDEX "PbxContactRegistration_tenantId_idx" ON "PbxContactRegistration"("tenantId");
CREATE INDEX "PbxContactRegistration_origIp_idx" ON "PbxContactRegistration"("origIp");
