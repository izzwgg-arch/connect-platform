-- Phase 2 of Option A IVR control: per-digit option routing + per-profile prompt selection.
-- Additive only — existing `IvrRouteProfile` rows get safe defaults.

ALTER TABLE "IvrRouteProfile"
  ADD COLUMN "pbxPromptRef"        TEXT,
  ADD COLUMN "pbxInvalidPromptRef" TEXT,
  ADD COLUMN "pbxTimeoutPromptRef" TEXT,
  ADD COLUMN "timeoutSeconds"      INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN "maxRetries"          INTEGER NOT NULL DEFAULT 3;

CREATE TABLE "IvrOptionRoute" (
  "id"              TEXT        NOT NULL,
  "tenantId"        TEXT        NOT NULL,
  "profileId"       TEXT        NOT NULL,
  "optionDigit"     TEXT        NOT NULL,
  "destinationType" TEXT        NOT NULL,
  "destinationRef"  TEXT        NOT NULL,
  "label"           TEXT,
  "enabled"         BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "IvrOptionRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IvrOptionRoute_profileId_optionDigit_key"
  ON "IvrOptionRoute" ("profileId", "optionDigit");

CREATE INDEX "IvrOptionRoute_tenantId_idx" ON "IvrOptionRoute" ("tenantId");
CREATE INDEX "IvrOptionRoute_profileId_idx" ON "IvrOptionRoute" ("profileId");

ALTER TABLE "IvrOptionRoute"
  ADD CONSTRAINT "IvrOptionRoute_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IvrOptionRoute"
  ADD CONSTRAINT "IvrOptionRoute_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "IvrRouteProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
