-- CRM Email reply-tracking backfill — safe, additive, idempotent.
--
-- Background
-- ----------
-- replyTrackingEnabled is set during OAuth callback by checking whether
-- the 'https://www.googleapis.com/auth/gmail.readonly' scope was granted.
-- Prior to Phase 1.5 (June 2026) the UI did not expose the enableReplyTracking
-- flag, so connections created earlier may have the scope already in scopes[]
-- but replyTrackingEnabled=false.  This migration aligns the flag with the
-- already-granted scope so those connections start syncing replies without
-- requiring a full reconnect.
--
-- Safety
-- ------
-- - Read-only guard: only updates rows where gmail.readonly is already present
--   in scopes[].  No new OAuth consents are implied.
-- - Idempotent: re-running is a no-op (WHERE replyTrackingEnabled = false).
-- - Tenant-isolated: operates on all tenants; each row is already tenant-scoped.
-- - No FK changes; no table structure changes.
-- - Reversible: run the Down migration (below) to clear the flag again if needed.

UPDATE "CrmEmailConnection"
SET    "replyTrackingEnabled" = true
WHERE  "replyTrackingEnabled" = false
  AND  'https://www.googleapis.com/auth/gmail.readonly' = ANY("scopes");

-- Down (manual rollback only — not run automatically):
-- UPDATE "CrmEmailConnection"
-- SET    "replyTrackingEnabled" = false
-- WHERE  "replyTrackingEnabled" = true
--   AND  NOT EXISTS (
--     SELECT 1 FROM "AuditLog"
--     WHERE "action" = 'CRM_EMAIL_USER_CONNECTED'
--       AND "entityId" = "CrmEmailConnection"."id"
--   );
-- (Note: a targeted rollback should use a specific timestamp filter, not the
--  general form above.  Manual operator action required.)
