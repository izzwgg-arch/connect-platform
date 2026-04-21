-- Add recordingStatus to ConnectCdr
ALTER TABLE "ConnectCdr" ADD COLUMN "recordingStatus" TEXT NOT NULL DEFAULT 'none';

-- Index for recording resolution worker
CREATE INDEX "ConnectCdr_recordingStatus_endedAt_idx" ON "ConnectCdr"("recordingStatus", "endedAt");

-- Create CallRecording table
CREATE TABLE "CallRecording" (
    "id"          TEXT NOT NULL,
    "linkedId"    TEXT NOT NULL,
    "tenantId"    TEXT,
    "extension"   TEXT,
    "pbxCdrId"    TEXT,
    "pbxFilePath" TEXT,
    "pbxFileDate" TEXT,
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes"   INTEGER,
    "attempts"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt"     TIMESTAMP(3),
    "deletedAt"   TIMESTAMP(3),

    CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallRecording_linkedId_key"   ON "CallRecording"("linkedId");
CREATE INDEX "CallRecording_tenantId_idx"          ON "CallRecording"("tenantId");
CREATE INDEX "CallRecording_extension_idx"         ON "CallRecording"("extension");
CREATE INDEX "CallRecording_status_idx"            ON "CallRecording"("status");
CREATE INDEX "CallRecording_createdAt_idx"         ON "CallRecording"("createdAt");
CREATE INDEX "CallRecording_status_createdAt_idx"  ON "CallRecording"("status", "createdAt");

-- FK from CallRecording → ConnectCdr
ALTER TABLE "CallRecording"
    ADD CONSTRAINT "CallRecording_linkedId_fkey"
    FOREIGN KEY ("linkedId")
    REFERENCES "ConnectCdr"("linkedId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
