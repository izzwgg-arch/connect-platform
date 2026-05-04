-- Adds the SipKeepAliveService FGS snapshot fields to MobileDevice.
--
-- Both columns are nullable so older app builds that don't report the
-- snapshot stay valid — the admin diagnostics card simply renders "no
-- data yet" until the device hits a newer build.
--
-- keepAliveSnapshot is JSONB so we can grow the shape without further
-- migrations as we add more native diagnostic fields (e.g. last
-- foreground type used, last error class, etc.).

ALTER TABLE "MobileDevice"
  ADD COLUMN "keepAliveSnapshot"   JSONB,
  ADD COLUMN "keepAliveReportedAt" TIMESTAMP(3);
