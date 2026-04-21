-- Multi-call support: add HELD status + timestamps + ordering field.
--
-- Postgres' enum types require ALTER TYPE ... ADD VALUE to extend them.
-- The new HELD value is inserted between ACCEPTED and DECLINED so the
-- logical ordering of the enum matches its lifecycle.
ALTER TYPE "CallInviteStatus" ADD VALUE IF NOT EXISTS 'HELD' BEFORE 'DECLINED';

ALTER TABLE "CallInvite"
  ADD COLUMN IF NOT EXISTS "heldAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resumedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "stackOrder" INTEGER;

-- Used by GET /mobile/call-invites/active to list active+held for a user,
-- ordered by the LIFO stack position.
CREATE INDEX IF NOT EXISTS "CallInvite_userId_status_stackOrder_idx"
  ON "CallInvite"("userId", "status", "stackOrder");
