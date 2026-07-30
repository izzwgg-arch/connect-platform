-- Native APNs alert-environment device token for iOS direct alert pushes.
-- Reported by the mobile app on /mobile/devices/register (iOS build 26+).
ALTER TABLE "MobileDevice" ADD COLUMN "apnsAlertToken" TEXT;
