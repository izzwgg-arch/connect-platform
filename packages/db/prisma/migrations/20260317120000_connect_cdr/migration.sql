-- CreateTable: Connect-owned CDR records
-- One row per completed canonical call (deduplicated by Asterisk linkedId).
-- Populated by the telephony service via the API's /internal/cdr-ingest endpoint.
-- Used for dashboard KPI cards and call history — no PBX API dependency.

CREATE TABLE "ConnectCdr" (
    "id"          TEXT NOT NULL,
    "linkedId"    TEXT NOT NULL,
    "tenantId"    TEXT,
    "fromNumber"  TEXT,
    "toNumber"    TEXT,
    "direction"   TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "startedAt"   TIMESTAMP(3) NOT NULL,
    "answeredAt"  TIMESTAMP(3),
    "endedAt"     TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "talkSec"     INTEGER NOT NULL DEFAULT 0,
    "queueId"     TEXT,
    "hangupCause" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectCdr_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectCdr_linkedId_key" ON "ConnectCdr"("linkedId");

-- CreateIndex
CREATE INDEX "ConnectCdr_tenantId_startedAt_idx" ON "ConnectCdr"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "ConnectCdr_startedAt_idx" ON "ConnectCdr"("startedAt");

-- CreateIndex
CREATE INDEX "ConnectCdr_tenantId_direction_startedAt_idx" ON "ConnectCdr"("tenantId", "direction", "startedAt");
