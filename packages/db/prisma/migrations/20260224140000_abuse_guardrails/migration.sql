-- Tenant guardrail fields
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Tenant' AND column_name = 'smsDailyCap'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Tenant' AND column_name = 'dailySmsCap'
  ) THEN
    ALTER TABLE "Tenant" RENAME COLUMN "smsDailyCap" TO "dailySmsCap";
  END IF;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "isApproved" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dailySmsCap" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "perSecondRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "firstCampaignRequiresApproval" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';

ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'NEEDS_APPROVAL';

ALTER TABLE "SmsCampaign"
  ADD COLUMN IF NOT EXISTS "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "holdReason" TEXT,
  ADD COLUMN IF NOT EXISTS "riskScore" INTEGER NOT NULL DEFAULT 0;
