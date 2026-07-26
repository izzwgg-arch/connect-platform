-- Voicemail-to-email feature.
-- Additive only: new nullable columns + booleans with safe defaults. No backfill,
-- no data rewrite, so it is safe to apply live against the existing backlog.

-- Per-mailbox preferences (default ON, per product decision).
ALTER TABLE "Extension" ADD COLUMN "vmEmailEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Extension" ADD COLUMN "vmEmailIncludeTranscript" BOOLEAN NOT NULL DEFAULT true;

-- Send-tracking on each voicemail. emailedAt stamped once after processing so a
-- message is never emailed twice; emailError holds the skip/fail reason.
ALTER TABLE "Voicemail" ADD COLUMN "emailedAt" TIMESTAMP(3);
ALTER TABLE "Voicemail" ADD COLUMN "emailError" TEXT;
