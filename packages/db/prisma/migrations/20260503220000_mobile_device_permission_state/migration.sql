-- Per-device runtime-permission snapshot for MobileDevice.
--
-- Powers /admin/call-wake-diagnostics so an operator can tell, without
-- having the device in hand, whether the device is missing RECORD_AUDIO
-- (incoming calls answer-then-disconnect) or POST_NOTIFICATIONS (heads-up
-- ringer + lock-screen full-screen intent suppressed).
--
-- All columns nullable so existing devices remain valid; the mobile app
-- starts populating them on the next /mobile/devices/register call (which
-- fires on every app start, push token refresh, and after the user grants
-- a permission via the proactive prompt in SipContext).

ALTER TABLE "MobileDevice"
  ADD COLUMN "permRecordAudio"        BOOLEAN,
  ADD COLUMN "permNotifications"      BOOLEAN,
  ADD COLUMN "permissionsReportedAt"  TIMESTAMP(3);
