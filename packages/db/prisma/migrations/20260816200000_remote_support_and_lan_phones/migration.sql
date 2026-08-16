-- Remote support (watch/drive a customer's Windows machine) and the desk-phone
-- inventory the Windows app discovers on the customer's own network.
--
-- Consent is per session and control is consented separately from viewing:
-- "controlRequested" is what the admin asked for, "controlGranted" is what the
-- customer agreed to, and only the consent route ever writes the latter.

CREATE TYPE "RemoteSupportStatus" AS ENUM (
  'REQUESTED', 'CONSENTED', 'ACTIVE', 'ENDED', 'DECLINED', 'EXPIRED'
);

CREATE TYPE "RemoteSupportSignalRole" AS ENUM ('ADMIN', 'CLIENT');

CREATE TABLE "RemoteSupportSession" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "targetUserId"      TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "status"            "RemoteSupportStatus" NOT NULL DEFAULT 'REQUESTED',
  "controlRequested"  BOOLEAN NOT NULL DEFAULT false,
  "controlGranted"    BOOLEAN NOT NULL DEFAULT false,
  "requestReason"     TEXT NOT NULL,
  "deviceLabel"       TEXT,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "consentAt"         TIMESTAMP(3),
  "declinedAt"        TIMESTAMP(3),
  "startedAt"         TIMESTAMP(3),
  "endedAt"           TIMESTAMP(3),
  "endedReason"       TEXT,
  "endedBy"           TEXT,
  "lastSeenAdminAt"   TIMESTAMP(3),
  "lastSeenClientAt"  TIMESTAMP(3),
  "inputEventCount"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RemoteSupportSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RemoteSupportSession_tenantId_status_idx"       ON "RemoteSupportSession"("tenantId", "status");
CREATE INDEX "RemoteSupportSession_targetUserId_status_idx"   ON "RemoteSupportSession"("targetUserId", "status");
CREATE INDEX "RemoteSupportSession_requestedByUserId_idx"     ON "RemoteSupportSession"("requestedByUserId");
CREATE INDEX "RemoteSupportSession_status_expiresAt_idx"      ON "RemoteSupportSession"("status", "expiresAt");

ALTER TABLE "RemoteSupportSession"
  ADD CONSTRAINT "RemoteSupportSession_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Signalling relay. Short-lived by design: rows are consumed as the peer
-- connection is established and never carry screen data or input events.
CREATE TABLE "RemoteSupportSignal" (
  "id"         TEXT NOT NULL,
  "sessionId"  TEXT NOT NULL,
  "fromRole"   "RemoteSupportSignalRole" NOT NULL,
  "kind"       TEXT NOT NULL,
  "payload"    JSONB NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "RemoteSupportSignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RemoteSupportSignal_sessionId_fromRole_consumedAt_idx" ON "RemoteSupportSignal"("sessionId", "fromRole", "consumedAt");
CREATE INDEX "RemoteSupportSignal_createdAt_idx"                     ON "RemoteSupportSignal"("createdAt");

ALTER TABLE "RemoteSupportSignal"
  ADD CONSTRAINT "RemoteSupportSignal_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "RemoteSupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One scan of a customer's LAN. Kept separate from the phones so that "the
-- scan ran and found nothing" is distinguishable from "no scan ever ran".
CREATE TABLE "LanDiscoveryRun" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "reportedByUserId" TEXT NOT NULL,
  "deviceLabel"      TEXT,
  "subnet"           TEXT,
  "startedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"       TIMESTAMP(3),
  "outcome"          TEXT,
  "note"             TEXT,
  "hostsSeen"        INTEGER NOT NULL DEFAULT 0,
  "phonesFound"      INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "LanDiscoveryRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LanDiscoveryRun_tenantId_startedAt_idx" ON "LanDiscoveryRun"("tenantId", "startedAt");

ALTER TABLE "LanDiscoveryRun"
  ADD CONSTRAINT "LanDiscoveryRun_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The phone's own account of itself, so it can be compared against the MAC on
-- the PBX record — the field that silently breaks provisioning when wrong.
CREATE TABLE "LanDiscoveredPhone" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "macAddress"      TEXT NOT NULL,
  "ipAddress"       TEXT,
  "vendor"          TEXT,
  "model"           TEXT,
  "firmware"        TEXT,
  "hostname"        TEXT,
  "provisioningUrl" TEXT,
  "lastRunId"       TEXT,
  "firstSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LanDiscoveredPhone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LanDiscoveredPhone_tenantId_macAddress_key" ON "LanDiscoveredPhone"("tenantId", "macAddress");
CREATE INDEX "LanDiscoveredPhone_tenantId_lastSeenAt_idx"        ON "LanDiscoveredPhone"("tenantId", "lastSeenAt");
CREATE INDEX "LanDiscoveredPhone_tenantId_vendor_idx"            ON "LanDiscoveredPhone"("tenantId", "vendor");

ALTER TABLE "LanDiscoveredPhone"
  ADD CONSTRAINT "LanDiscoveredPhone_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LanDiscoveredPhone"
  ADD CONSTRAINT "LanDiscoveredPhone_lastRunId_fkey"
  FOREIGN KEY ("lastRunId") REFERENCES "LanDiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
