-- PBX Observability & Diagnostics (Phase 1 — read-only). Additive only.
-- See docs/pbx/connect-pbx-observability-phase1-blueprint.md
-- All five tables store mapped PBX signals Connect already receives; they never
-- drive a write back to the PBX/AstDB/ombutel.

-- ── PbxEvent ──────────────────────────────────────────────────────────────────
CREATE TABLE "PbxEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedId" TEXT,
    "uniqueId" TEXT,
    "channel" TEXT,
    "bridgeId" TEXT,
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "extension" TEXT,
    "did" TEXT,
    "callerNumber" TEXT,
    "calleeNumber" TEXT,
    "metadata" JSONB,
    "redactionVersion" INTEGER NOT NULL DEFAULT 1,
    "pbxInstanceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PbxEvent_eventKey_key" ON "PbxEvent"("eventKey");
CREATE INDEX "PbxEvent_linkedId_idx" ON "PbxEvent"("linkedId");
CREATE INDEX "PbxEvent_uniqueId_idx" ON "PbxEvent"("uniqueId");
CREATE INDEX "PbxEvent_tenantId_occurredAt_idx" ON "PbxEvent"("tenantId", "occurredAt");
CREATE INDEX "PbxEvent_source_eventType_idx" ON "PbxEvent"("source", "eventType");
CREATE INDEX "PbxEvent_occurredAt_idx" ON "PbxEvent"("occurredAt");

-- ── PbxCallTrace ──────────────────────────────────────────────────────────────
CREATE TABLE "PbxCallTrace" (
    "id" TEXT NOT NULL,
    "rootLinkedId" TEXT NOT NULL,
    "linkedIds" TEXT[],
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "direction" TEXT,
    "disposition" TEXT,
    "failureClass" TEXT,
    "did" TEXT,
    "callerNumber" TEXT,
    "callerIdName" TEXT,
    "destinationNumber" TEXT,
    "connectedNumber" TEXT,
    "trunk" TEXT,
    "answeredByExtension" TEXT,
    "hangupCause" TEXT,
    "completeness" TEXT NOT NULL DEFAULT 'partial',
    "cdrId" TEXT,
    "startedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxCallTrace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PbxCallTrace_rootLinkedId_key" ON "PbxCallTrace"("rootLinkedId");
CREATE INDEX "PbxCallTrace_tenantId_startedAt_idx" ON "PbxCallTrace"("tenantId", "startedAt");
CREATE INDEX "PbxCallTrace_did_idx" ON "PbxCallTrace"("did");
CREATE INDEX "PbxCallTrace_callerNumber_idx" ON "PbxCallTrace"("callerNumber");
CREATE INDEX "PbxCallTrace_destinationNumber_idx" ON "PbxCallTrace"("destinationNumber");
CREATE INDEX "PbxCallTrace_trunk_idx" ON "PbxCallTrace"("trunk");
CREATE INDEX "PbxCallTrace_failureClass_idx" ON "PbxCallTrace"("failureClass");
CREATE INDEX "PbxCallTrace_hangupCause_idx" ON "PbxCallTrace"("hangupCause");
CREATE INDEX "PbxCallTrace_startedAt_idx" ON "PbxCallTrace"("startedAt");

-- ── PbxCallParticipant ────────────────────────────────────────────────────────
CREATE TABLE "PbxCallParticipant" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "extension" TEXT,
    "deviceName" TEXT,
    "sipUsername" TEXT,
    "channel" TEXT,
    "uniqueId" TEXT,
    "linkedId" TEXT,
    "connectedAt" TIMESTAMP(3),
    "hangupCause" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxCallParticipant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PbxCallParticipant_traceId_idx" ON "PbxCallParticipant"("traceId");
CREATE INDEX "PbxCallParticipant_extension_idx" ON "PbxCallParticipant"("extension");
CREATE INDEX "PbxCallParticipant_sipUsername_idx" ON "PbxCallParticipant"("sipUsername");
CREATE INDEX "PbxCallParticipant_deviceName_idx" ON "PbxCallParticipant"("deviceName");

-- ── PbxCallRouteStep ──────────────────────────────────────────────────────────
CREATE TABLE "PbxCallRouteStep" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ivrName" TEXT,
    "queueName" TEXT,
    "ringGroup" TEXT,
    "routeRef" TEXT,
    "details" JSONB,
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxCallRouteStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PbxCallRouteStep_traceId_seq_idx" ON "PbxCallRouteStep"("traceId", "seq");
CREATE INDEX "PbxCallRouteStep_stepType_idx" ON "PbxCallRouteStep"("stepType");
CREATE INDEX "PbxCallRouteStep_queueName_idx" ON "PbxCallRouteStep"("queueName");
CREATE INDEX "PbxCallRouteStep_ringGroup_idx" ON "PbxCallRouteStep"("ringGroup");

-- ── PbxStorageRetentionPolicy ─────────────────────────────────────────────────
CREATE TABLE "PbxStorageRetentionPolicy" (
    "id" TEXT NOT NULL,
    "pbxInstanceId" TEXT,
    "dataClass" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "archiveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "diskHighWatermarkPct" INTEGER NOT NULL DEFAULT 85,
    "diskLowWatermarkPct" INTEGER NOT NULL DEFAULT 75,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxStorageRetentionPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PbxStorageRetentionPolicy_pbxInstanceId_dataClass_key" ON "PbxStorageRetentionPolicy"("pbxInstanceId", "dataClass");

-- Foreign keys: participants and route steps cascade-delete with their parent trace.
ALTER TABLE "PbxCallParticipant" ADD CONSTRAINT "PbxCallParticipant_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "PbxCallTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PbxCallRouteStep" ADD CONSTRAINT "PbxCallRouteStep_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "PbxCallTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
