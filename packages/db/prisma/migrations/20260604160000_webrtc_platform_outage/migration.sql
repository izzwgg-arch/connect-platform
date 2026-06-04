-- Platform-wide WebRTC outage incidents + per-admin dismissals

CREATE TABLE "WebrtcPlatformOutage" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "failureType" TEXT NOT NULL DEFAULT 'GLOBAL_WEBRTC_OUTAGE',
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "actionText" TEXT NOT NULL,
    "diagnosisSummary" TEXT,
    "latestDiagnosisCategory" TEXT,
    "latestSipCode" INTEGER,
    "latestSipReason" TEXT,
    "metadata" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebrtcPlatformOutage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebrtcPlatformOutageDismissal" (
    "id" TEXT NOT NULL,
    "outageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebrtcPlatformOutageDismissal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebrtcPlatformOutage_fingerprint_status_idx" ON "WebrtcPlatformOutage"("fingerprint", "status");
CREATE INDEX "WebrtcPlatformOutage_status_severity_idx" ON "WebrtcPlatformOutage"("status", "severity");
CREATE INDEX "WebrtcPlatformOutage_lastSeenAt_idx" ON "WebrtcPlatformOutage"("lastSeenAt");

CREATE UNIQUE INDEX "WebrtcPlatformOutageDismissal_outageId_userId_key" ON "WebrtcPlatformOutageDismissal"("outageId", "userId");
CREATE INDEX "WebrtcPlatformOutageDismissal_userId_dismissedAt_idx" ON "WebrtcPlatformOutageDismissal"("userId", "dismissedAt");

ALTER TABLE "WebrtcPlatformOutageDismissal" ADD CONSTRAINT "WebrtcPlatformOutageDismissal_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "WebrtcPlatformOutage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebrtcPlatformOutageDismissal" ADD CONSTRAINT "WebrtcPlatformOutageDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
