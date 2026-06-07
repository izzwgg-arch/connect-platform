-- Add tenant-scoped CRM workspace defaults for script and checklist selection.
ALTER TABLE "CrmTenantSettings"
  ADD COLUMN "defaultScriptId" TEXT,
  ADD COLUMN "defaultChecklistId" TEXT;
