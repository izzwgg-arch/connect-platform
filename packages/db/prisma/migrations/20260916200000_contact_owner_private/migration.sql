-- Contacts are private to the person who saved them (2026-09-16).
-- Relax Tires ext 101's 4,250 phone-book contacts were visible to ext 102 and 103
-- because GET /contacts returned every contact in the company.
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT;
CREATE INDEX IF NOT EXISTS "Contact_tenantId_ownerUserId_idx" ON "Contact"("tenantId", "ownerUserId");

-- Backfill: every existing contact someone saved becomes private to them.
-- CRM contacts (CrmContactMeta) stay SHARED — CRM has its own per-user access rules.
-- Contacts with no creator (seed/demo) stay SHARED.
UPDATE "Contact" c
SET "ownerUserId" = c."createdBy"
WHERE c."createdBy" IS NOT NULL
  AND c."ownerUserId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "CrmContactMeta" m WHERE m."contactId" = c.id);
