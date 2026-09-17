/**
 * Language probe — a pure, cheap pre-check for `call_recordings` items
 * (§3.4.3, AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md).
 *
 * WHY THIS EXISTS: call recordings are ordinary business calls, not a
 * Yiddish-only catalog like Yiddish24 — some fraction of any tenant's calls
 * are plain English. Transcribing a whole English call through Everett only
 * to discard it wastes real money. The design is: transcribe the FIRST ~30
 * seconds with `language: "auto"`, run the detected text through this probe,
 * and only pay for the rest of the call when the probe says Yiddish.
 *
 * The decision logic is a copy of `EverettClient.normalizeLanguage`
 * (`apps/agent/src/transcription/everett.ts`) — same script test, same
 * verdict — but returns a plain-English reason instead of a language tag,
 * because this module's whole job is to explain a SKIP on the queue screen.
 *
 * ⛔ Pure function. No network, no db, no ffmpeg. The caller (Lane A's
 * `transcribe` handler, or a runner pre-stage) does the actual 30-second cut
 * and the actual Everett call; this module only reads the text that came back.
 *
 * TODO (integrator / Lane A): wire this into
 * `apps/api/src/yiddishCorpus/jobs.ts` `defaultStageHandlers.transcribe` (or
 * `everettClient.ts`) for `call_recordings` items specifically: before
 * chunking the whole call, submit the first `YC_LANGUAGE_PROBE_SEC` (default
 * 30) seconds with `language: "auto"`, call `probeDecision(result.text,
 * result.language)`, and if `!decision.yiddish`, write the item SKIPPED with
 * `decision.reason` and return `{ ok: true, skipped: true, reason:
 * decision.reason, advance: false }` — same shape `fetch_audio` already uses
 * for a lawful skip. Yiddish24 and voicemail are UNCHANGED by this (they are
 * either already-known Yiddish, or gated on `transcriptLanguage` upstream);
 * only `call_recordings` needs the probe. Do not run the probe on the whole
 * clip — that defeats the point of the cost saving.
 */

export interface ProbeDecision {
  /** True when the call should keep being transcribed as Yiddish (or mixed). */
  yiddish: boolean;
  /** Plain-English reason, suitable for the item's SKIPPED error/reason field. */
  reason: string;
}

/** Hebrew-script range, same test the platform uses everywhere else (never "he"). */
const HEBREW_RE = /[֐-׿]/;
const LATIN_RE = /[a-z]/i;

/**
 * Decide whether a call is Yiddish enough to keep transcribing, from the text
 * Everett already returned for a short auto-detect pass (and, optionally, the
 * language tag Everett reported alongside it).
 *
 * Mirrors `EverettClient.normalizeLanguage`: Hebrew script is ALWAYS read as
 * Yiddish, never Hebrew ("he" is coerced, never trusted as a verdict of "not
 * Yiddish"). A hint of "auto" or "" is treated as no hint.
 */
export function probeDecision(detectedText: string | undefined, hint?: string): ProbeDecision {
  const h = hint && hint !== "auto" ? (hint === "he" ? "yi" : hint) : undefined;
  const text = String(detectedText ?? "").trim();

  if (h === "yi" || h === "yi-en") {
    return { yiddish: true, reason: `language hint "${h}" — keeping this call` };
  }
  if (h && h !== "yi" && h !== "yi-en") {
    return { yiddish: false, reason: `not Yiddish — language hint reported "${h}"` };
  }

  if (!text) {
    return { yiddish: false, reason: "not Yiddish — no speech was detected in the probe window" };
  }

  const hasHebrew = HEBREW_RE.test(text);
  const hasLatin = LATIN_RE.test(text);

  if (hasHebrew && hasLatin) {
    return { yiddish: true, reason: "mixed Hebrew-script and Latin-script speech — keeping this call (yi-en)" };
  }
  if (hasHebrew) {
    return { yiddish: true, reason: "Hebrew-script speech detected — keeping this call (Yiddish, never Hebrew)" };
  }
  return { yiddish: false, reason: "not Yiddish — the probe window detected only Latin-script (English) speech" };
}
