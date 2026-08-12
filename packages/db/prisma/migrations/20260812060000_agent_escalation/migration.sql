-- Agent escalations: a customer request the assistant could not handle,
-- researched and packaged for the owner's decision. The agent writes rows;
-- the api dispatcher sends the SMS + email report.

CREATE TYPE "AgentEscalationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

CREATE TABLE "AgentEscalation" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT,
  "tenantId" TEXT NOT NULL,
  "tenantName" TEXT NOT NULL,
  "clientUserId" TEXT,
  "userName" TEXT NOT NULL,
  "userEmail" TEXT,
  "requestSummary" TEXT NOT NULL,
  "smsBody" TEXT NOT NULL,
  "report" TEXT NOT NULL,
  "proposedFix" TEXT NOT NULL,
  "researchDegraded" BOOLEAN NOT NULL DEFAULT false,
  "status" "AgentEscalationStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "smsSentAt" TIMESTAMP(3),
  "emailQueuedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentEscalation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentEscalation_status_createdAt_idx" ON "AgentEscalation" ("status", "createdAt");
CREATE INDEX "AgentEscalation_conversationId_createdAt_idx" ON "AgentEscalation" ("conversationId", "createdAt");
CREATE INDEX "AgentEscalation_tenantId_createdAt_idx" ON "AgentEscalation" ("tenantId", "createdAt");

-- EmailJob: a deliberate non-send state, so muted ADMIN_ALERT mails are
-- distinguishable from failures. (Postgres 12+ allows ADD VALUE in a
-- transaction as long as the new value is not used in the same transaction.)
ALTER TYPE "EmailJobStatus" ADD VALUE 'SKIPPED';
