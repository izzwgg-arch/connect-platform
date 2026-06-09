-- CRM website submission email intake (Phase 1)
-- Additive only: learned rules, processing records, user notifications, and labels.

ALTER TYPE "ContactSource" ADD VALUE IF NOT EXISTS 'WEBSITE_SUBMISSION';
ALTER TYPE "CrmLeadDocumentSource" ADD VALUE IF NOT EXISTS 'EMAIL_ATTACHMENT';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'WEBSITE_SUBMISSION';

DO $$
BEGIN
  CREATE TYPE "CrmWebsiteSubmissionRuleMode" AS ENUM ('AUTO_CREATE', 'REVIEW_FIRST');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CrmWebsiteSubmissionStatus" AS ENUM ('MATCHED', 'PROCESSED', 'PENDING_REVIEW', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CrmWebsiteSubmissionEmailRule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "senderEmail" TEXT,
  "senderDomain" TEXT,
  "subjectPattern" TEXT,
  "bodyPatterns" JSONB DEFAULT '[]',
  "fieldMap" JSONB NOT NULL DEFAULT '{}',
  "attachmentExpectations" JSONB NOT NULL DEFAULT '[]',
  "assignmentUserId" TEXT,
  "assignmentTeamId" TEXT,
  "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
  "mode" "CrmWebsiteSubmissionRuleMode" NOT NULL DEFAULT 'REVIEW_FIRST',
  "sampleMetadata" JSONB,
  "lastMatchedAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmWebsiteSubmissionEmailRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmWebsiteSubmission" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "gmailMessageId" TEXT NOT NULL,
  "emailMessageId" TEXT,
  "contactId" TEXT,
  "status" "CrmWebsiteSubmissionStatus" NOT NULL DEFAULT 'MATCHED',
  "fromEmail" TEXT,
  "subject" TEXT,
  "receivedAt" TIMESTAMP(3),
  "extractedFields" JSONB NOT NULL DEFAULT '{}',
  "unmappedSummary" JSONB NOT NULL DEFAULT '[]',
  "attachmentSummary" JSONB NOT NULL DEFAULT '[]',
  "confidence" DOUBLE PRECISION,
  "safeError" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmWebsiteSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmUserNotification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "route" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'CRM',
  "metadata" JSONB,
  "dismissedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmUserNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmWebsiteSubmission_tenantId_gmailMessageId_key"
  ON "CrmWebsiteSubmission"("tenantId", "gmailMessageId");

CREATE INDEX IF NOT EXISTS "CrmWebsiteSubmissionEmailRule_tenantId_connectionId_active_idx"
  ON "CrmWebsiteSubmissionEmailRule"("tenantId", "connectionId", "active");
CREATE INDEX IF NOT EXISTS "CrmWebsiteSubmissionEmailRule_tenantId_active_idx"
  ON "CrmWebsiteSubmissionEmailRule"("tenantId", "active");
CREATE INDEX IF NOT EXISTS "CrmWebsiteSubmissionEmailRule_assignmentUserId_idx"
  ON "CrmWebsiteSubmissionEmailRule"("assignmentUserId");

CREATE INDEX IF NOT EXISTS "CrmWebsiteSubmission_tenantId_status_createdAt_idx"
  ON "CrmWebsiteSubmission"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmWebsiteSubmission_tenantId_ruleId_createdAt_idx"
  ON "CrmWebsiteSubmission"("tenantId", "ruleId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmWebsiteSubmission_tenantId_contactId_idx"
  ON "CrmWebsiteSubmission"("tenantId", "contactId");

CREATE INDEX IF NOT EXISTS "CrmUserNotification_tenantId_userId_dismissedAt_createdAt_idx"
  ON "CrmUserNotification"("tenantId", "userId", "dismissedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmUserNotification_tenantId_createdAt_idx"
  ON "CrmUserNotification"("tenantId", "createdAt");

ALTER TABLE "CrmWebsiteSubmissionEmailRule"
  ADD CONSTRAINT "CrmWebsiteSubmissionEmailRule_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmissionEmailRule"
  ADD CONSTRAINT "CrmWebsiteSubmissionEmailRule_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "CrmEmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmissionEmailRule"
  ADD CONSTRAINT "CrmWebsiteSubmissionEmailRule_assignmentUserId_fkey"
  FOREIGN KEY ("assignmentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmissionEmailRule"
  ADD CONSTRAINT "CrmWebsiteSubmissionEmailRule_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmWebsiteSubmission"
  ADD CONSTRAINT "CrmWebsiteSubmission_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmission"
  ADD CONSTRAINT "CrmWebsiteSubmission_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "CrmWebsiteSubmissionEmailRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmission"
  ADD CONSTRAINT "CrmWebsiteSubmission_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "CrmEmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmission"
  ADD CONSTRAINT "CrmWebsiteSubmission_emailMessageId_fkey"
  FOREIGN KEY ("emailMessageId") REFERENCES "CrmEmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CrmWebsiteSubmission"
  ADD CONSTRAINT "CrmWebsiteSubmission_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CrmUserNotification"
  ADD CONSTRAINT "CrmUserNotification_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmUserNotification"
  ADD CONSTRAINT "CrmUserNotification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
