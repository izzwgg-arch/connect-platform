/**
 * Reading a support answer out loud (2026-08-21).
 *
 * Izzy: *"Can you make it so that I can play the output as audio? You can use
 * 11 labs. Use Kristen as a voice."*
 *
 * This module is the PURE half — what gets spoken, and which voice — kept
 * apart from the route so it can be tested without a network, a key, or a
 * bill. The route in supportConsole.ts owns the cache, the concurrency slot
 * and the single un-retried POST.
 *
 * ⛔⛔ EVERY CHARACTER THAT LEAVES HERE IS BILLED. That is why the trimming
 * below is not cosmetic: an agent answer is written to be READ, so it arrives
 * full of code fences, file paths and backticks. Sending those verbatim pays
 * ElevenLabs to pronounce `apps/api/src/supportWorkbench.ts` one character at
 * a time, and the listener learns nothing from hearing it.
 */

/**
 * ⛔ Kristen, chosen from the two on the live account (checked, not guessed):
 *   • CvD6hF1BJzAFN428j1cO — "Kristen - Warm, Corporate and Steady"
 *     (middle_aged, informative_educational, confident)   ← this one
 *   • dfeOmy6Uay63tNhyO99j — "Kristen - Natural, Upbeat and Focused"
 *     (young, advertisement, casual)
 * Reading back a diagnosis is informative, not an advert, so the steady one
 * wins. Swapping is this one line.
 */
export const SUPPORT_NARRATION_VOICE_ID = "CvD6hF1BJzAFN428j1cO";
export const SUPPORT_NARRATION_VOICE_NAME = "Kristen";

/** Mirror of MAX_NARRATION_CHARS — the cap is applied here, at the door. */
export const SPEAK_MAX_CHARS = 3_000;

/**
 * Turn a written answer into something worth listening to.
 *
 * ⛔ Code blocks are DROPPED, not read. A fenced block read aloud is a minute
 * of gibberish that costs real money; the listener is looking at the screen
 * where the code already is. They are replaced by a spoken marker so the
 * sentence around them still makes sense.
 */
export function narratableText(raw: string): { text: string; truncated: boolean } {
  let s = String(raw ?? "");

  // Fenced code → a short spoken marker. Done first so nothing inside a fence
  // is mistaken for prose punctuation below.
  s = s.replace(/```[\s\S]*?```/g, " (code block) ");
  // An unterminated fence — a streaming answer cut mid-block — would otherwise
  // survive the pass above and be read character by character.
  s = s.replace(/```[\s\S]*$/g, " (code block) ");

  s = s
    .replace(/`([^`]*)`/g, "$1")            // inline code: keep the word, drop the ticks
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")      // headings
    .replace(/^\s*[-*+]\s+/gm, "")           // bullets
    .replace(/^\s*\d+\.\s+/gm, "")           // numbered lists
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // bold
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1$2") // italics
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1") // links: say the label, not the url
    .replace(/[─-╿▀-▟]/g, " ") // box drawing from terminal output
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")                // paragraph break reads as a pause
    .replace(/\n/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\.\s*\.(\s*\.)+/g, ".")        // "…" and ". . ." collapse to one stop
    .trim();

  // ⛔ A message that is NOTHING but code has no prose left once the fences are
  // dropped, and "code block" is not worth a billed call or a listener's time.
  // Answering with nothing lets the route say so in plain English instead.
  if (!s.replace(/\(code block\)/g, "").replace(/[^a-z0-9]/gi, "")) return { text: "", truncated: false };

  if (s.length <= SPEAK_MAX_CHARS) return { text: s, truncated: false };

  // ⛔ Cut on a SENTENCE boundary. Stopping mid-word sounds like a fault in the
  // product; stopping after a full stop sounds like the end of a thought, and
  // the caller is told it was shortened either way.
  const window = s.slice(0, SPEAK_MAX_CHARS);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  const cut = lastStop > SPEAK_MAX_CHARS * 0.5 ? lastStop + 1 : window.lastIndexOf(" ");
  return { text: window.slice(0, cut > 0 ? cut : SPEAK_MAX_CHARS).trim(), truncated: true };
}

/**
 * A small reply cache — the real cost control.
 *
 * ⛔ Listening to the same answer twice must not bill twice, and replaying is
 * the COMMON case: you play it, miss a sentence, play it again. Keyed on the
 * exact spoken text plus the voice, so a different message can never collide.
 * Bounded and short-lived: this is a convenience, not storage.
 */
const CACHE_MAX = 24;
const CACHE_TTL_MS = 20 * 60 * 1000;
const cache = new Map<string, { mp3: Buffer; at: number }>();

export function narrationCacheGet(key: string): Buffer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so a message being replayed stays warm.
  cache.delete(key);
  cache.set(key, hit);
  return hit.mp3;
}

export function narrationCacheSet(key: string, mp3: Buffer): void {
  cache.set(key, { mp3, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearNarrationCache(): void {
  cache.clear();
}

/**
 * Concurrency slot.
 *
 * ⛔ Same reason the synthesis routes have one: a burst of clicks must not
 * become a burst of paid provider calls. Returns a release function, or null
 * when the gate is full — the caller answers 429 rather than queueing, because
 * a person waiting on a play button would rather be told than watch a spinner.
 */
const MAX_CONCURRENT_SPEAK = 2;
let speakInFlight = 0;

export function takeSpeakSlot(): (() => void) | null {
  if (speakInFlight >= MAX_CONCURRENT_SPEAK) return null;
  speakInFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    speakInFlight -= 1;
  };
}
