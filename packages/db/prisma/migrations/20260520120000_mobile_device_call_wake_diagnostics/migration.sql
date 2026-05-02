-- Call-wake diagnostics columns for MobileDevice.
--
-- These power the Android S25 / S24 incoming-call wake debugging surface so we
-- can see, per device:
--   - who the device is (manufacturer + model + osVersion)
--   - when we last sent a push to it
--   - whether the push succeeded, was rejected, or had an Expo/FCM error
--
-- All columns are nullable so existing devices remain valid. No data backfill
-- is required.

ALTER TABLE "MobileDevice"
  ADD COLUMN "manufacturer"    TEXT,
  ADD COLUMN "model"            TEXT,
  ADD COLUMN "osVersion"        TEXT,
  ADD COLUMN "lastPushSentAt"   TIMESTAMP(3),
  ADD COLUMN "lastPushType"     TEXT,
  ADD COLUMN "lastPushStatus"   TEXT,
  ADD COLUMN "lastPushError"    TEXT;

-- Helpful for the per-tenant admin diagnostics view ("show me the most recent
-- push send for each user's devices").
CREATE INDEX "MobileDevice_tenantId_lastPushSentAt_idx"
  ON "MobileDevice"("tenantId", "lastPushSentAt");
