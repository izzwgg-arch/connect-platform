-- AI Support Agent ("Shammes") — additive only. docs/ai-support-agent/PLAN.md §5
-- CreateEnum
CREATE TYPE "AgentConversationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AgentChannel" AS ENUM ('CHAT', 'EMAIL', 'WHATSAPP', 'SMS', 'PHONE');

-- CreateEnum
CREATE TYPE "AgentActionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED', 'REVERTED', 'DENIED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientUserId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'customer',
    "channel" "AgentChannel" NOT NULL DEFAULT 'CHAT',
    "language" TEXT,
    "status" "AgentConversationStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "audioUrl" TEXT,
    "transcript" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT,
    "capabilityId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "riskTier" TEXT NOT NULL DEFAULT 'low',
    "status" "AgentActionStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedRole" TEXT NOT NULL DEFAULT 'customer',
    "approvedBy" TEXT,
    "approvalToken" TEXT,
    "deniedReason" TEXT,
    "executedAt" TIMESTAMP(3),
    "revertAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "revertOfId" TEXT,
    "resultSnapshot" JSONB,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAuditLog" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "tenantId" TEXT,
    "conversationId" TEXT,
    "actionId" TEXT,
    "capabilityId" TEXT,
    "payload" JSONB,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AgentAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "grants" JSONB NOT NULL,
    "historyVisible" BOOLEAN NOT NULL DEFAULT false,
    "channels" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDiagReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extension" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "findings" JSONB NOT NULL,
    "hypotheses" JSONB NOT NULL,
    "recommendation" TEXT,
    "sentTo" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDiagReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentIncident" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentKbArticle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "title" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "fix" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "sourceConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentKbArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTranscript" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "recordingId" TEXT NOT NULL,
    "language" TEXT,
    "text" TEXT NOT NULL,
    "diarization" JSONB,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConversation_tenantId_startedAt_idx" ON "AgentConversation"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentConversation_tenantId_status_idx" ON "AgentConversation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AgentMessage_conversationId_createdAt_idx" ON "AgentMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_approvalToken_key" ON "AgentAction"("approvalToken");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_revertOfId_key" ON "AgentAction"("revertOfId");

-- CreateIndex
CREATE INDEX "AgentAction_tenantId_status_idx" ON "AgentAction"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AgentAction_status_revertAt_idx" ON "AgentAction"("status", "revertAt");

-- CreateIndex
CREATE INDEX "AgentAction_createdAt_idx" ON "AgentAction"("createdAt");

-- CreateIndex
CREATE INDEX "AgentAuditLog_ts_idx" ON "AgentAuditLog"("ts");

-- CreateIndex
CREATE INDEX "AgentAuditLog_tenantId_ts_idx" ON "AgentAuditLog"("tenantId", "ts");

-- CreateIndex
CREATE INDEX "AgentAuditLog_event_ts_idx" ON "AgentAuditLog"("event", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPolicy_tenantId_key" ON "AgentPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "AgentDiagReport_tenantId_createdAt_idx" ON "AgentDiagReport"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentIncident_severity_createdAt_idx" ON "AgentIncident"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "AgentIncident_status_idx" ON "AgentIncident"("status");

-- CreateIndex
CREATE INDEX "AgentKbArticle_tenantId_approved_idx" ON "AgentKbArticle"("tenantId", "approved");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemory_tenantId_key_key" ON "AgentMemory"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTranscript_recordingId_key" ON "AgentTranscript"("recordingId");

-- CreateIndex
CREATE INDEX "AgentTranscript_tenantId_createdAt_idx" ON "AgentTranscript"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
