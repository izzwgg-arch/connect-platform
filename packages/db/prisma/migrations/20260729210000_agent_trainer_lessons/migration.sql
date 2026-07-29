-- Trainer-mode lessons: designated tester corrects the agent in chat and the
-- lesson takes effect immediately; owner can revoke. Fully attributed + timestamped.
CREATE TABLE "AgentTrainerLesson" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lesson" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "sourceConversationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrainerLesson_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTrainerLesson_tenantId_active_createdAt_idx" ON "AgentTrainerLesson"("tenantId", "active", "createdAt");
