-- The Jewish calendar for a tenant (2026-08-21).
--
-- ONE row per tenant, read by BOTH the IVR (which menu callers hear) and the
-- hold music (which class plays), so the two can never disagree about whether
-- it is yom tov. The DATES are not stored — they come from a generated table in
-- packages/shared/src/jewishCalendar. Only what differs between customers lives
-- here: where they are, whose nightfall they keep, what the phone should do.
--
-- New table only. No existing table, column or row is touched, and `enabled`
-- defaults to false, so this migration changes nothing for any tenant until
-- somebody switches it on.
--
-- The CREATE TABLE below is Prisma's own generated DDL (migrate diff against
-- the model), not hand-written; the two foreign keys are appended because the
-- diff was run without the related models in scope.
CREATE TABLE "TenantJewishCalendar" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "communityId" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL DEFAULT 41.1112,
    "longitude" DOUBLE PRECISION NOT NULL DEFAULT -74.0687,
    "nightfallShita" TEXT NOT NULL DEFAULT 'satmar',
    "candleLightingMinutes" INTEGER NOT NULL DEFAULT 18,
    "closeForShabbos" BOOLEAN NOT NULL DEFAULT true,
    "closeForYomTov" BOOLEAN NOT NULL DEFAULT true,
    "earlyCloseMinutesBeforeCandles" INTEGER NOT NULL DEFAULT 60,
    "reopenMinutesAfterNightfall" INTEGER NOT NULL DEFAULT 0,
    "reopenNextMorning" BOOLEAN NOT NULL DEFAULT true,
    "cholHamoed" TEXT NOT NULL DEFAULT 'open',
    "fastDays" TEXT NOT NULL DEFAULT 'open',
    "holidayOverrides" JSONB NOT NULL DEFAULT '{}',
    "sefirah" TEXT NOT NULL DEFAULT 'early',
    "threeWeeksNoMusic" BOOLEAN NOT NULL DEFAULT true,
    "nineDaysNoMusic" BOOLEAN NOT NULL DEFAULT true,
    "acappellaMohProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "TenantJewishCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantJewishCalendar_tenantId_key" ON "TenantJewishCalendar"("tenantId");

-- AddForeignKey
-- Cascade with the tenant, like every other per-tenant config table.
ALTER TABLE "TenantJewishCalendar" ADD CONSTRAINT "TenantJewishCalendar_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, not Cascade: deleting the a cappella hold-music profile must not
-- delete the customer's whole Jewish calendar. It just stops the music swap.
ALTER TABLE "TenantJewishCalendar" ADD CONSTRAINT "TenantJewishCalendar_acappellaMohProfileId_fkey"
    FOREIGN KEY ("acappellaMohProfileId") REFERENCES "MohProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
