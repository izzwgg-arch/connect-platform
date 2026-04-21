-- Call Flight Recorder: one row per mobile call attempt, full event timeline as JSON.
-- Run this migration when deploying the call flight recorder feature.

CREATE TABLE IF NOT EXISTS "CallFlightSession" (
    "id"             TEXT NOT NULL,
    "inviteId"       TEXT,
    "pbxCallId"      TEXT,
    "linkedId"       TEXT,
    "tenantId"       TEXT,
    "userId"         TEXT,
    "deviceId"       TEXT,
    "extension"      TEXT,
    "fromNumber"     TEXT,
    "platform"       TEXT NOT NULL DEFAULT 'ANDROID',
    "appVersion"     TEXT,
    "networkType"    TEXT,
    "result"         TEXT,
    "uiMode"         TEXT,
    "startedAt"      TIMESTAMP(3) NOT NULL,
    "endedAt"        TIMESTAMP(3),
    "uploadedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answerDelayMs"  INTEGER,
    "sipConnectMs"   INTEGER,
    "pushToUiMs"     INTEGER,
    "hadRingtone"    BOOLEAN NOT NULL DEFAULT false,
    "hadBlankScreen" BOOLEAN NOT NULL DEFAULT false,
    "hadAppRestart"  BOOLEAN NOT NULL DEFAULT false,
    "hadFullScreen"  BOOLEAN NOT NULL DEFAULT false,
    "warningFlags"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "events"         JSONB NOT NULL DEFAULT '[]',
    "aiSummary"      JSONB,

    CONSTRAINT "CallFlightSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CallFlightSession_inviteId_idx"          ON "CallFlightSession"("inviteId");
CREATE INDEX IF NOT EXISTS "CallFlightSession_pbxCallId_idx"         ON "CallFlightSession"("pbxCallId");
CREATE INDEX IF NOT EXISTS "CallFlightSession_tenantId_idx"          ON "CallFlightSession"("tenantId");
CREATE INDEX IF NOT EXISTS "CallFlightSession_userId_idx"            ON "CallFlightSession"("userId");
CREATE INDEX IF NOT EXISTS "CallFlightSession_tenantId_uploadedAt_idx" ON "CallFlightSession"("tenantId", "uploadedAt");
CREATE INDEX IF NOT EXISTS "CallFlightSession_result_idx"            ON "CallFlightSession"("result");
