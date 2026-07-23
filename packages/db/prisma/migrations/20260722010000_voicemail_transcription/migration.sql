-- Additive voicemail auto-transcription columns. Nullable; zero impact on
-- existing rows, portal, or the live platform.
ALTER TABLE "Voicemail" ADD COLUMN "transcript" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "transcriptLanguage" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "transcriptEngine" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "transcribedAt" TIMESTAMP(3);
ALTER TABLE "Voicemail" ADD COLUMN "transcriptError" TEXT;
