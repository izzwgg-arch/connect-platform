-- CreateEnum
CREATE TYPE "SolaConfigMode" AS ENUM ('SANDBOX', 'PROD');

-- CreateEnum
CREATE TYPE "SolaAuthMode" AS ENUM ('XKEY_BODY', 'AUTHORIZATION_HEADER');

-- CreateTable
CREATE TABLE "BillingSolaConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "apiBaseUrl" TEXT NOT NULL,
    "mode" "SolaConfigMode" NOT NULL DEFAULT 'SANDBOX',
    "simulate" BOOLEAN NOT NULL DEFAULT false,
    "authMode" "SolaAuthMode" NOT NULL DEFAULT 'XKEY_BODY',
    "authHeaderName" TEXT,
    "pathOverrides" JSONB,
    "credentialsEncrypted" TEXT NOT NULL,
    "credentialsKeyId" TEXT NOT NULL DEFAULT 'v1',
    "lastTestAt" TIMESTAMP(3),
    "lastTestResult" TEXT,
    "lastTestErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,

    CONSTRAINT "BillingSolaConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingSolaConfig_tenantId_key" ON "BillingSolaConfig"("tenantId");

-- CreateIndex
CREATE INDEX "BillingSolaConfig_isEnabled_updatedAt_idx" ON "BillingSolaConfig"("isEnabled", "updatedAt");

-- AddForeignKey
ALTER TABLE "BillingSolaConfig" ADD CONSTRAINT "BillingSolaConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSolaConfig" ADD CONSTRAINT "BillingSolaConfig_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSolaConfig" ADD CONSTRAINT "BillingSolaConfig_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
