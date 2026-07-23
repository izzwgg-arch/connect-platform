-- X1 Modify Executor (docs/ai-support-agent/specs/X1_MODIFY_EXECUTOR_SPEC.md).
-- Additive only: one new table + two nullable columns. No existing row is
-- rewritten; existing A/P action flows ignore both columns (null).

ALTER TABLE "AgentAction" ADD COLUMN "paramsHash" TEXT;
ALTER TABLE "AgentAction" ADD COLUMN "approvalConsumedAt" TIMESTAMP(3);

CREATE TABLE "AgentPbxSnapshot" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "stateJson" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentPbxSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentPbxSnapshot_actionId_key" ON "AgentPbxSnapshot"("actionId");
CREATE INDEX "AgentPbxSnapshot_tenantId_objectType_objectId_idx" ON "AgentPbxSnapshot"("tenantId", "objectType", "objectId");
CREATE INDEX "AgentPbxSnapshot_expiresAt_idx" ON "AgentPbxSnapshot"("expiresAt");
