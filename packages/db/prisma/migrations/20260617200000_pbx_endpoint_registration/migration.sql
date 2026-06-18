-- CreateTable
CREATE TABLE "PbxEndpointRegistration" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "tenantId" TEXT,
    "extensionId" TEXT,
    "pbxTenantNumber" TEXT,
    "extNumber" TEXT,
    "isWebrtcDevice" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "rawStatus" TEXT,
    "contactUri" TEXT,
    "userAgent" TEXT,
    "roundtripUsec" TEXT,
    "lastRegisteredAt" TIMESTAMP(3),
    "lastUnreachableAt" TIMESTAMP(3),
    "lastUnregisteredAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxEndpointRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PbxEndpointRegistrationEvent" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "tenantId" TEXT,
    "extensionId" TEXT,
    "status" TEXT NOT NULL,
    "rawStatus" TEXT,
    "contactUri" TEXT,
    "userAgent" TEXT,
    "details" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxEndpointRegistrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PbxEndpointRegistration_endpoint_key" ON "PbxEndpointRegistration"("endpoint");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistration_status_idx" ON "PbxEndpointRegistration"("status");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistration_tenantId_status_idx" ON "PbxEndpointRegistration"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistration_extensionId_idx" ON "PbxEndpointRegistration"("extensionId");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistration_lastEventAt_idx" ON "PbxEndpointRegistration"("lastEventAt");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistrationEvent_endpoint_occurredAt_idx" ON "PbxEndpointRegistrationEvent"("endpoint", "occurredAt");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistrationEvent_tenantId_occurredAt_idx" ON "PbxEndpointRegistrationEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "PbxEndpointRegistrationEvent_occurredAt_idx" ON "PbxEndpointRegistrationEvent"("occurredAt");
