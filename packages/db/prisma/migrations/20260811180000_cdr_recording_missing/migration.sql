-- ConnectCdr.recordingMissingAt
--
-- recordingPath is captured from the AMI VarSet of __REC_FILENAME /
-- MIXMONITOR_FILENAME. VitalPBX sets that variable on calls it then does NOT
-- record, so a non-null recordingPath proves the dialplan's INTENT to record,
-- never that a file exists. The portal turned that into a play/download button
-- and 44% of them were dead (Trust Bookkeeping, August 2026: 417 offered, 234
-- real). This column records the calls whose absence the PBX has confirmed, so
-- they stop being offered.
--
-- Nullable and additive: existing rows read as "not yet checked", which is the
-- pre-migration behaviour exactly.
ALTER TABLE "ConnectCdr" ADD COLUMN "recordingMissingAt" TIMESTAMP(3);

-- Partial index: every recording-list query filters on "still believed to have a
-- recording", i.e. recordingPath IS NOT NULL AND recordingMissingAt IS NULL.
CREATE INDEX "ConnectCdr_recording_present_idx"
  ON "ConnectCdr" ("tenantId", "startedAt")
  WHERE "recordingPath" IS NOT NULL AND "recordingMissingAt" IS NULL;
