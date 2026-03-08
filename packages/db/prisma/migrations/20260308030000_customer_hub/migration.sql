-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "companyName" TEXT,
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "whatsappNumber" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "customerId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "customerPhone" TEXT;

-- AlterTable
ALTER TABLE "WhatsAppThread" ADD COLUMN "customerId" TEXT;

-- CreateIndex
CREATE INDEX "Customer_tenantId_displayName_idx" ON "Customer"("tenantId", "displayName");
CREATE INDEX "Customer_tenantId_primaryEmail_idx" ON "Customer"("tenantId", "primaryEmail");
CREATE INDEX "Customer_tenantId_primaryPhone_idx" ON "Customer"("tenantId", "primaryPhone");
CREATE INDEX "Customer_tenantId_whatsappNumber_idx" ON "Customer"("tenantId", "whatsappNumber");
CREATE INDEX "Invoice_tenantId_customerId_idx" ON "Invoice"("tenantId", "customerId");
CREATE INDEX "WhatsAppThread_tenantId_customerId_idx" ON "WhatsAppThread"("tenantId", "customerId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppThread" ADD CONSTRAINT "WhatsAppThread_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
