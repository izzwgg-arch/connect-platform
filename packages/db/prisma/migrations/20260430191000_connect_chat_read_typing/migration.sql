ALTER TABLE "ConnectChatParticipant"
  ADD COLUMN "lastReadAt" TIMESTAMP(3),
  ADD COLUMN "typingUntil" TIMESTAMP(3);

CREATE INDEX "ConnectChatParticipant_threadId_lastReadAt_idx"
  ON "ConnectChatParticipant"("threadId", "lastReadAt");
