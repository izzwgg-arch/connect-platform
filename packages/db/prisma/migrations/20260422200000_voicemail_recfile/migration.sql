-- Add pbxRecfile column to store the VitalPBX /static playback path returned by
-- /api/v2/extensions/:id/voicemail_records. The path embeds an auth token so it
-- can be fetched without app-key, which is how audio playback now works.
ALTER TABLE "Voicemail" ADD COLUMN "pbxRecfile" TEXT;
