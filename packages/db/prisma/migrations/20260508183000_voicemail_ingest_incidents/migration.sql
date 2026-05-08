-- Voicemail ingestion incidents (super-admin monitoring)

CREATE TABLE "VoicemailIngestIncident" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "tenantId" TEXT,
    "scenario" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastEventAt" TIMESTAMP(3),
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "actionText" TEXT NOT NULL,
    "metadata" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoicemailIngestIncident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoicemailIngestIncident_fingerprint_status_idx" ON "VoicemailIngestIncident"("fingerprint", "status");
CREATE INDEX "VoicemailIngestIncident_status_severity_idx" ON "VoicemailIngestIncident"("status", "severity");
CREATE INDEX "VoicemailIngestIncident_tenantId_idx" ON "VoicemailIngestIncident"("tenantId");
CREATE INDEX "VoicemailIngestIncident_scenario_status_idx" ON "VoicemailIngestIncident"("scenario", "status");
CREATE INDEX "VoicemailIngestIncident_createdAt_idx" ON "VoicemailIngestIncident"("createdAt");

ALTER TABLE "VoicemailIngestIncident" ADD CONSTRAINT "VoicemailIngestIncident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
