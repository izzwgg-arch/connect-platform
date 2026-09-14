-- Additive only. Existing per-run records and PBX data are untouched.
CREATE TABLE "ManagedDeskPhone" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "macAddress" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "extensionId" TEXT NOT NULL REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "manufacturer" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "nickname" TEXT, "displayName" TEXT, "serialNumber" TEXT,
  "endpoint" TEXT NOT NULL,
  "configVersion" INTEGER NOT NULL DEFAULT 1,
  "options" JSONB NOT NULL DEFAULT '{}',
  "secretsEncrypted" TEXT NOT NULL,
  "rpsState" TEXT NOT NULL DEFAULT 'pending_credentials',
  "rpsDeviceId" TEXT, "rpsServerId" TEXT, "lastError" TEXT,
  "lastSeenAt" TIMESTAMP(3), "lastProvisionedAt" TIMESTAMP(3), "servedVersion" INTEGER,
  "sourceIp" TEXT, "userAgent" TEXT, "firmware" TEXT, "retiredAt" TIMESTAMP(3), "replacesId" TEXT,
  "createdBy" TEXT NOT NULL, "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManagedDeskPhone_mac_format" CHECK ("macAddress" ~ '^[0-9a-f]{12}$')
);
CREATE UNIQUE INDEX "ManagedDeskPhone_macAddress_key" ON "ManagedDeskPhone"("macAddress");
CREATE UNIQUE INDEX "ManagedDeskPhone_replacesId_key" ON "ManagedDeskPhone"("replacesId");
CREATE INDEX "ManagedDeskPhone_tenantId_retiredAt_idx" ON "ManagedDeskPhone"("tenantId", "retiredAt");
