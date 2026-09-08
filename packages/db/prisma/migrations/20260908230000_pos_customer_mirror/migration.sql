-- AlterTable
ALTER TABLE "PosCatalogSyncState" ADD COLUMN     "customerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customerLastError" TEXT,
ADD COLUMN     "customerLastMod" TEXT,
ADD COLUMN     "customerLastSyncAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PosCustomer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "posCustomerId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "phonesText" TEXT NOT NULL DEFAULT '',
    "primaryPhone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "route" TEXT NOT NULL DEFAULT '',
    "onAccount" BOOLEAN NOT NULL DEFAULT false,
    "cardCount" INTEGER NOT NULL DEFAULT 0,
    "posLastMod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosCustomer_tenantId_name_idx" ON "PosCustomer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PosCustomer_tenantId_primaryPhone_idx" ON "PosCustomer"("tenantId", "primaryPhone");

-- CreateIndex
CREATE UNIQUE INDEX "PosCustomer_tenantId_posCustomerId_key" ON "PosCustomer"("tenantId", "posCustomerId");

-- AddForeignKey
ALTER TABLE "PosCustomer" ADD CONSTRAINT "PosCustomer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

