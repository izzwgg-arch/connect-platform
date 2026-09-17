-- Integrator recipe (2026-09-17): revive the customer-voicemail fetch jobs that were
-- parked (nextRunAt → 2027-01-01) to stop them starving the Yiddish24 download.
-- Apply ONLY after (a) the voicemail source has its own running budget
-- (integrator-budgets.sql) so its jobs ADVANCE instead of deferring every tick,
-- and (b) Izzy has confirmed the customer-audio leg should run.
BEGIN;
UPDATE "YcProcessingJob" j
SET "nextRunAt" = now(), "error" = NULL
FROM "YcSourceItem" i, "YcSource" s
WHERE j."itemId" = i.id AND i."sourceId" = s.id AND s.key = 'voicemail'
  AND j.stage = 'fetch_audio' AND j.state = 'PENDING' AND j."nextRunAt" >= '2026-12-31';
COMMIT;
