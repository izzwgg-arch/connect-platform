-- WebRTC calling admin incidents + per-user dismissals

CREATE TABLE "WebrtcCallingIncident" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "failureType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "direction" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "actionText" TEXT NOT NULL,
    "latestSipCode" INTEGER,
    "latestSipReason" TEXT,
    "metadata" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebrtcCallingIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebrtcCallingIncidentDismissal" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebrtcCallingIncidentDismissal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebrtcCallingIncident_fingerprint_status_idx" ON "WebrtcCallingIncident"("fingerprint", "status");
CREATE INDEX "WebrtcCallingIncident_tenantId_status_idx" ON "WebrtcCallingIncident"("tenantId", "status");
CREATE INDEX "WebrtcCallingIncident_status_severity_idx" ON "WebrtcCallingIncident"("status", "severity");
CREATE INDEX "WebrtcCallingIncident_lastSeenAt_idx" ON "WebrtcCallingIncident"("lastSeenAt");

CREATE UNIQUE INDEX "WebrtcCallingIncidentDismissal_incidentId_userId_key" ON "WebrtcCallingIncidentDismissal"("incidentId", "userId");
CREATE INDEX "WebrtcCallingIncidentDismissal_userId_dismissedAt_idx" ON "WebrtcCallingIncidentDismissal"("userId", "dismissedAt");

ALTER TABLE "WebrtcCallingIncident" ADD CONSTRAINT "WebrtcCallingIncident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebrtcCallingIncidentDismissal" ADD CONSTRAINT "WebrtcCallingIncidentDismissal_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "WebrtcCallingIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebrtcCallingIncidentDismissal" ADD CONSTRAINT "WebrtcCallingIncidentDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
