-- Migration: sola_cutover_next_charge_at
--
-- Adds nextConnectChargeAt to BillingSolaExternalScheduleLink so the worker
-- can block charging until the first Connect billing period AFTER Sola's
-- already-paid current period.
--
-- Also adds sourceSolaNextChargeDate to record what Sola said the next charge
-- date was at the time of cutover (for forensics and UI display).
--
-- Both columns are nullable; absence means "unknown / not yet computed".

ALTER TABLE "BillingSolaExternalScheduleLink"
  ADD COLUMN "nextConnectChargeAt" TIMESTAMP(3),
  ADD COLUMN "sourceSolaNextChargeDate" TIMESTAMP(3);
