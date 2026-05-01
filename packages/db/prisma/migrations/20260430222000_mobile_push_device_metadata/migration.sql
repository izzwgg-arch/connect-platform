ALTER TABLE "MobileDevice"
  ADD COLUMN "extensionId" TEXT,
  ADD COLUMN "deviceId" TEXT,
  ADD COLUMN "appVersion" TEXT,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deactivatedAt" TIMESTAMP(3);

ALTER TABLE "MobileDevice"
  ADD CONSTRAINT "MobileDevice_extensionId_fkey"
  FOREIGN KEY ("extensionId") REFERENCES "Extension"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MobileDevice_tenantId_userId_active_idx"
  ON "MobileDevice"("tenantId", "userId", "active");

CREATE INDEX "MobileDevice_extensionId_idx"
  ON "MobileDevice"("extensionId");
