-- Cards on file for supermarket orders (Izzy, 2026-08-26): reps can save a
-- card through the tenant's OWN Sola iFields and charge it when the order
-- goes through. Token stored ENCRYPTED; the pan never exists server-side.
CREATE TABLE "SmCustomerCard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "posCustomerId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "last4" TEXT NOT NULL DEFAULT '',
    "exp" TEXT NOT NULL DEFAULT '',
    "cardholderName" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmCustomerCard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmCustomerCard_tenantId_posCustomerId_idx" ON "SmCustomerCard"("tenantId", "posCustomerId");

-- The charge result on the draft: CHARGED | DECLINED | UNKNOWN (Sola went
-- silent — may have landed). A decline never blocks the order.
ALTER TABLE "SupermarketOrderDraft" ADD COLUMN "paymentStatus" TEXT;
ALTER TABLE "SupermarketOrderDraft" ADD COLUMN "paymentRef" TEXT;
ALTER TABLE "SupermarketOrderDraft" ADD COLUMN "paymentLast4" TEXT;
ALTER TABLE "SupermarketOrderDraft" ADD COLUMN "paymentAmountCents" INTEGER;
