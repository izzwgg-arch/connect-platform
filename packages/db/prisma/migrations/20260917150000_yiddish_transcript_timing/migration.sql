-- Yiddish Whisper fine-tune, Lane A: per-chunk STT timing on YcTranscript.
-- Additive only — six nullable columns, nothing dropped, nothing renamed.
-- See docs/ai-context/AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md §3.1.1.

ALTER TABLE "YcTranscript" ADD COLUMN "startMs" INTEGER;
ALTER TABLE "YcTranscript" ADD COLUMN "endMs" INTEGER;
ALTER TABLE "YcTranscript" ADD COLUMN "words" JSONB;
ALTER TABLE "YcTranscript" ADD COLUMN "avgLogprob" DOUBLE PRECISION;
ALTER TABLE "YcTranscript" ADD COLUMN "noSpeechProb" DOUBLE PRECISION;
ALTER TABLE "YcTranscript" ADD COLUMN "chunkIndex" INTEGER;
