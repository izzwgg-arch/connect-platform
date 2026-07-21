-- Additive, nullable column for the Yiddish translate-bridge English mirror.
-- Safe: no default backfill, no impact on existing rows or the live platform.
ALTER TABLE "AgentMessage" ADD COLUMN "contentEn" TEXT;
