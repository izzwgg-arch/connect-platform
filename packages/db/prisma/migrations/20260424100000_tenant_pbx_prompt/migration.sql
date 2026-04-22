-- CreateTable: TenantPbxPrompt
-- Connect-owned catalog of VitalPBX System Recordings, tenant-scoped.
-- See schema.prisma for the full design rationale. Additive migration: no
-- existing rows are touched; nothing in the IVR stack depends on this table
-- being populated (prompt dropdowns fall back to legacy free-text).
CREATE TABLE "TenantPbxPrompt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "promptRef" TEXT NOT NULL,
    "fileBaseName" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "source" TEXT NOT NULL DEFAULT 'pbx_sync',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPbxPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantPbxPrompt_promptRef_key" ON "TenantPbxPrompt"("promptRef");
CREATE INDEX "TenantPbxPrompt_tenantId_idx" ON "TenantPbxPrompt"("tenantId");
CREATE INDEX "TenantPbxPrompt_tenantSlug_idx" ON "TenantPbxPrompt"("tenantSlug");
CREATE INDEX "TenantPbxPrompt_tenantId_isActive_idx" ON "TenantPbxPrompt"("tenantId", "isActive");
CREATE INDEX "TenantPbxPrompt_isActive_idx" ON "TenantPbxPrompt"("isActive");

-- AddForeignKey
ALTER TABLE "TenantPbxPrompt" ADD CONSTRAINT "TenantPbxPrompt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
