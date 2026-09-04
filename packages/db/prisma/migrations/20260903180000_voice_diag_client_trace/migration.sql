-- AlterEnum
-- Web/desktop softphone client trace: one event type, structured by payload.kind.
-- Additive only — no table, no column, no row is touched.
ALTER TYPE "VoiceDiagEventType" ADD VALUE 'CLIENT_TRACE';
