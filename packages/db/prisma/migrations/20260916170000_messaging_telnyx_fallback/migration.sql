-- Unified messaging Phase 1 (2026-09-16): Telnyx as a chat carrier + the
-- per-number backup route. Additive only — every existing row keeps NULL
-- fallbackProvider, which is byte-identical pre-Phase-1 behaviour.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'TELNYX';

-- AlterTable
ALTER TABLE "TenantSmsNumber" ADD COLUMN "fallbackProvider" "IntegrationProvider";
