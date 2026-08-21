-- Scheduled meetings + the invite list (2026-08-21).
-- Every added column is NULLABLE: existing instant meetings stay valid and
-- behave exactly as before.
ALTER TABLE "VideoMeeting" ADD COLUMN "scheduledStartAt" TIMESTAMP(3);
ALTER TABLE "VideoMeeting" ADD COLUMN "durationMinutes" INTEGER;
ALTER TABLE "VideoMeeting" ADD COLUMN "timezone" TEXT;
ALTER TABLE "VideoMeeting" ADD COLUMN "inviteMessage" TEXT;

-- CreateIndex
CREATE INDEX "VideoMeeting_scheduledStartAt_idx" ON "VideoMeeting"("scheduledStartAt");

-- CreateTable
CREATE TABLE "VideoMeetingInvite" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailedAt" TIMESTAMP(3),

    CONSTRAINT "VideoMeetingInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoMeetingInvite_meetingId_email_key" ON "VideoMeetingInvite"("meetingId", "email");

-- CreateIndex
CREATE INDEX "VideoMeetingInvite_meetingId_idx" ON "VideoMeetingInvite"("meetingId");

-- AddForeignKey (Cascade: deleting a meeting takes its invite list with it)
ALTER TABLE "VideoMeetingInvite" ADD CONSTRAINT "VideoMeetingInvite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "VideoMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
