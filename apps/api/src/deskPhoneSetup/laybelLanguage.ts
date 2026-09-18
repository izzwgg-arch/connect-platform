/**
 * Laybel in Yiddish, and Laybel hearing the customer.
 *
 * Izzy, 2026-09-18: "I should be able to select Yiddish also, and the agent should
 * communicate through Yiddish Labs if Yiddish is selected. Add a mic so they can talk."
 *
 * The owner's language contract (Laybel handoff, 2026-09-16): Yiddish Labs transcribes
 * Yiddish speech and translates it into ENGLISH for the same brain; the brain's English
 * answer is translated through YL for what the customer READS, while the original
 * English drives the spoken avatar. This file is exactly that bridge for the wizard:
 *
 *   hear:    audio → YL transcript (auto language) → English for the improviser
 *   render:  the improviser's English → YL Yiddish for the captions/chips
 *
 * ⛔ The brain never reasons in Yiddish and the truth fence runs on the ENGLISH — a
 * translation of a fenced sentence is still fenced. ⛔ YL is never retried (credits);
 * a failure falls back to English on screen, never to silence. ⛔ Pure by injection.
 */

export type LaybelLanguage = "en" | "yi";

export type Translator = {
  toEnglish: (text: string) => Promise<string>;
  toYiddish: (text: string) => Promise<string>;
};

export function hasHebrewScript(text: string): boolean {
  return /[֐-׿]/.test(String(text ?? ""));
}

/**
 * The customer's words as the brain should read them. Yiddish (or any Hebrew-script
 * text) goes through YL to English; English passes straight through. On a YL failure
 * the original text is handed over untouched — the model copes with Yiddish poorly but
 * honestly, and the fence still runs on its English reply.
 */
export async function inboundForBrain(text: string, translator: Translator | null): Promise<{ english: string; translated: boolean }> {
  const clean = String(text ?? "").trim();
  if (!clean || !translator || !hasHebrewScript(clean)) return { english: clean, translated: false };
  try {
    const english = (await translator.toEnglish(clean)).trim();
    return english ? { english, translated: true } : { english: clean, translated: false };
  } catch {
    return { english: clean, translated: false };
  }
}

/** A small in-process cache: the scripted lines and chips repeat on every run. */
const yiddishCache = new Map<string, string>();
const CACHE_MAX = 500;

/**
 * What the customer READS: the English reply rendered in Yiddish when Yiddish is
 * selected. Returns null when nothing could be translated, so the caller shows English.
 */
export async function renderForCustomer(
  reply: { say: string; chips: string[] },
  language: LaybelLanguage,
  translator: Translator | null,
): Promise<{ sayYiddish: string | null; chipsYiddish: string[] | null }> {
  if (language !== "yi" || !translator) return { sayYiddish: null, chipsYiddish: null };
  const one = async (text: string): Promise<string | null> => {
    const key = text.trim();
    if (!key) return null;
    const hit = yiddishCache.get(key);
    if (hit) return hit;
    try {
      const out = (await translator.toYiddish(key)).trim();
      if (!out) return null;
      if (yiddishCache.size >= CACHE_MAX) yiddishCache.delete(yiddishCache.keys().next().value as string);
      yiddishCache.set(key, out);
      return out;
    } catch {
      return null;
    }
  };
  const sayYiddish = await one(reply.say);
  const chipsYiddish = await Promise.all(reply.chips.map(one));
  return { sayYiddish, chipsYiddish: chipsYiddish.every((c) => c !== null) ? (chipsYiddish as string[]) : null };
}

export type Hearing = { transcript: string; english: string; yiddish: boolean };

/**
 * The mic's audio → what the customer said, and what the brain reads. Transcription is
 * YL's own auto-detect (Yiddish or English); a Yiddish transcript is translated for the
 * brain, an English one is used as-is. A transcription failure propagates: the route
 * answers honestly rather than inventing words.
 */
export async function hear(
  audio: Buffer,
  filename: string,
  transcribe: (audio: Buffer, filename: string) => Promise<string>,
  translator: Translator | null,
): Promise<Hearing> {
  const transcript = (await transcribe(audio, filename)).trim();
  const yiddish = hasHebrewScript(transcript);
  const { english } = await inboundForBrain(transcript, translator);
  return { transcript, english, yiddish };
}

/** Test seam: clear the render cache. */
export function _resetYiddishCache(): void { yiddishCache.clear(); }
