-- "Fix it!" by text: an escalation can carry a draft action plus a one-time
-- code the owner texts back to approve it. The code is stored only as a hash —
-- the SMS is the only place it exists in the clear.
ALTER TABLE "AgentEscalation"
  ADD COLUMN "fixActionId" TEXT,
  ADD COLUMN "fixCodeHash" TEXT,
  ADD COLUMN "fixCodeExpiresAt" TIMESTAMP(3),
  ADD COLUMN "fixCodeUsedAt" TIMESTAMP(3),
  ADD COLUMN "fixApprovedFrom" TEXT,
  ADD COLUMN "fixStatus" TEXT,
  ADD COLUMN "fixResult" TEXT,
  ADD COLUMN "fixAttempts" INTEGER NOT NULL DEFAULT 0;

-- Unique so a code can only ever identify one escalation, and so the claim can
-- be made atomically against this column.
CREATE UNIQUE INDEX "AgentEscalation_fixCodeHash_key" ON "AgentEscalation"("fixCodeHash");
