-- Booked hand-overs of a DID to a Connect IVR (and optional hand-back).
CREATE TABLE "DidSwitchSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "ivrProfileId" TEXT NOT NULL,
    "activateAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "createdBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DidSwitchSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DidSwitchSchedule_status_activateAt_idx" ON "DidSwitchSchedule"("status", "activateAt");
CREATE INDEX "DidSwitchSchedule_status_endAt_idx" ON "DidSwitchSchedule"("status", "endAt");
CREATE INDEX "DidSwitchSchedule_tenantId_idx" ON "DidSwitchSchedule"("tenantId");
CREATE INDEX "DidSwitchSchedule_mappingId_idx" ON "DidSwitchSchedule"("mappingId");

-- Tenant-wide pre-IVR announcements with a booked start/stop.
CREATE TABLE "IvrAnnouncementSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promptRef" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "createdBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IvrAnnouncementSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IvrAnnouncementSchedule_status_startAt_idx" ON "IvrAnnouncementSchedule"("status", "startAt");
CREATE INDEX "IvrAnnouncementSchedule_status_endAt_idx" ON "IvrAnnouncementSchedule"("status", "endAt");
CREATE INDEX "IvrAnnouncementSchedule_tenantId_idx" ON "IvrAnnouncementSchedule"("tenantId");
