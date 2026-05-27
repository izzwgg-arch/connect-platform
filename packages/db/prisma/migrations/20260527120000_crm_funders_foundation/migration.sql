-- CRM Funders Foundation: Funder, FunderTag, FunderTagAssignment, FunderImportBatch
-- Separate entity workspace for funding/referral/insurance/provider records.
-- All new tables; zero existing tables modified.

-- CreateEnum
CREATE TYPE "FunderStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PROSPECT', 'PENDING');

-- CreateTable
CREATE TABLE "Funder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "phone2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "notes" TEXT,
    "status" "FunderStatus" NOT NULL DEFAULT 'ACTIVE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Funder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunderTag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FunderTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunderTagAssignment" (
    "funderId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "FunderTagAssignment_pkey" PRIMARY KEY ("funderId","tagId")
);

-- CreateTable
CREATE TABLE "FunderImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FunderImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Funder_tenantId_active_idx" ON "Funder"("tenantId", "active");
CREATE INDEX "Funder_tenantId_status_idx" ON "Funder"("tenantId", "status");
CREATE INDEX "Funder_tenantId_createdAt_idx" ON "Funder"("tenantId", "createdAt");
CREATE INDEX "Funder_tenantId_name_idx" ON "Funder"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FunderTag_tenantId_name_key" ON "FunderTag"("tenantId", "name");
CREATE INDEX "FunderTag_tenantId_idx" ON "FunderTag"("tenantId");

-- CreateIndex
CREATE INDEX "FunderTagAssignment_tagId_idx" ON "FunderTagAssignment"("tagId");

-- CreateIndex
CREATE INDEX "FunderImportBatch_tenantId_createdAt_idx" ON "FunderImportBatch"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Funder" ADD CONSTRAINT "Funder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Funder" ADD CONSTRAINT "Funder_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderTag" ADD CONSTRAINT "FunderTag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderTagAssignment" ADD CONSTRAINT "FunderTagAssignment_funderId_fkey" FOREIGN KEY ("funderId") REFERENCES "Funder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FunderTagAssignment" ADD CONSTRAINT "FunderTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "FunderTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderImportBatch" ADD CONSTRAINT "FunderImportBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
