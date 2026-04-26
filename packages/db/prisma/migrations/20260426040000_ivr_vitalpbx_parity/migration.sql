-- IVR feature-parity with VitalPBX:
--   * directDialEnabled       — enable dial-by-extension during IVR
--   * pbxRetryPromptRef       — VitalPBX-parity retry prompt
--   * invalidDestinationType  — per-profile destination after max retries (invalid)
--   * invalidDestinationRef   — CEP or E.164
--   * timeoutDestinationType  — same, for WaitExten timeouts
--   * timeoutDestinationRef
--
-- All fields are nullable/default so existing rows stay functional. Profiles
-- that don't opt in continue to fall through to [connect-default-fallback]
-- after max retries, identical to pre-migration behavior.

ALTER TABLE "IvrRouteProfile"
  ADD COLUMN IF NOT EXISTS "directDialEnabled"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pbxRetryPromptRef"      TEXT,
  ADD COLUMN IF NOT EXISTS "invalidDestinationType" TEXT,
  ADD COLUMN IF NOT EXISTS "invalidDestinationRef"  TEXT,
  ADD COLUMN IF NOT EXISTS "timeoutDestinationType" TEXT,
  ADD COLUMN IF NOT EXISTS "timeoutDestinationRef"  TEXT;
