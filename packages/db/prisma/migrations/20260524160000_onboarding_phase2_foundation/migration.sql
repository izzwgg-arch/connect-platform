-- Onboarding Phase 2 Foundation
-- Append-only migration: creates enums and tables used by onboarding API/UI

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OnboardingStatus') THEN
    CREATE TYPE "OnboardingStatus" AS ENUM (
      'INVITE_SENT','IN_PROGRESS','SUBMITTED','AWAITING_PBX_SETUP','AWAITING_PORT','AWAITING_PAYMENT','READY_TO_SYNC','ACTIVE','COMPLETED','CANCELED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OnboardingEventType') THEN
    CREATE TYPE "OnboardingEventType" AS ENUM (
      'CREATED','AUTOSAVED','FILE_UPLOADED','STATUS_CHANGED','CHECKLIST_UPDATED','NOTES_UPDATED','SUBMITTED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "OnboardingSubmission" (
  "id" TEXT PRIMARY KEY,
  "publicToken" TEXT UNIQUE,
  "companyName" TEXT,
  "contactFirstName" TEXT,
  "contactLastName" TEXT,
  "mainEmail" TEXT,
  "billingEmail" TEXT,
  "mainPhone" TEXT,
  "phoneNumberChoice" TEXT,
  "smsEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "smsMonthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
  "status" "OnboardingStatus" NOT NULL DEFAULT 'INVITE_SENT',
  "currentStep" TEXT,
  "answers" JSONB,
  "provisioningChecklist" JSONB,
  "internalNotes" JSONB,
  "cardTokenPreview" TEXT,
  "createdTenantId" TEXT,
  "submittedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "OnboardingRequestedExtension" (
  "id" TEXT PRIMARY KEY,
  "submissionId" TEXT NOT NULL REFERENCES "OnboardingSubmission"("id") ON DELETE CASCADE,
  "displayName" TEXT,
  "extNumber" TEXT NOT NULL,
  "email" TEXT,
  "smsEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "OnboardingRequestedExtension_submissionId_idx" ON "OnboardingRequestedExtension" ("submissionId");

CREATE TABLE IF NOT EXISTS "OnboardingUploadedFile" (
  "id" TEXT PRIMARY KEY,
  "submissionId" TEXT NOT NULL REFERENCES "OnboardingSubmission"("id") ON DELETE CASCADE,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT,
  "sizeBytes" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "OnboardingUploadedFile_submissionId_idx" ON "OnboardingUploadedFile" ("submissionId");

CREATE TABLE IF NOT EXISTS "OnboardingEvent" (
  "id" TEXT PRIMARY KEY,
  "submissionId" TEXT NOT NULL REFERENCES "OnboardingSubmission"("id") ON DELETE CASCADE,
  "type" "OnboardingEventType" NOT NULL,
  "message" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "OnboardingEvent_submissionId_createdAt_idx" ON "OnboardingEvent" ("submissionId","createdAt");
