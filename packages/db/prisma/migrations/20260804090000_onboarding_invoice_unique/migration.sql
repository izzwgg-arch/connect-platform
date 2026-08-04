-- One first-month invoice per sign-up, enforced by the database.
-- prepareOnboardingCheckout used findFirst→create with no constraint; a slow
-- prepare plus a client retry could create two invoices for one submission —
-- a double charge once both pay links were live.
ALTER TABLE "BillingInvoice" ADD COLUMN "onboardingSubmissionId" TEXT;

-- Backfill from metadata. If duplicates already exist for a submission, stamp
-- only the canonical one (a PAID invoice wins, then the oldest) — the extras
-- keep NULL and stop matching checkout lookups.
UPDATE "BillingInvoice" b
SET "onboardingSubmissionId" = b.metadata->>'onboardingSubmissionId'
WHERE b.metadata->>'onboardingSubmissionId' IS NOT NULL
  AND b.id = (
    SELECT b2.id FROM "BillingInvoice" b2
    WHERE b2.metadata->>'onboardingSubmissionId' = b.metadata->>'onboardingSubmissionId'
    ORDER BY (b2.status = 'PAID') DESC, b2."createdAt" ASC
    LIMIT 1
  );

CREATE UNIQUE INDEX "BillingInvoice_onboardingSubmissionId_key" ON "BillingInvoice"("onboardingSubmissionId");
