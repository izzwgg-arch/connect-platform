-- Phase 12B: Add priority field to CrmCampaign
-- Existing campaigns default to NORMAL so the Smart Queue treats them as before.

-- Add the enum type
DO $$ BEGIN
  CREATE TYPE "CrmCampaignPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add the column with NORMAL default; back-fill all existing rows
ALTER TABLE "CrmCampaign"
  ADD COLUMN IF NOT EXISTS "priority" "CrmCampaignPriority" NOT NULL DEFAULT 'NORMAL';
