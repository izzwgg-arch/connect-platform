-- MOH Scheduling Option A: MohProfile, MohScheduleConfig, MohScheduleRule, MohOverrideState, MohPublishRecord

CREATE TABLE "MohProfile" (
    "id"                   TEXT NOT NULL,
    "tenantId"             TEXT NOT NULL,
    "name"                 TEXT NOT NULL,
    "type"                 TEXT NOT NULL,
    "vitalPbxMohClassName" TEXT NOT NULL,
    "isActive"             BOOLEAN NOT NULL DEFAULT true,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    "createdBy"            TEXT,
    "updatedBy"            TEXT,

    CONSTRAINT "MohProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MohScheduleConfig" (
    "id"                  TEXT NOT NULL,
    "tenantId"            TEXT NOT NULL,
    "timezone"            TEXT NOT NULL DEFAULT 'America/New_York',
    "defaultProfileId"    TEXT,
    "afterHoursProfileId" TEXT,
    "holidayProfileId"    TEXT,
    "isActive"            BOOLEAN NOT NULL DEFAULT true,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MohScheduleConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MohScheduleRule" (
    "id"         TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "profileId"  TEXT NOT NULL,
    "ruleType"   TEXT NOT NULL,
    "weekday"    INTEGER,
    "startTime"  TEXT,
    "endTime"    TEXT,
    "startAt"    TIMESTAMP(3),
    "endAt"      TIMESTAMP(3),
    "priority"   INTEGER NOT NULL DEFAULT 0,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MohScheduleRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MohOverrideState" (
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

    CONSTRAINT "MohOverrideState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MohPublishRecord" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "publishedBy"      TEXT NOT NULL,
    "publishedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source"           TEXT NOT NULL,
    "previousMohClass" TEXT,
    "newMohClass"      TEXT NOT NULL,
    "keysWritten"      JSONB NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "error"            TEXT,
    "isRollback"       BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MohPublishRecord_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "MohScheduleConfig_tenantId_key" ON "MohScheduleConfig"("tenantId");
CREATE UNIQUE INDEX "MohOverrideState_tenantId_key"  ON "MohOverrideState"("tenantId");

-- Indexes
CREATE INDEX "MohProfile_tenantId_idx"           ON "MohProfile"("tenantId");
CREATE INDEX "MohProfile_tenantId_type_idx"      ON "MohProfile"("tenantId", "type");
CREATE INDEX "MohProfile_tenantId_isActive_idx"  ON "MohProfile"("tenantId", "isActive");
CREATE INDEX "MohScheduleRule_scheduleId_idx"    ON "MohScheduleRule"("scheduleId");
CREATE INDEX "MohScheduleRule_scheduleId_active_idx" ON "MohScheduleRule"("scheduleId", "isActive");
CREATE INDEX "MohScheduleRule_ruleType_idx"      ON "MohScheduleRule"("ruleType");
CREATE INDEX "MohPublishRecord_tenantId_idx"     ON "MohPublishRecord"("tenantId");
CREATE INDEX "MohPublishRecord_tenantId_publishedAt_idx" ON "MohPublishRecord"("tenantId", "publishedAt");
CREATE INDEX "MohPublishRecord_status_idx"       ON "MohPublishRecord"("status");

-- Foreign keys
ALTER TABLE "MohProfile"
    ADD CONSTRAINT "MohProfile_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohScheduleConfig"
    ADD CONSTRAINT "MohScheduleConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohScheduleConfig"
    ADD CONSTRAINT "MohScheduleConfig_defaultProfileId_fkey"
    FOREIGN KEY ("defaultProfileId") REFERENCES "MohProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MohScheduleConfig"
    ADD CONSTRAINT "MohScheduleConfig_afterHoursProfileId_fkey"
    FOREIGN KEY ("afterHoursProfileId") REFERENCES "MohProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MohScheduleConfig"
    ADD CONSTRAINT "MohScheduleConfig_holidayProfileId_fkey"
    FOREIGN KEY ("holidayProfileId") REFERENCES "MohProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MohScheduleRule"
    ADD CONSTRAINT "MohScheduleRule_scheduleId_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "MohScheduleConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohScheduleRule"
    ADD CONSTRAINT "MohScheduleRule_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MohProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohOverrideState"
    ADD CONSTRAINT "MohOverrideState_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MohOverrideState"
    ADD CONSTRAINT "MohOverrideState_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MohProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MohPublishRecord"
    ADD CONSTRAINT "MohPublishRecord_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
