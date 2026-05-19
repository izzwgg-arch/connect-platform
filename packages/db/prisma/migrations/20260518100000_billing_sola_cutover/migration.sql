-- Add token-linking and cutover fields to PaymentMethod
ALTER TABLE "PaymentMethod" ADD COLUMN "processorCustomerId" TEXT;
ALTER TABLE "PaymentMethod" ADD COLUMN "processorPaymentMethodId" TEXT;
ALTER TABLE "PaymentMethod" ADD COLUMN "isImported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PaymentMethod" ADD COLUMN "importedAt" TIMESTAMP(3);
ALTER TABLE "PaymentMethod" ADD COLUMN "metadata" JSONB;

-- Add cutover tracking fields to BillingSolaExternalScheduleLink
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "cutoverStatus" TEXT;
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "linkedPaymentMethodId" TEXT;
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "tokenLinkedAt" TIMESTAMP(3);
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "cutoverAt" TIMESTAMP(3);
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "cutoverByUserId" TEXT;
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "disabledSolaAt" TIMESTAMP(3);
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "disableAttemptedAt" TIMESTAMP(3);
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "disableError" TEXT;
ALTER TABLE "BillingSolaExternalScheduleLink" ADD COLUMN "connectAutopayEnabledAt" TIMESTAMP(3);

-- CreateIndex for cutoverStatus queries
CREATE INDEX "BillingSolaExternalScheduleLink_cutoverStatus_idx" ON "BillingSolaExternalScheduleLink"("cutoverStatus");

-- CreateIndex for linkedPaymentMethodId FK lookups
CREATE INDEX "BillingSolaExternalScheduleLink_linkedPaymentMethodId_idx" ON "BillingSolaExternalScheduleLink"("linkedPaymentMethodId");

-- AddForeignKey for linkedPaymentMethodId
ALTER TABLE "BillingSolaExternalScheduleLink" ADD CONSTRAINT "BillingSolaExternalScheduleLink_linkedPaymentMethodId_fkey"
  FOREIGN KEY ("linkedPaymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
