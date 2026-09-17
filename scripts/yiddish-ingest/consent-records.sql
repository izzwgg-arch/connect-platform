-- Integrator recipe (2026-09-17): consent + rights records for the Yiddish
-- Whisper fine-tune (§3.4.4, AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md).
--
-- WHO APPLIES THIS, AND WHY: the main integrator session, and ONLY after Lane
-- A's migration + governance change are live. The new governance rule
-- (governance.ts trainingEligibilityOf) excuses a CUSTOMER_PRIVATE source
-- from the unconditional EXCLUDED rung ONLY when BOTH `YcSource.contentAllowed
-- = true` AND a GRANTED `YcRightsRecord(allowedUse='training_export')` exist
-- for it. This file is what makes that basis real, dated and checkable — a
-- human-recorded decision, never a default the engine reaches for itself. No
-- lane script and no engine code may write a GRANTED row; only this file does.
--
-- OWNER AUTHORITY, quoted verbatim (Izzy, in chat, 2026-09-17 — see §0 of the
-- fine-tune handoff and docs/ai-context/AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md):
--   Yiddish24 (site owner, not Loopcom, cleared it):        "Yiddish 24 is good."
--   Voicemail + call recordings (Izzy, as carrier/owner):   "I have already
--     cleared it with them... do what I tell you."
--
-- ⛔ Yiddish Labs (`yiddishlabs_cache`) gets NO row here and never should —
-- it stays permanently EXCLUDED / serving-only, by contract, whatever this
-- file does to any other source.
-- ⛔ `trainingExportEligibility` on YcSource is left for the governance ladder
-- to compute at read time — this file never sets it to ALLOWED by hand.
--
-- Idempotent: safe to re-run. `ON CONFLICT DO NOTHING` with no target list
-- catches either the primary key (a literal re-run) or the
-- (sourceId, allowedUse) unique constraint (the same grant reached a
-- different way), so this can never error out re-applying by accident and
-- can never silently overwrite a decision already on file.

BEGIN;

-- ── training_export GRANTED — the basis the governance ladder checks ───────

INSERT INTO "YcRightsRecord" ("id", "sourceId", "allowedUse", "state", "evidence", "decidedBy", "decidedAt")
SELECT 'izzy-20260917-y24-training_export', s.id, 'training_export', 'GRANTED',
       'Izzy, 2026-09-17: "Yiddish 24 is good."',
       'izzy (Loopcom owner, via Claude chat)', now()
FROM "YcSource" s
WHERE s.key = 'yiddish24'
ON CONFLICT DO NOTHING;

INSERT INTO "YcRightsRecord" ("id", "sourceId", "allowedUse", "state", "evidence", "decidedBy", "decidedAt")
SELECT 'izzy-20260917-vm-training_export', s.id, 'training_export', 'GRANTED',
       'Izzy, 2026-09-17 (as carrier/owner): "I have already cleared it with them... do what I tell you."',
       'izzy (Loopcom owner, via Claude chat)', now()
FROM "YcSource" s
WHERE s.key = 'voicemail'
ON CONFLICT DO NOTHING;

INSERT INTO "YcRightsRecord" ("id", "sourceId", "allowedUse", "state", "evidence", "decidedBy", "decidedAt")
SELECT 'izzy-20260917-cr-training_export', s.id, 'training_export', 'GRANTED',
       'Izzy, 2026-09-17 (as carrier/owner): "I have already cleared it with them... do what I tell you."',
       'izzy (Loopcom owner, via Claude chat)', now()
FROM "YcSource" s
WHERE s.key = 'call_recordings'
ON CONFLICT DO NOTHING;

-- ── call_recordings mirrors voicemail's existing analysis + store_audio
-- grants (AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md: "voicemail —
-- analysis + store_audio GRANTED (Izzy as carrier/owner)"). Same owner, same
-- authority, same evidence — call recordings were named in the same breath.

INSERT INTO "YcRightsRecord" ("id", "sourceId", "allowedUse", "state", "evidence", "decidedBy", "decidedAt")
SELECT 'izzy-20260917-cr-analysis', s.id, 'analysis', 'GRANTED',
       'Izzy, 2026-09-17 (as carrier/owner): "I have already cleared it with them... do what I tell you."',
       'izzy (Loopcom owner, via Claude chat)', now()
FROM "YcSource" s
WHERE s.key = 'call_recordings'
ON CONFLICT DO NOTHING;

INSERT INTO "YcRightsRecord" ("id", "sourceId", "allowedUse", "state", "evidence", "decidedBy", "decidedAt")
SELECT 'izzy-20260917-cr-store_audio', s.id, 'store_audio', 'GRANTED',
       'Izzy, 2026-09-17 (as carrier/owner): "I have already cleared it with them... do what I tell you."',
       'izzy (Loopcom owner, via Claude chat)', now()
FROM "YcSource" s
WHERE s.key = 'call_recordings'
ON CONFLICT DO NOTHING;

-- ── open the audio-fetch gate for call_recordings itself ───────────────────
-- Still governed by the rights records above plus the rung in governance.ts —
-- this line alone grants nothing; it only stops being a blanket refusal.

UPDATE "YcSource"
SET "audioFetchMode" = 'OWNER_AUTHORIZED', "contentAllowed" = true
WHERE key = 'call_recordings';

COMMIT;
