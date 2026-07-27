-- Per-device remote feature flags for the mobile app (remote kill-switch).
-- Currently used for { "standingRegistration": boolean } — the standing SIP
-- registration mode rollout. NULL = all flags off (legacy behavior).
ALTER TABLE "MobileDevice" ADD COLUMN "featureFlags" JSONB;
