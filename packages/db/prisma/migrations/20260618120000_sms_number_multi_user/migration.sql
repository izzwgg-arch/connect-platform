-- CreateTable: explicit multi-user assignment for VoIP.ms SMS numbers.
-- When rows exist for a TenantSmsNumber, inbound SMS threads fan out only
-- to those users instead of the whole tenant shared inbox.
CREATE TABLE "TenantSmsNumberUser" (
    "id" TEXT NOT NULL,
    "tenantSmsNumberId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSmsNumberUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantSmsNumberUser_tenantSmsNumberId_userId_key" ON "TenantSmsNumberUser"("tenantSmsNumberId", "userId");

-- CreateIndex
CREATE INDEX "TenantSmsNumberUser_tenantSmsNumberId_idx" ON "TenantSmsNumberUser"("tenantSmsNumberId");

-- CreateIndex
CREATE INDEX "TenantSmsNumberUser_userId_idx" ON "TenantSmsNumberUser"("userId");

-- AddForeignKey
ALTER TABLE "TenantSmsNumberUser" ADD CONSTRAINT "TenantSmsNumberUser_tenantSmsNumberId_fkey" FOREIGN KEY ("tenantSmsNumberId") REFERENCES "TenantSmsNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSmsNumberUser" ADD CONSTRAINT "TenantSmsNumberUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
