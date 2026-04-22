-- Null out recordingPath values that were computed with the old deterministic
-- formula (YYYY/MM/DD/<linkedId>.wav). Those don't correspond to real files on
-- the PBX; leaving them would make the UI show a Play button that 404s.
UPDATE "ConnectCdr"
   SET "recordingPath" = NULL
 WHERE "recordingPath" IS NOT NULL
   AND "recordingPath" NOT LIKE '/var/spool/asterisk/monitor/%';

SELECT COUNT(*) AS still_with_path,
       COUNT(*) FILTER (WHERE "recordingPath" LIKE '/var/spool/asterisk/monitor/%') AS valid_absolute
  FROM "ConnectCdr"
 WHERE "recordingPath" IS NOT NULL;
