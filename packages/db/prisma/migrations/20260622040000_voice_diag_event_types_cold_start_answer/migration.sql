-- Phase 7c: extend VoiceDiagEventType with the iOS cold-start incoming-call answer
-- telemetry the mobile client already emits. Before this, the API Zod layer accepted
-- "UI_SHOWN"/"PUSH_RECEIVED" but the Prisma enum did not (→ 500 PrismaClientValidationError
-- on every cold-start incoming call), and the remaining cold-start answer events were
-- rejected at the Zod layer (→ 400). Both dropped the telemetry needed to debug the
-- "answers but doesn't connect" cold-killed path.
--
-- Additive only (ALTER TYPE ... ADD VALUE IF NOT EXISTS) — safe, no data rewrite, and
-- idempotent so re-running is harmless.
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'PUSH_RECEIVED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'UI_SHOWN';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'INCOMING_PUSH_RECEIVED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'CALLKEEP_UI_SHOWN';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'CALLKEEP_ANSWER_TAPPED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'APP_FOREGROUNDED_FROM_CALL';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'INVITE_RESTORED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'INVITE_RESTORE_FAILED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'SIP_ANSWER_REQUESTED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'SIP_ANSWER_SENT';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'SIP_ANSWER_CONFIRMED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'SIP_ANSWER_FAILED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'PBX_CALL_ANSWERED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'PBX_STILL_RINGING_AFTER_ANSWER';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'ANSWER_DESYNC_DETECTED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'UI_SWITCHED_TO_CONNECTING';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'UI_SWITCHED_TO_ACTIVE';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'ANSWER_DEFERRED_AWAITING_SIP';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'ANSWER_DEFERRED_EXECUTED';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'ANSWER_DEFERRED_TIMEOUT';
ALTER TYPE "VoiceDiagEventType" ADD VALUE IF NOT EXISTS 'ANSWER_DEFERRED_STALE_CALL';
