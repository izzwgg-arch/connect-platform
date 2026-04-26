-- DID route takeover:
--   * routingMode                 — "pbx" (default, factory/legacy) | "connect"
--   * originalPbxDestinationType  — snapshot of VitalPBX inbound_number
--   * originalPbxDestination      — snapshot of VitalPBX inbound_number
--   * originalPbxChannelVariables — snapshot of VitalPBX inbound_number (JSON)
--   * originalCapturedAt          — when we captured the live PBX state
--   * lastSwitchedAt              — last time routingMode flipped
--   * lastSwitchedBy              — userId that flipped it
--   * lastSwitchError             — last failed switch's error (null on success)
--
-- Every existing DID is treated as "pbx"-routed by default — harmless because
-- /voice/did/switch-to-connect is what moves the flag to "connect". Matching
-- behaviour: no runtime change until an operator explicitly switches a DID.

ALTER TABLE "DidRouteMapping"
  ADD COLUMN IF NOT EXISTS "routingMode"                 TEXT        NOT NULL DEFAULT 'pbx',
  ADD COLUMN IF NOT EXISTS "originalPbxDestinationType"  TEXT,
  ADD COLUMN IF NOT EXISTS "originalPbxDestination"      TEXT,
  ADD COLUMN IF NOT EXISTS "originalPbxChannelVariables" JSONB,
  ADD COLUMN IF NOT EXISTS "originalCapturedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastSwitchedAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastSwitchedBy"              TEXT,
  ADD COLUMN IF NOT EXISTS "lastSwitchError"             TEXT;

CREATE INDEX IF NOT EXISTS "DidRouteMapping_routingMode_idx" ON "DidRouteMapping"("routingMode");

-- Audit log of every takeover / restore action.
CREATE TABLE IF NOT EXISTS "DidRouteSwitchLog" (
    "id"          TEXT        NOT NULL,
    "mappingId"   TEXT        NOT NULL,
    "tenantId"    TEXT        NOT NULL,
    "fromMode"    TEXT        NOT NULL,
    "toMode"      TEXT        NOT NULL,
    "performedBy" TEXT        NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pbxPayload"  JSONB,
    "pbxSnapshot" JSONB,
    "status"      TEXT        NOT NULL,
    "error"       TEXT,
    CONSTRAINT "DidRouteSwitchLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DidRouteSwitchLog_mappingId_idx"            ON "DidRouteSwitchLog"("mappingId");
CREATE INDEX IF NOT EXISTS "DidRouteSwitchLog_tenantId_performedAt_idx" ON "DidRouteSwitchLog"("tenantId", "performedAt");
CREATE INDEX IF NOT EXISTS "DidRouteSwitchLog_status_idx"               ON "DidRouteSwitchLog"("status");

ALTER TABLE "DidRouteSwitchLog"
  ADD CONSTRAINT "DidRouteSwitchLog_mappingId_fkey"
  FOREIGN KEY ("mappingId") REFERENCES "DidRouteMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;
