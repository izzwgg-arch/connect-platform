-- Desk phone setup: device identification + maker-cloud state.
--
-- ⛔ PURELY ADDITIVE AND SAFE ON A LIVE TABLE: six nullable columns and one index.
-- Every existing row reads NULL, which every screen treats as "not identified yet /
-- cloud not checked". An older api that does not know the columns is unaffected.
ALTER TABLE "DeskPhoneSetupPhone" ADD COLUMN     "deviceType" TEXT,
ADD COLUMN     "identityConfidence" TEXT,
ADD COLUMN     "identityEvidence" JSONB,
ADD COLUMN     "serialNumber" TEXT,
ADD COLUMN     "vendorCloudCheckedAt" TIMESTAMP(3),
ADD COLUMN     "vendorCloudState" TEXT;

-- CreateIndex
CREATE INDEX "DeskPhoneSetupPhone_macAddress_idx" ON "DeskPhoneSetupPhone"("macAddress");
