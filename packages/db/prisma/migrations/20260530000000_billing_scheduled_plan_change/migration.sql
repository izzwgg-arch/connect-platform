-- Migration: billing_scheduled_plan_change
-- Adds scheduled plan change fields to TenantBillingSettings.
-- Safe: both columns are nullable with no existing-row impact.
-- The existing billingPlanId FK is unchanged; only relation names updated in Prisma schema.

ALTER TABLE "TenantBillingSettings"
  ADD COLUMN "nextBillingPlanId"          TEXT,
  ADD COLUMN "nextBillingPlanEffectiveAt" TIMESTAMP(3);

ALTER TABLE "TenantBillingSettings"
  ADD CONSTRAINT "TenantBillingSettings_nextBillingPlanId_fkey"
  FOREIGN KEY ("nextBillingPlanId")
  REFERENCES "BillingPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TenantBillingSettings_nextBillingPlanId_idx"
  ON "TenantBillingSettings"("nextBillingPlanId");
