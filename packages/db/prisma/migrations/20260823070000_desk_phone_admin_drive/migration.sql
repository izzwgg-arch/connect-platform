-- Admin-driven desk phone setup runs.
--
-- ⛔ PURELY ADDITIVE AND SAFE ON A LIVE TABLE: every column is nullable or has a
-- default, so existing rows keep working unchanged and an older api that does not
-- know these columns is unaffected. The default 'self' means every run that
-- exists today is, correctly, a run the office drove itself.
ALTER TABLE "DeskPhoneSetupRun"
  ADD COLUMN "driveMode" TEXT NOT NULL DEFAULT 'self',
  ADD COLUMN "officeConsentAt" TIMESTAMP(3),
  ADD COLUMN "officeConsentByUserId" TEXT,
  ADD COLUMN "officeAgentLabel" TEXT,
  ADD COLUMN "officeAgentSeenAt" TIMESTAMP(3);
