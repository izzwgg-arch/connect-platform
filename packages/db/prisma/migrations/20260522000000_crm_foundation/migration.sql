-- CRM Foundation: CrmTenantSettings, CrmUserAccess, CrmUserRole enum
-- Phase 1A: settings + user access only. No contact/lead/campaign models yet.
-- All new tables; zero existing tables modified.

-- CreateEnum
CREATE TYPE "CrmUserRole" AS ENUM ('AGENT', 'MANAGER', 'ADMIN');

-- CreateTable
CREATE TABLE "CrmTenantSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "localPresenceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "transcriptionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmTenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmUserAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "role" "CrmUserRole" NOT NULL DEFAULT 'AGENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmUserAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmTenantSettings_tenantId_key" ON "CrmTenantSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmUserAccess_tenantId_userId_key" ON "CrmUserAccess"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "CrmUserAccess_tenantId_enabled_idx" ON "CrmUserAccess"("tenantId", "enabled");

-- AddForeignKey
ALTER TABLE "CrmTenantSettings" ADD CONSTRAINT "CrmTenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmUserAccess" ADD CONSTRAINT "CrmUserAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmUserAccess" ADD CONSTRAINT "CrmUserAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
