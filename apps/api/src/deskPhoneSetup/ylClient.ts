/**
 * The Yiddish Labs calls the guided setup makes — the same key, base URL and
 * never-retry rule as the order/voicemail lanes (`supermarket/orderYiddish.ts`), with
 * the one action those lanes never needed: English → Yiddish for what the customer reads.
 */

import { loadYiddishLabsKey, ylToEnglish, ylTranscribeSync } from "../supermarket/orderYiddish";
import type { Translator } from "./laybelLanguage";

const YL_BASE = process.env.YIDDISHLABS_BASE_URL || "https://app.yiddishlabs.com/api/v1";
const YL_TEXT_TIMEOUT_MS = 60 * 1000;

/** YL Text Processing: English → Yiddish (`translate-yiddish`, the agent's proven action). */
export async function ylToYiddish(apiKey: string, text: string): Promise<string> {
  const clean = String(text ?? "").trim();
  if (!clean) return "";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), YL_TEXT_TIMEOUT_MS);
  try {
    const res = await fetch(`${YL_BASE}/process/text`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text_content: clean.slice(0, 8000), action: "translate-yiddish" }),
      signal: ctl.signal,
    });
    if (res.status === 402) throw Object.assign(new Error("yl_out_of_credits"), { code: "yl_out_of_credits" });
    if (!res.ok) throw Object.assign(new Error(`yl_translate_failed_${res.status}`), { code: "yl_translate_failed" });
    const j: any = await res.json();
    const out = typeof j.text === "string" ? j.text.trim() : "";
    if (!out) throw Object.assign(new Error("yl_empty_translation"), { code: "yl_empty_translation" });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** A translator bound to the stored key, or null when YL is not configured. */
export async function laybelTranslator(db: any): Promise<{ translator: Translator; apiKey: string } | null> {
  const apiKey = await loadYiddishLabsKey(db).catch(() => null);
  if (!apiKey) return null;
  return {
    apiKey,
    translator: {
      toEnglish: (t) => ylToEnglish(apiKey, t),
      toYiddish: (t) => ylToYiddish(apiKey, t),
    },
  };
}

export { ylTranscribeSync };
