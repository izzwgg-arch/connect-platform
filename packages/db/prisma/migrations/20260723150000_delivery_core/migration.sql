-- SUPERMARKET DELIVERY TRACKING — core domain (all phases).
-- Creates the 22 delivery-owned tables. tenantId/userId/storeId/driverId are plain
-- scalars WITHOUT cross-domain FKs (ConnectCdr precedent — Tenant/User untouched);
-- FKs exist only among delivery-owned models, mirroring the schema's @relation()s.
-- Statuses are TEXT (validated in apps/api/src/delivery/status.ts) — no new enums.

-- CreateTable
CREATE TABLE "DeliveryTenantSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mapReveal" TEXT NOT NULL DEFAULT 'PROGRESSIVE',
    "exactPinStopsAway" INTEGER NOT NULL DEFAULT 1,
    "verifyTier" TEXT NOT NULL DEFAULT 'TIERED',
    "voiceMode" TEXT NOT NULL DEFAULT 'PRERECORDED_NUMBER_PLAYBACK',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "notifyOutForDelivery" BOOLEAN NOT NULL DEFAULT true,
    "notifyDelayed" BOOLEAN NOT NULL DEFAULT true,
    "notifyDelivered" BOOLEAN NOT NULL DEFAULT true,
    "notifyApproaching" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryStore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "timezone" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "geojson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activeRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverStore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "rawSourceStatus" TEXT NOT NULL DEFAULT 'NEW',
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "contactId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "addrLine1" TEXT NOT NULL,
    "addrLine2" TEXT,
    "addrUnit" TEXT,
    "addrCity" TEXT,
    "addrRegion" TEXT,
    "addrPostal" TEXT,
    "instructions" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "geocodedAt" TIMESTAMP(3),
    "requestedWindowStart" TIMESTAMP(3),
    "requestedWindowEnd" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "signatureRequired" BOOLEAN NOT NULL DEFAULT false,
    "ageRestricted" BOOLEAN NOT NULL DEFAULT false,
    "cashOnDelivery" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT,
    "messagingConsent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryPackage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "label" TEXT,
    "tempSensitive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryOrderIdentifier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'LABEL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryOrderIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryStatusEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "driverId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRunStop" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryRunStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "runId" TEXT,
    "clientOpId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryOrderSourceEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryOrderSourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryUserAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'DISPATCHER',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryUserAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverTrackingSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverTrackingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverLocationSample" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "batteryPct" INTEGER,
    "mockSuspected" BOOLEAN NOT NULL DEFAULT false,
    "deviceTs" TIMESTAMP(3) NOT NULL,
    "serverTs" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverLocationSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtaSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "orderId" TEXT,
    "stopsAway" INTEGER NOT NULL,
    "etaMinSec" INTEGER NOT NULL,
    "etaMaxSec" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "calcAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TRACKING',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "otpHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'SMS',
    "toPhone" TEXT,
    "templateVersion" TEXT,
    "body" TEXT,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "errorReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverySmsConsent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" TIMESTAMP(3),
    "optedInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliverySmsConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofOfDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "methods" TEXT NOT NULL,
    "handover" TEXT,
    "recipientName" TEXT,
    "photoStorageKey" TEXT,
    "signatureStorageKey" TEXT,
    "gpsLat" DOUBLE PRECISION,
    "gpsLng" DOUBLE PRECISION,
    "gpsAccuracy" DOUBLE PRECISION,
    "overrideReason" TEXT,
    "capturedByDriverId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofOfDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryException" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "photoStorageKey" TEXT,
    "needsApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdByDriverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTenantSettings_tenantId_key" ON "DeliveryTenantSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryStore_tenantId_externalRef_key" ON "DeliveryStore"("tenantId", "externalRef");

-- CreateIndex
CREATE INDEX "DeliveryStore_tenantId_idx" ON "DeliveryStore"("tenantId");

-- CreateIndex
CREATE INDEX "DeliveryZone_tenantId_storeId_idx" ON "DeliveryZone"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_tenantId_userId_key" ON "DriverProfile"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "DriverProfile_tenantId_status_idx" ON "DriverProfile"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DriverStore_driverId_storeId_key" ON "DriverStore"("driverId", "storeId");

-- CreateIndex
CREATE INDEX "DriverStore_tenantId_storeId_idx" ON "DriverStore"("tenantId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOrder_tenantId_sourceId_key" ON "DeliveryOrder"("tenantId", "sourceId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_tenantId_status_idx" ON "DeliveryOrder"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DeliveryOrder_tenantId_storeId_idx" ON "DeliveryOrder"("tenantId", "storeId");

-- CreateIndex
CREATE INDEX "DeliveryPackage_orderId_idx" ON "DeliveryPackage"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOrderIdentifier_tenantId_tokenHash_key" ON "DeliveryOrderIdentifier"("tenantId", "tokenHash");

-- CreateIndex
CREATE INDEX "DeliveryOrderIdentifier_orderId_idx" ON "DeliveryOrderIdentifier"("orderId");

-- CreateIndex
CREATE INDEX "DeliveryStatusEvent_orderId_createdAt_idx" ON "DeliveryStatusEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryStatusEvent_tenantId_createdAt_idx" ON "DeliveryStatusEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryRun_tenantId_status_idx" ON "DeliveryRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DeliveryRun_tenantId_driverId_idx" ON "DeliveryRun"("tenantId", "driverId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRunStop_orderId_key" ON "DeliveryRunStop"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRunStop_runId_orderId_key" ON "DeliveryRunStop"("runId", "orderId");

-- CreateIndex
CREATE INDEX "DeliveryRunStop_runId_sequence_idx" ON "DeliveryRunStop"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAssignment_orderId_key" ON "DeliveryAssignment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAssignment_clientOpId_key" ON "DeliveryAssignment"("clientOpId");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_tenantId_driverId_idx" ON "DeliveryAssignment"("tenantId", "driverId");

-- CreateIndex
CREATE INDEX "DeliveryOrderSourceEvent_tenantId_status_idx" ON "DeliveryOrderSourceEvent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DeliveryOrderSourceEvent_tenantId_sourceId_idx" ON "DeliveryOrderSourceEvent"("tenantId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryUserAccess_tenantId_userId_key" ON "DeliveryUserAccess"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "DeliveryUserAccess_tenantId_enabled_idx" ON "DeliveryUserAccess"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "DriverTrackingSession_tenantId_driverId_endedAt_idx" ON "DriverTrackingSession"("tenantId", "driverId", "endedAt");

-- CreateIndex
CREATE INDEX "DriverTrackingSession_runId_idx" ON "DriverTrackingSession"("runId");

-- CreateIndex
CREATE INDEX "DriverLocationSample_sessionId_serverTs_idx" ON "DriverLocationSample"("sessionId", "serverTs");

-- CreateIndex
CREATE INDEX "DriverLocationSample_tenantId_serverTs_idx" ON "DriverLocationSample"("tenantId", "serverTs");

-- CreateIndex
CREATE INDEX "EtaSnapshot_runId_calcAt_idx" ON "EtaSnapshot"("runId", "calcAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingToken_tokenHash_key" ON "TrackingToken"("tokenHash");

-- CreateIndex
CREATE INDEX "TrackingToken_tenantId_orderId_idx" ON "TrackingToken"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNotification_idempotencyKey_key" ON "DeliveryNotification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DeliveryNotification_tenantId_orderId_idx" ON "DeliveryNotification"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "DeliveryNotification_tenantId_status_idx" ON "DeliveryNotification"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliverySmsConsent_tenantId_phoneE164_key" ON "DeliverySmsConsent"("tenantId", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "ProofOfDelivery_orderId_key" ON "ProofOfDelivery"("orderId");

-- CreateIndex
CREATE INDEX "ProofOfDelivery_tenantId_orderId_idx" ON "ProofOfDelivery"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "DeliveryException_tenantId_orderId_idx" ON "DeliveryException"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "DeliveryException_tenantId_reasonCode_idx" ON "DeliveryException"("tenantId", "reasonCode");

-- AddForeignKey
ALTER TABLE "DriverStore" ADD CONSTRAINT "DriverStore_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "DriverProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPackage" ADD CONSTRAINT "DeliveryPackage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOrderIdentifier" ADD CONSTRAINT "DeliveryOrderIdentifier_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStatusEvent" ADD CONSTRAINT "DeliveryStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRunStop" ADD CONSTRAINT "DeliveryRunStop_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DeliveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRunStop" ADD CONSTRAINT "DeliveryRunStop_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationSample" ADD CONSTRAINT "DriverLocationSample_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DriverTrackingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
