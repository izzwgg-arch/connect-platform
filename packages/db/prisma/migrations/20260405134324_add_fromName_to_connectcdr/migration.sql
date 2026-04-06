-- Migration: add fromName to ConnectCdr for CNAM support
ALTER TABLE "ConnectCdr" ADD COLUMN IF NOT EXISTS "fromName" TEXT;
