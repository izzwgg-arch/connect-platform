-- Additional addresses an admin has added for an extension's voicemail email.
-- The PBX address (Extension."pbxUserEmail") is always included first and is NOT
-- duplicated here; this table is purely extra recipients.
CREATE TABLE "VoicemailEmailRecipient" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "extensionId" TEXT NOT NULL,
  "email"       TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoicemailEmailRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VoicemailEmailRecipient_extensionId_email_key"
  ON "VoicemailEmailRecipient"("extensionId", "email");
CREATE INDEX "VoicemailEmailRecipient_tenantId_idx"
  ON "VoicemailEmailRecipient"("tenantId");

ALTER TABLE "VoicemailEmailRecipient"
  ADD CONSTRAINT "VoicemailEmailRecipient_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoicemailEmailRecipient"
  ADD CONSTRAINT "VoicemailEmailRecipient_extensionId_fkey"
  FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Why a voicemail produced no email. NULL means an email was queued.
-- Lets the watchdog separate a deliberate skip from a failure without guessing.
ALTER TABLE "Voicemail" ADD COLUMN "emailSkipReason" TEXT;

-- Voicemails that already existed before this feature must never produce a
-- backlog of emails about old messages. Mark everything currently unstamped as
-- deliberately skipped so the sender starts from now.
UPDATE "Voicemail"
   SET "emailedAt" = NOW(), "emailSkipReason" = 'predates_feature'
 WHERE "emailedAt" IS NULL;
