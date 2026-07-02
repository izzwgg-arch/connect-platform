-- Connect MOH final system: control mode (Connect-managed vs PBX-controlled)
-- for tenants + extensions, admin multi-tenant schedules, and live-verify
-- columns. Fully ADDITIVE: every new column is nullable or defaulted, and all
-- new tables are independent, so existing rows and the live per-tenant MOH
-- path are unaffected. NOTHING is dropped or back-filled destructively.

-- ── Tenant control mode ──────────────────────────────────────────────────────
-- Existing tenants default to "connect" (current behavior). Flip to "pbx" to
-- hand a tenant's MOH back to native VitalPBX.
ALTER TABLE "Tenant" ADD COLUMN "mohControlMode" TEXT NOT NULL DEFAULT 'connect';

-- ── Publish-record live verification + control mode ──────────────────────────
ALTER TABLE "MohPublishRecord" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "MohPublishRecord" ADD COLUMN "verifiedActiveClass" TEXT;
ALTER TABLE "MohPublishRecord" ADD COLUMN "verifyStatus" TEXT;
ALTER TABLE "MohPublishRecord" ADD COLUMN "controlMode" TEXT;

-- ── Last-published-state live verification + control mode ────────────────────
ALTER TABLE "MohLastPublishedState" ADD COLUMN "controlMode" TEXT;
ALTER TABLE "MohLastPublishedState" ADD COLUMN "activeClassObserved" TEXT;
ALTER TABLE "MohLastPublishedState" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- ── Per-extension control mode ───────────────────────────────────────────────
CREATE TABLE "MohExtensionControl" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "controlMode" TEXT NOT NULL DEFAULT 'inherit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    CONSTRAINT "MohExtensionControl_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MohExtensionControl_tenantId_extension_key" ON "MohExtensionControl"("tenantId", "extension");
CREATE INDEX "MohExtensionControl_tenantId_idx" ON "MohExtensionControl"("tenantId");
ALTER TABLE "MohExtensionControl" ADD CONSTRAINT "MohExtensionControl_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Admin (multi-tenant) schedule ────────────────────────────────────────────
CREATE TABLE "MohAdminSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleKind" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "vitalPbxMohClassName" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "startWeekday" INTEGER,
    "startTime" TEXT,
    "endWeekday" INTEGER,
    "endTime" TEXT,
    "fallbackMode" TEXT NOT NULL DEFAULT 'restore_previous',
    "fallbackClass" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    CONSTRAINT "MohAdminSchedule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MohAdminSchedule_enabled_idx" ON "MohAdminSchedule"("enabled");
CREATE INDEX "MohAdminSchedule_isDeleted_idx" ON "MohAdminSchedule"("isDeleted");

-- ── Admin schedule targets (tenant, optional extension) ──────────────────────
CREATE TABLE "MohAdminScheduleTarget" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extension" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MohAdminScheduleTarget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MohAdminScheduleTarget_scheduleId_tenantId_extension_key" ON "MohAdminScheduleTarget"("scheduleId", "tenantId", "extension");
CREATE INDEX "MohAdminScheduleTarget_tenantId_idx" ON "MohAdminScheduleTarget"("tenantId");
CREATE INDEX "MohAdminScheduleTarget_scheduleId_idx" ON "MohAdminScheduleTarget"("scheduleId");
ALTER TABLE "MohAdminScheduleTarget" ADD CONSTRAINT "MohAdminScheduleTarget_scheduleId_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "MohAdminSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MohAdminScheduleTarget" ADD CONSTRAINT "MohAdminScheduleTarget_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Admin schedule activation ledger (idempotency + restore) ─────────────────
CREATE TABLE "MohAdminScheduleActivation" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extension" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'active',
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "previousClass" TEXT,
    "previousControlMode" TEXT,
    "previousKeysSnapshot" JSONB NOT NULL DEFAULT '[]',
    "appliedClass" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MohAdminScheduleActivation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MohAdminScheduleActivation_scheduleId_idx" ON "MohAdminScheduleActivation"("scheduleId");
CREATE INDEX "MohAdminScheduleActivation_tenantId_idx" ON "MohAdminScheduleActivation"("tenantId");
CREATE INDEX "MohAdminScheduleActivation_state_idx" ON "MohAdminScheduleActivation"("state");
CREATE INDEX "MohAdminScheduleActivation_scheduleId_state_idx" ON "MohAdminScheduleActivation"("scheduleId", "state");
ALTER TABLE "MohAdminScheduleActivation" ADD CONSTRAINT "MohAdminScheduleActivation_scheduleId_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "MohAdminSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MohAdminScheduleActivation" ADD CONSTRAINT "MohAdminScheduleActivation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
