-- X2 Identity-Aware Sessions + Per-User Dossier
-- (docs/ai-support-agent/specs/X2_IDENTITY_SESSIONS_SPEC.md). Additive only:
-- one new table + one nullable column + one index. No existing row rewritten.

ALTER TABLE "AgentConversation" ADD COLUMN "dossierRecordedAt" TIMESTAMP(3);
CREATE INDEX "AgentConversation_status_dossierRecordedAt_idx" ON "AgentConversation"("status", "dossierRecordedAt");

CREATE TABLE "AgentUserDossier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "dossierMd" TEXT NOT NULL DEFAULT '',
    "rev" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentUserDossier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentUserDossier_tenantId_clientUserId_key" ON "AgentUserDossier"("tenantId", "clientUserId");
CREATE INDEX "AgentUserDossier_tenantId_idx" ON "AgentUserDossier"("tenantId");
