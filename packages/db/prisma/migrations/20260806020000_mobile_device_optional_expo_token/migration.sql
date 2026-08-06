-- Un-hostage the fast push channel from the slow one.
--
-- Until now `MobileDevice.expoPushToken` was NOT NULL, and it is the only key
-- `POST /mobile/devices/register` could upsert on. The native FCM token (the
-- Doze-exempt channel we actually want for call wakes) can ONLY reach the
-- server inside that same call — so a handset whose Expo token fetch failed
-- could not report its working FCM token, and stayed on the deprioritized Expo
-- relay indefinitely. Census 2026-08-06: 8 of 16 active Android devices had no
-- native token on file.
--
-- Postgres treats NULLs as distinct in a unique index, so the existing
-- uniqueness guarantee on real Expo tokens is unchanged. Devices registering
-- without one are identified by (userId, deviceId) instead — verified safe
-- against production first: 94 rows, 0 duplicate pairs, 1 null deviceId.
ALTER TABLE "MobileDevice" ALTER COLUMN "expoPushToken" DROP NOT NULL;

CREATE UNIQUE INDEX "MobileDevice_userId_deviceId_key"
  ON "MobileDevice" ("userId", "deviceId");
