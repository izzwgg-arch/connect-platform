-- Durable server-side operation lock for live billing charges.
CREATE TYPE "BillingChargeOperationStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'ERROR');

CREATE TABLE "BillingChargeOperation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "businessKey" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "chargeType" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "BillingChargeOperationStatus" NOT NULL DEFAULT 'PENDING',
  "invoiceId" TEXT,
  "paymentMethodId" TEXT,
  "paymentTransactionId" TEXT,
  "customerKey" TEXT,
  "clientOperationId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingChargeOperation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PaymentTransaction"
  ADD COLUMN "billingChargeOperationId" TEXT;

CREATE UNIQUE INDEX "BillingChargeOperation_businessKey_key"
  ON "BillingChargeOperation"("businessKey");

CREATE UNIQUE INDEX "BillingChargeOperation_paymentTransactionId_key"
  ON "BillingChargeOperation"("paymentTransactionId");

CREATE INDEX "BillingChargeOperation_tenantId_createdAt_idx"
  ON "BillingChargeOperation"("tenantId", "createdAt");

CREATE INDEX "BillingChargeOperation_invoiceId_idx"
  ON "BillingChargeOperation"("invoiceId");

CREATE INDEX "BillingChargeOperation_status_updatedAt_idx"
  ON "BillingChargeOperation"("status", "updatedAt");

CREATE INDEX "PaymentTransaction_billingChargeOperationId_idx"
  ON "PaymentTransaction"("billingChargeOperationId");

CREATE UNIQUE INDEX "PaymentTransaction_processor_processorTransactionId_key"
  ON "PaymentTransaction"("processor", "processorTransactionId");

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_billingChargeOperationId_fkey"
  FOREIGN KEY ("billingChargeOperationId") REFERENCES "BillingChargeOperation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
