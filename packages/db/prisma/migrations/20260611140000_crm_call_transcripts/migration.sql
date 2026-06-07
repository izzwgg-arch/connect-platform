-- Migration: crm_call_transcripts
-- Post-call Google Cloud transcription rows for CRM call recordings.

CREATE TYPE "CrmCallTranscriptStatus" AS ENUM (
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'UNAVAILABLE'
);

CREATE TABLE "CrmCallTranscript" (
  "id"                  TEXT                      NOT NULL,
  "tenantId"            TEXT                      NOT NULL,
  "contactId"           TEXT                      NOT NULL,
  "linkedId"            TEXT                      NOT NULL,
  "status"              "CrmCallTranscriptStatus" NOT NULL DEFAULT 'QUEUED',
  "provider"            TEXT                      NOT NULL DEFAULT 'google',
  "languageCode"        TEXT                      NOT NULL DEFAULT 'en-US',
  "transcript"          TEXT,
  "summary"             TEXT,
  "actionItems"         JSONB,
  "sentiment"           TEXT,
  "intent"              TEXT,
  "confidence"          DOUBLE PRECISION,
  "modelName"           TEXT,
  "googleOperationName" TEXT,
  "gcsUri"              TEXT,
  "audioDurationSec"    INTEGER,
  "errorCode"           TEXT,
  "errorMessage"        TEXT,
  "queuedAt"            TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"           TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  "failedAt"            TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmCallTranscript_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrmCallTranscript_tenantId_linkedId_key"
  ON "CrmCallTranscript"("tenantId", "linkedId");

CREATE INDEX "CrmCallTranscript_tenantId_contactId_createdAt_idx"
  ON "CrmCallTranscript"("tenantId", "contactId", "createdAt");

CREATE INDEX "CrmCallTranscript_tenantId_status_updatedAt_idx"
  ON "CrmCallTranscript"("tenantId", "status", "updatedAt");

CREATE INDEX "CrmCallTranscript_contactId_linkedId_idx"
  ON "CrmCallTranscript"("contactId", "linkedId");

ALTER TABLE "CrmCallTranscript"
  ADD CONSTRAINT "CrmCallTranscript_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;

ALTER TABLE "CrmCallTranscript"
  ADD CONSTRAINT "CrmCallTranscript_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;
