-- v1.3.1 mobile push token registration and incoming call invites
CREATE TYPE "MobilePlatform" AS ENUM ('IOS', 'ANDROID');
CREATE TYPE "CallInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

CREATE TABLE "MobileDevice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "platform" "MobilePlatform" NOT NULL,
  "expoPushToken" TEXT NOT NULL,
  "voipPushToken" TEXT,
  "deviceName" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MobileDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MobileDevice_expoPushToken_key" ON "MobileDevice"("expoPushToken");
CREATE INDEX "MobileDevice_tenantId_userId_idx" ON "MobileDevice"("tenantId", "userId");
CREATE INDEX "MobileDevice_tenantId_platform_idx" ON "MobileDevice"("tenantId", "platform");

ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CallInvite" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "extensionId" TEXT,
  "fromNumber" TEXT NOT NULL,
  "toExtension" TEXT NOT NULL,
  "status" "CallInviteStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "declinedAt" TIMESTAMP(3),
  CONSTRAINT "CallInvite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallInvite_tenantId_createdAt_idx" ON "CallInvite"("tenantId", "createdAt");
CREATE INDEX "CallInvite_userId_status_expiresAt_idx" ON "CallInvite"("userId", "status", "expiresAt");

ALTER TABLE "CallInvite" ADD CONSTRAINT "CallInvite_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallInvite" ADD CONSTRAINT "CallInvite_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallInvite" ADD CONSTRAINT "CallInvite_extensionId_fkey"
  FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;
