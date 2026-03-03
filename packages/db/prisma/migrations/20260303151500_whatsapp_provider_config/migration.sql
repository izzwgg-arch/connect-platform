-- CreateEnum
CREATE TYPE "WhatsAppProviderType" AS ENUM ('WHATSAPP_TWILIO', 'WHATSAPP_META');

-- CreateTable
CREATE TABLE "WhatsAppProviderConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "WhatsAppProviderType" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB,
    "credentialsEncrypted" TEXT NOT NULL,
    "credentialsKeyId" TEXT NOT NULL DEFAULT 'v1',
    "lastTestAt" TIMESTAMP(3),
    "lastTestResult" TEXT,
    "lastTestErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,

    CONSTRAINT "WhatsAppProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppProviderConfig_tenantId_provider_key" ON "WhatsAppProviderConfig"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "WhatsAppProviderConfig_tenantId_isEnabled_idx" ON "WhatsAppProviderConfig"("tenantId", "isEnabled");

-- AddForeignKey
ALTER TABLE "WhatsAppProviderConfig" ADD CONSTRAINT "WhatsAppProviderConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppProviderConfig" ADD CONSTRAINT "WhatsAppProviderConfig_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppProviderConfig" ADD CONSTRAINT "WhatsAppProviderConfig_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
