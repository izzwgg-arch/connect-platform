-- Voicemail: team-shared note + timed callback reminder.
-- All columns nullable → non-destructive, safe to run on the live table.

-- Shared note (single editable note per voicemail, visible to the whole team).
ALTER TABLE "Voicemail" ADD COLUMN "note" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "noteUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Voicemail" ADD COLUMN "noteUpdatedByUserId" TEXT;

-- Callback reminder (timed; a dismissible alert fires to the user who set it).
ALTER TABLE "Voicemail" ADD COLUMN "callbackReminderAt" TIMESTAMP(3);
ALTER TABLE "Voicemail" ADD COLUMN "callbackReminderSetById" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "callbackReminderLabel" TEXT;
ALTER TABLE "Voicemail" ADD COLUMN "callbackReminderFiredAt" TIMESTAMP(3);
ALTER TABLE "Voicemail" ADD COLUMN "callbackReminderAckAt" TIMESTAMP(3);

-- Scheduler scans for due, not-yet-fired reminders.
CREATE INDEX "Voicemail_callbackReminderAt_callbackReminderFiredAt_idx"
  ON "Voicemail" ("callbackReminderAt", "callbackReminderFiredAt");
