-- Importable lead fields surfaced on the CRM contact overlay:
-- external/business ID, social security number, and monthly revenue.
-- All nullable text; no backfill needed for existing rows.
ALTER TABLE "CrmContactMeta"
ADD COLUMN "externalId" TEXT,
ADD COLUMN "ssn" TEXT,
ADD COLUMN "monthlyRevenue" TEXT;
