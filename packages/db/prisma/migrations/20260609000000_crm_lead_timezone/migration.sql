-- CRM lead timezone fields (city/state → IANA, label, resolution status)

CREATE TYPE "CrmLeadTimezoneResolutionStatus" AS ENUM ('RESOLVED', 'NEEDS_REVIEW', 'MISSING_LOCATION');

ALTER TABLE "CrmContactMeta"
  ADD COLUMN "timezoneIana" TEXT,
  ADD COLUMN "timezoneLabel" TEXT,
  ADD COLUMN "timezoneOffsetMinutes" INTEGER,
  ADD COLUMN "timezoneResolvedAt" TIMESTAMP(3),
  ADD COLUMN "timezoneResolutionStatus" "CrmLeadTimezoneResolutionStatus";

CREATE INDEX "CrmContactMeta_tenantId_timezoneLabel_idx" ON "CrmContactMeta"("tenantId", "timezoneLabel");
CREATE INDEX "CrmContactMeta_tenantId_timezoneIana_idx" ON "CrmContactMeta"("tenantId", "timezoneIana");
CREATE INDEX "CrmContactMeta_tenantId_timezoneResolutionStatus_idx" ON "CrmContactMeta"("tenantId", "timezoneResolutionStatus");
