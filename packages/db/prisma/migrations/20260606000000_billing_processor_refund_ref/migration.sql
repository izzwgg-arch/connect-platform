-- Add processorRefundRef to PaymentTransaction
-- Stores the processor-issued xRefNum for refund transactions (cc:refund / cc:credit).
-- Used for idempotent reconciliation of manual Sola/Cardknox portal refunds.

ALTER TABLE "PaymentTransaction" ADD COLUMN "processorRefundRef" TEXT;

CREATE INDEX "PaymentTransaction_processor_processorRefundRef_idx"
  ON "PaymentTransaction"("processor", "processorRefundRef");
