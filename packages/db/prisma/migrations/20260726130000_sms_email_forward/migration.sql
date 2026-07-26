-- SMS-to-Email feature (Part 1: per-user toggle).
-- Additive only: one new boolean with a safe default. No backfill, no data
-- rewrite, so it is safe to apply live.

-- Per-user preference (default OFF; users opt in from the Quick Controls panel).
ALTER TABLE "User" ADD COLUMN "smsEmailForwardEnabled" BOOLEAN NOT NULL DEFAULT false;
