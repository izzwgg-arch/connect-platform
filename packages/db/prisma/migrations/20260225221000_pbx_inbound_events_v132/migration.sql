DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CallInviteStatus' AND e.enumlabel = 'CANCELED'
  ) THEN
    ALTER TYPE "CallInviteStatus" ADD VALUE 'CANCELED';
  END IF;
END $$;

ALTER TABLE "CallInvite"
  ADD COLUMN IF NOT EXISTS "pbxCallId" TEXT,
  ADD COLUMN IF NOT EXISTS "canceledAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "CallInvite_tenantId_pbxCallId_key"
  ON "CallInvite"("tenantId", "pbxCallId");

CREATE INDEX IF NOT EXISTS "CallInvite_tenantId_status_expiresAt_idx"
  ON "CallInvite"("tenantId", "status", "expiresAt");

CREATE TABLE IF NOT EXISTS "PbxWebhookRegistration" (
  "id" TEXT NOT NULL,
  "pbxInstanceId" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "callbackUrl" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REGISTERED',
  "lastEventAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PbxWebhookRegistration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PbxWebhookRegistration_pbxInstanceId_fkey"
    FOREIGN KEY ("pbxInstanceId") REFERENCES "PbxInstance"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PbxWebhookRegistration_pbxInstanceId_key"
  ON "PbxWebhookRegistration"("pbxInstanceId");

CREATE INDEX IF NOT EXISTS "PbxWebhookRegistration_status_updatedAt_idx"
  ON "PbxWebhookRegistration"("status", "updatedAt");
