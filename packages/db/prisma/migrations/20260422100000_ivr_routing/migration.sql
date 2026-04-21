-- IVR Routing Option A: IvrRouteProfile, IvrScheduleConfig, IvrOverrideState, IvrPublishRecord

CREATE TABLE "IvrRouteProfile" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "type"           TEXT NOT NULL,
    "pbxDestination" TEXT NOT NULL,
    "isActive"       BOOLEAN NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "createdBy"      TEXT,

    CONSTRAINT "IvrRouteProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IvrScheduleConfig" (
    "id"                  TEXT NOT NULL,
    "tenantId"            TEXT NOT NULL,
    "timezone"            TEXT NOT NULL DEFAULT 'America/New_York',
    "businessHoursRules"  JSONB NOT NULL DEFAULT '[]',
    "holidayDates"        JSONB NOT NULL DEFAULT '[]',
    "defaultProfileId"    TEXT,
    "afterHoursProfileId" TEXT,
    "holidayProfileId"    TEXT,
    "isActive"            BOOLEAN NOT NULL DEFAULT true,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IvrScheduleConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IvrOverrideState" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL,
    "isActive"      BOOLEAN NOT NULL DEFAULT false,
    "profileId"     TEXT,
    "reason"        TEXT,
    "expiresAt"     TIMESTAMP(3),
    "activatedAt"   TIMESTAMP(3),
    "activatedBy"   TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedBy" TEXT,

    CONSTRAINT "IvrOverrideState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IvrPublishRecord" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "publishedBy"  TEXT NOT NULL,
    "publishedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode"         TEXT NOT NULL,
    "keysWritten"  JSONB NOT NULL,
    "previousKeys" JSONB NOT NULL DEFAULT '[]',
    "status"       TEXT NOT NULL DEFAULT 'pending',
    "error"        TEXT,
    "isRollback"   BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "IvrPublishRecord_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "IvrScheduleConfig_tenantId_key"  ON "IvrScheduleConfig"("tenantId");
CREATE UNIQUE INDEX "IvrOverrideState_tenantId_key"   ON "IvrOverrideState"("tenantId");

-- Indexes
CREATE INDEX "IvrRouteProfile_tenantId_idx"          ON "IvrRouteProfile"("tenantId");
CREATE INDEX "IvrRouteProfile_tenantId_type_idx"     ON "IvrRouteProfile"("tenantId", "type");
CREATE INDEX "IvrRouteProfile_tenantId_isActive_idx" ON "IvrRouteProfile"("tenantId", "isActive");
CREATE INDEX "IvrPublishRecord_tenantId_idx"         ON "IvrPublishRecord"("tenantId");
CREATE INDEX "IvrPublishRecord_tenantId_publishedAt_idx" ON "IvrPublishRecord"("tenantId", "publishedAt");
CREATE INDEX "IvrPublishRecord_status_idx"           ON "IvrPublishRecord"("status");

-- Foreign keys
ALTER TABLE "IvrRouteProfile"
    ADD CONSTRAINT "IvrRouteProfile_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IvrScheduleConfig"
    ADD CONSTRAINT "IvrScheduleConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IvrScheduleConfig"
    ADD CONSTRAINT "IvrScheduleConfig_defaultProfileId_fkey"
    FOREIGN KEY ("defaultProfileId") REFERENCES "IvrRouteProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IvrScheduleConfig"
    ADD CONSTRAINT "IvrScheduleConfig_afterHoursProfileId_fkey"
    FOREIGN KEY ("afterHoursProfileId") REFERENCES "IvrRouteProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IvrScheduleConfig"
    ADD CONSTRAINT "IvrScheduleConfig_holidayProfileId_fkey"
    FOREIGN KEY ("holidayProfileId") REFERENCES "IvrRouteProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IvrOverrideState"
    ADD CONSTRAINT "IvrOverrideState_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IvrOverrideState"
    ADD CONSTRAINT "IvrOverrideState_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "IvrRouteProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IvrPublishRecord"
    ADD CONSTRAINT "IvrPublishRecord_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
