-- Sign-up payment.
--
-- Nothing is purchased on a customer's behalf until paidAt is set. Before this,
-- the VoIP.ms number was bought the moment someone left the number step, so an
-- abandoned sign-up left us holding a paid-for number.
--
-- All nullable: every existing submission carries on exactly as before.
ALTER TABLE "OnboardingSubmission" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "OnboardingSubmission" ADD COLUMN "paidInvoiceId" TEXT;
ALTER TABLE "OnboardingSubmission" ADD COLUMN "paidAmountCents" INTEGER;
