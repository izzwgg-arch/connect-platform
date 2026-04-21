-- Migration: Voicemail table
-- Stores voicemail metadata ingested from VitalPBX.
-- Audio is proxied server-side; no audio bytes are stored here.

CREATE TABLE "Voicemail" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT,
    "pbxMessageId"   TEXT NOT NULL,
    "extension"      TEXT NOT NULL,
    "pbxExtensionId" TEXT,
    "callerNumber"   TEXT,
    "callerName"     TEXT,
    "durationSec"    INTEGER NOT NULL DEFAULT 0,
    "folder"         TEXT NOT NULL DEFAULT 'inbox',
    "pbxFolder"      TEXT,
    "pbxMsgNum"      TEXT,
    "listened"       BOOLEAN NOT NULL DEFAULT false,
    "receivedAt"     TIMESTAMP(3) NOT NULL,
    "readAt"         TIMESTAMP(3),
    "deletedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voicemail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Voicemail_pbxMessageId_key" ON "Voicemail"("pbxMessageId");
CREATE INDEX "Voicemail_tenantId_idx"                    ON "Voicemail"("tenantId");
CREATE INDEX "Voicemail_extension_idx"                   ON "Voicemail"("extension");
CREATE INDEX "Voicemail_receivedAt_idx"                  ON "Voicemail"("receivedAt");
CREATE INDEX "Voicemail_tenantId_extension_receivedAt_idx" ON "Voicemail"("tenantId", "extension", "receivedAt");
