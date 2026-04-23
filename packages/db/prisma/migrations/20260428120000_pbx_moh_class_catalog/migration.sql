-- CreateTable
CREATE TABLE "PbxMohClass" (
    "id" TEXT NOT NULL,
    "pbxInstanceId" TEXT NOT NULL,
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "pbxGroupId" INTEGER NOT NULL,
    "pbxTenantId" TEXT,
    "name" TEXT NOT NULL,
    "mohClassName" TEXT NOT NULL,
    "classType" TEXT,
    "streamingUrl" TEXT,
    "streamingFormat" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxMohClass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PbxMohClass_pbxInstanceId_pbxGroupId_key" ON "PbxMohClass"("pbxInstanceId", "pbxGroupId");

-- CreateIndex
CREATE INDEX "PbxMohClass_tenantId_idx" ON "PbxMohClass"("tenantId");

-- CreateIndex
CREATE INDEX "PbxMohClass_tenantId_isActive_idx" ON "PbxMohClass"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "PbxMohClass_pbxInstanceId_isActive_idx" ON "PbxMohClass"("pbxInstanceId", "isActive");

-- AddForeignKey
ALTER TABLE "PbxMohClass" ADD CONSTRAINT "PbxMohClass_pbxInstanceId_fkey" FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PbxMohClass" ADD CONSTRAINT "PbxMohClass_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
