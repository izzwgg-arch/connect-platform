-- AlterTable
ALTER TABLE "RemoteSupportSession" ADD COLUMN     "clientAuthenticated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'support',
ADD COLUMN     "machineId" TEXT,
ADD COLUMN     "shareId" TEXT;

-- CreateTable
CREATE TABLE "RemoteDesktopMachine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "connectId" TEXT NOT NULL,
    "machineKeyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "osLabel" TEXT,
    "monitors" INTEGER NOT NULL DEFAULT 1,
    "appVersion" TEXT,
    "unattendedEnabled" BOOLEAN NOT NULL DEFAULT false,
    "hasAccessLogin" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "shareFailCount" INTEGER NOT NULL DEFAULT 0,
    "shareLockedUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteDesktopMachine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteDesktopShare" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'company',
    "oneTime" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "allowControl" BOOLEAN NOT NULL DEFAULT true,
    "allowSound" BOOLEAN NOT NULL DEFAULT true,
    "allowMic" BOOLEAN NOT NULL DEFAULT false,
    "allowClipboard" BOOLEAN NOT NULL DEFAULT false,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteDesktopShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemoteDesktopMachine_deviceId_key" ON "RemoteDesktopMachine"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "RemoteDesktopMachine_connectId_key" ON "RemoteDesktopMachine"("connectId");

-- CreateIndex
CREATE INDEX "RemoteDesktopMachine_tenantId_ownerUserId_idx" ON "RemoteDesktopMachine"("tenantId", "ownerUserId");

-- CreateIndex
CREATE INDEX "RemoteDesktopMachine_ownerUserId_revokedAt_idx" ON "RemoteDesktopMachine"("ownerUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "RemoteDesktopShare_machineId_revokedAt_idx" ON "RemoteDesktopShare"("machineId", "revokedAt");

-- CreateIndex
CREATE INDEX "RemoteDesktopShare_tenantId_idx" ON "RemoteDesktopShare"("tenantId");

-- CreateIndex
CREATE INDEX "RemoteSupportSession_machineId_status_idx" ON "RemoteSupportSession"("machineId", "status");

-- AddForeignKey
ALTER TABLE "RemoteDesktopMachine" ADD CONSTRAINT "RemoteDesktopMachine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteDesktopShare" ADD CONSTRAINT "RemoteDesktopShare_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "RemoteDesktopMachine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

