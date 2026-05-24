-- CRM Email Phase 1 — send-only, metadata-first
-- Additive-only migration: new enum + new tables + enum value additions.
-- No destructive changes.

-- CreateEnum: EmailPrivacyMode
CREATE TYPE "EmailPrivacyMode" AS ENUM (
  'METADATA_ONLY',
  'METADATA_WITH_CACHE_30D',
  'FULL_RETENTION'
);

-- Add email-related timeline event types (additive)
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'EMAIL_SENT';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'EMAIL_RECEIVED';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'EMAIL_REPLY';

-- CreateTable: CrmEmailConnection
CREATE TABLE "CrmEmailConnection" (
  "id"                      TEXT NOT NULL,
  "tenantId"                TEXT NOT NULL,
  "userId"                  TEXT NOT NULL,
  "provider"                "EmailProviderType" NOT NULL DEFAULT 'GOOGLE_WORKSPACE',
  "emailAddress"            TEXT NOT NULL,
  "displayName"             TEXT,
  "googleAccountId"         TEXT,
  "encryptedAccessToken"    TEXT NOT NULL,
  "encryptedRefreshToken"   TEXT NOT NULL,
  "tokenExpiresAt"          TIMESTAMP(3),
  "scopes"                  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "replyTrackingEnabled"    BOOLEAN NOT NULL DEFAULT false,
  "gmailHistoryId"          TEXT,
  "bodyCacheMode"           "EmailPrivacyMode" NOT NULL DEFAULT 'METADATA_ONLY',
  "bodyCacheRetentionDays"  INTEGER NOT NULL DEFAULT 30,
  "status"                  TEXT NOT NULL DEFAULT 'CONNECTED',
  "lastSyncAt"              TIMESTAMP(3),
  "lastError"               TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmEmailConnection_pkey" PRIMARY KEY ("id")
);

-- FKs for CrmEmailConnection
ALTER TABLE "CrmEmailConnection"
  ADD CONSTRAINT "CrmEmailConnection_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes/uniques for CrmEmailConnection
CREATE UNIQUE INDEX "CrmEmailConnection_tenantId_userId_key" ON "CrmEmailConnection"("tenantId", "userId");
CREATE INDEX "CrmEmailConnection_tenantId_status_idx" ON "CrmEmailConnection"("tenantId", "status");

-- CreateTable: CrmEmailThread
CREATE TABLE "CrmEmailThread" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "contactId"     TEXT,
  "gmailThreadId" TEXT NOT NULL,
  "subject"       TEXT,
  "lastMessageAt" TIMESTAMP(3),
  "unreadCount"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmEmailThread_pkey" PRIMARY KEY ("id")
);

-- FKs for CrmEmailThread
ALTER TABLE "CrmEmailThread"
  ADD CONSTRAINT "CrmEmailThread_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailThread_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailThread_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes/uniques for CrmEmailThread
CREATE UNIQUE INDEX "CrmEmailThread_tenantId_gmailThreadId_key" ON "CrmEmailThread"("tenantId", "gmailThreadId");
CREATE INDEX "CrmEmailThread_tenantId_contactId_lastMessageAt_idx" ON "CrmEmailThread"("tenantId", "contactId", "lastMessageAt");

-- CreateTable: CrmEmailMessage
CREATE TABLE "CrmEmailMessage" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "threadId"         TEXT,
  "contactId"        TEXT,
  "gmailMessageId"   TEXT NOT NULL,
  "direction"        TEXT NOT NULL,
  "subject"          TEXT,
  "fromEmail"        TEXT,
  "toEmail"          TEXT,
  "cc"               TEXT,
  "bcc"              TEXT,
  "previewSnippet"   TEXT,
  "aiSummary"        TEXT,
  "hasCachedBody"    BOOLEAN NOT NULL DEFAULT false,
  "bodyCacheEncrypted" TEXT,
  "bodyCacheExpiresAt" TIMESTAMP(3),
  "sentAt"           TIMESTAMP(3),
  "receivedAt"       TIMESTAMP(3),
  "syncStatus"       TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmEmailMessage_pkey" PRIMARY KEY ("id")
);

-- FKs for CrmEmailMessage
ALTER TABLE "CrmEmailMessage"
  ADD CONSTRAINT "CrmEmailMessage_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailMessage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "CrmEmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailMessage_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes/uniques for CrmEmailMessage
CREATE UNIQUE INDEX "CrmEmailMessage_tenantId_gmailMessageId_key" ON "CrmEmailMessage"("tenantId", "gmailMessageId");
CREATE INDEX "CrmEmailMessage_threadId_createdAt_idx" ON "CrmEmailMessage"("threadId", "createdAt");
CREATE INDEX "CrmEmailMessage_tenantId_hasCachedBody_bodyCacheExpiresAt_idx" ON "CrmEmailMessage"("tenantId", "hasCachedBody", "bodyCacheExpiresAt");

-- CreateTable: CrmEmailSendLog
CREATE TABLE "CrmEmailSendLog" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "contactId"      TEXT,
  "templateId"     TEXT,
  "gmailMessageId" TEXT,
  "gmailThreadId"  TEXT,
  "toEmail"        TEXT NOT NULL,
  "subject"        TEXT,
  "status"         TEXT NOT NULL DEFAULT 'SENT',
  "errorMessage"   TEXT,
  "sentAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmEmailSendLog_pkey" PRIMARY KEY ("id")
);

-- FKs for CrmEmailSendLog
ALTER TABLE "CrmEmailSendLog"
  ADD CONSTRAINT "CrmEmailSendLog_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailSendLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CrmEmailSendLog_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes for CrmEmailSendLog
CREATE INDEX "CrmEmailSendLog_tenantId_userId_sentAt_idx" ON "CrmEmailSendLog"("tenantId", "userId", "sentAt");
CREATE INDEX "CrmEmailSendLog_tenantId_gmailMessageId_idx" ON "CrmEmailSendLog"("tenantId", "gmailMessageId");
