-- CallWakeEvent: append-only timeline of every step in the push-wake pipeline
-- (PBX dialplan -> backend wake -> FCM -> device wake -> SIP REGISTER -> INVITE
-- -> answer). Lets ops reconstruct exactly what happened for any pbxCallId, and
-- powers the Diagnostics screen "Wake Timeline" view.

CREATE TABLE "CallWakeEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pbxCallId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "extensionId" TEXT,
    "stage" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "details" JSONB,
    "latencyMs" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallWakeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallWakeEvent_tenantId_pbxCallId_occurredAt_idx" ON "CallWakeEvent"("tenantId", "pbxCallId", "occurredAt");
CREATE INDEX "CallWakeEvent_tenantId_occurredAt_idx" ON "CallWakeEvent"("tenantId", "occurredAt");
CREATE INDEX "CallWakeEvent_userId_occurredAt_idx" ON "CallWakeEvent"("userId", "occurredAt");
CREATE INDEX "CallWakeEvent_deviceId_occurredAt_idx" ON "CallWakeEvent"("deviceId", "occurredAt");
CREATE INDEX "CallWakeEvent_stage_occurredAt_idx" ON "CallWakeEvent"("stage", "occurredAt");

ALTER TABLE "CallWakeEvent" ADD CONSTRAINT "CallWakeEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallWakeEvent" ADD CONSTRAINT "CallWakeEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallWakeEvent" ADD CONSTRAINT "CallWakeEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MobileDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallWakeEvent" ADD CONSTRAINT "CallWakeEvent_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;
