-- Desk phone setup: the person chooses WHICH phones to set up.
--
-- ⛔ PURELY ADDITIVE AND SAFE ON A LIVE TABLE: one nullable column, no default
-- needed. Every existing row reads NULL = "in the setup", which is exactly what
-- every run that exists today meant. An older api that does not know the column
-- is unaffected. Generated with `prisma migrate diff`, not hand-written.
ALTER TABLE "DeskPhoneSetupPhone" ADD COLUMN     "skippedAt" TIMESTAMP(3);
