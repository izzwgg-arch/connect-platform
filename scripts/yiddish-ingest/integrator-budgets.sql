-- Integrator recipe (2026-09-17): per-source budgets for the Yiddish learning loop.
-- Applied by the main session ONLY after Izzy names a daily cap. Replace the two
-- numbers below (minutes of audio transcribed per day, and cents per day).
--   Everett cost ≈ 3–4¢ per audio HOUR → 600 minutes/day ≈ 40¢/day of transcription.
--   The cents cap also meters any future paid stage through chargeBudget.
-- A source's own budget WINS over the global row (jobs.ts loadBudget), so the
-- global row can stay paused/METADATA_ONLY: only the sources named here run audio.
--
-- Izzy's cap (2026-09-17): $5/day TOTAL. Split: $3/day labelling (below) + ~$2/day
-- averaged GPU training (one 2-hour A100 run every ~2-3 days, enforced by the
-- launcher's --max-hours 2). Everett ≈ 0.07¢/min → the minute caps below cost ≈ 300¢.
--   voicemail        60¢/day   900 min  (15 h — all 37 h of voicemail in ~3 days)
--   call_recordings 160¢/day  2300 min  (38 h — ~810 h of Yiddish-tenant calls in ~3 weeks)
--   yiddish24        80¢/day  1100 min  (18 h — background, never starves the others)
BEGIN;

INSERT INTO "YcBudget" ("id","sourceId","scope","apiCentsPerDay","transcriptionMinutesPerDay",
                        "storageBytesMax","concurrency","requestsPerMinute","mode","paused","updatedAt")
SELECT 'budget-' || s.key, s.id, 'source:' || s.key,
       CASE s.key WHEN 'voicemail' THEN 60 ELSE 160 END,
       CASE s.key WHEN 'voicemail' THEN 900 ELSE 2300 END,
       0, 1, 30, 'FULL', false, now()
FROM "YcSource" s
WHERE s.key IN ('voicemail','call_recordings')
ON CONFLICT ("scope") DO UPDATE
  SET "apiCentsPerDay" = EXCLUDED."apiCentsPerDay",
      "transcriptionMinutesPerDay" = EXCLUDED."transcriptionMinutesPerDay",
      "mode" = 'FULL', "paused" = false, "updatedAt" = now();

-- Yiddish24 already has a FULL, unpaused budget; give it the same caps.
UPDATE "YcBudget" SET "apiCentsPerDay" = 80, "transcriptionMinutesPerDay" = 1100, "updatedAt" = now()
WHERE scope = 'source:yiddish24';

COMMIT;
