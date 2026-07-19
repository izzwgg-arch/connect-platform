-- AI Support Agent — Ownership Ledger (PBX_PROVISIONING_PLAN.md §4). Additive only.
-- CreateTable
CREATE TABLE "AgentPbxObject" (
    "id" TEXT NOT NULL,
    "pbxObjectType" TEXT NOT NULL,
    "pbxObjectId" TEXT NOT NULL,
    "pbxTenantId" TEXT,
    "connectTenantId" TEXT,
    "createdByActionId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPbxObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPbxObject_pbxTenantId_idx" ON "AgentPbxObject"("pbxTenantId");

-- CreateIndex
CREATE INDEX "AgentPbxObject_state_idx" ON "AgentPbxObject"("state");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPbxObject_pbxObjectType_pbxObjectId_simulated_key" ON "AgentPbxObject"("pbxObjectType", "pbxObjectId", "simulated");
