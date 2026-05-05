-- Capture media metadata on chat attachments so the chat UI can render
-- proper image / voice-note bubbles and the VoIP.ms MMS worker can decide
-- whether an audio attachment needs ffmpeg conversion before submission.
--
-- All columns are nullable (or have a safe default) so existing rows stay
-- valid; no backfill is required. UI code treats missing values as
-- "compute on the fly" (e.g. image-size from headers, decode-once for
-- audio duration).

ALTER TABLE "ConnectChatMessageAttachment"
  ADD COLUMN "mediaKind"  TEXT NOT NULL DEFAULT 'file',
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "width"      INTEGER,
  ADD COLUMN "height"     INTEGER;
