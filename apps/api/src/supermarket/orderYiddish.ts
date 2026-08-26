/**
 * Yiddish Labs lane for ORDER drafts (Izzy, 2026-08-26): "The older orders
 * need to be transcribed with Yiddish Labs ONLY... then translate it from
 * Yiddish to English with Yiddish Labs. If the text message comes in Yiddish,
 * then translate it with Yiddish Labs to English and then fill in the orders."
 *
 * So the order pipeline is: voicemail AUDIO → YL sync transcription (Yiddish
 * text) → YL translate-english (English text) → the matcher/brain. A Yiddish
 * TEXT message goes straight to YL translate-english. English input passes
 * through untouched.
 *
 * ⛔ Rules bought elsewhere in this repo:
 *  - the YL key lives in the encrypted AgentSecret store (row
 *    "yiddishlabs_api_key", valueEnc via @connect/security) with the env
 *    fallback — the same resolution order the agent uses. Never log it.
 *  - YL bills per credit and audio is the expensive kind — a transcription is
 *    attempted ONCE per source, never retried in a loop, and failure degrades
 *    to the existing transcript rather than blocking the draft (a draft with
 *    a worse transcript beats no draft).
 *  - a 402 means the ACCOUNT IS OUT OF CREDITS, not a broken key — surface it
 *    as its own status so nobody re-pastes the key
 *    ([[yiddish-labs-out-of-credits]]).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const YL_BASE = process.env.YIDDISHLABS_BASE_URL || "https://app.yiddishlabs.com/api/v1";
const YL_SYNC_TIMEOUT_MS = 5 * 60 * 1000; // their sync endpoint waits for ≤5-min audio
const YL_TEXT_TIMEOUT_MS = 60 * 1000;

export type YlOrderText = {
  /** What the customer actually said/typed (Yiddish or English). */
  transcript: string;
  /** The English the matcher/brain works on ("" when transcript is already English). */
  translation: string;
  /** Which engine produced it — honest provenance for the review screen. */
  engine: "yiddishlabs" | "yiddishlabs_text" | "passthrough" | "fallback";
  error?: string;
};

export function hasHebrewScript(text: string): boolean {
  return /[֐-׿]/.test(String(text ?? ""));
}

/** The stored YL key: AgentSecret row first (the agent's own store), env fallback. */
export async function loadYiddishLabsKey(db: any): Promise<string | null> {
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: "yiddishlabs_api_key" } });
      if (row?.valueEnc) {
        const val = sec.decryptJson<string>(row.valueEnc);
        if (typeof val === "string" && val.trim().length > 8) return val.trim();
      }
    }
  } catch {
    /* fall through to env */
  }
  const env = String(process.env.YIDDISHLABS_API_KEY ?? "").trim();
  if (env && !/paste|your-?key/i.test(env)) return env;
  return null;
}

async function ylFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One sync transcription. Returns the text or throws { code } — NEVER retried. */
export async function ylTranscribeSync(apiKey: string, audio: Buffer, filename: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(audio)]), filename);
  fd.append("language", "auto");
  const res = await ylFetch(`${YL_BASE}/transcriptions/sync`, { method: "POST", headers: { "X-API-KEY": apiKey }, body: fd }, YL_SYNC_TIMEOUT_MS);
  if (res.status === 402) throw Object.assign(new Error("yl_out_of_credits"), { code: "yl_out_of_credits" });
  if (!res.ok) throw Object.assign(new Error(`yl_transcribe_failed_${res.status}`), { code: "yl_transcribe_failed" });
  const j: any = await res.json();
  const text = typeof j.text === "string" ? j.text.trim() : "";
  if (!text) throw Object.assign(new Error("yl_empty_transcript"), { code: "yl_empty_transcript" });
  return text;
}

/** YL Text Processing: anything → English. Source auto-detected by YL. */
export async function ylToEnglish(apiKey: string, text: string): Promise<string> {
  const clean = String(text ?? "").trim();
  if (!clean) return "";
  const res = await ylFetch(
    `${YL_BASE}/process/text`,
    {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text_content: clean.slice(0, 8000), action: "translate-english" }),
    },
    YL_TEXT_TIMEOUT_MS,
  );
  if (res.status === 402) throw Object.assign(new Error("yl_out_of_credits"), { code: "yl_out_of_credits" });
  if (!res.ok) throw Object.assign(new Error(`yl_translate_failed_${res.status}`), { code: "yl_translate_failed" });
  const j: any = await res.json();
  const out = typeof j.text === "string" ? j.text.trim() : "";
  if (!out) throw Object.assign(new Error("yl_empty_translation"), { code: "yl_empty_translation" });
  return out;
}

/** Where a voicemail's audio lives locally (the 2026-08-12 local audio store). */
export function voicemailLocalAudioFile(localAudioPath: string | null | undefined): string | null {
  const name = String(localAudioPath ?? "").trim();
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  const dir = String(process.env.VOICEMAIL_AUDIO_STORAGE_DIR ?? "").trim();
  if (!dir) return null;
  return path.join(dir, name);
}

export type PrepareInput = {
  kind: "voicemail" | "text";
  /** The existing transcript / message body. */
  text: string;
  /** Voicemail only: the local audio file name (Voicemail.localAudioPath). */
  localAudioPath?: string | null;
  voicemailId?: string;
};

export type YlDeps = {
  db: any;
  /** injected for tests */
  transcribe?: typeof ylTranscribeSync;
  translate?: typeof ylToEnglish;
  readAudio?: (filePath: string) => Promise<Buffer>;
  keyLoader?: typeof loadYiddishLabsKey;
};

/**
 * Produce the order text pair for a source, per Izzy's rule.
 * Degradation ladder (never blocks a draft):
 *  1. voicemail + local audio + key → YL transcribe → YL translate.
 *  2. no audio / transcribe failed → the EXISTING transcript; if it carries
 *     Hebrew script → YL translate; else passthrough.
 *  3. no key / translate failed → the raw text, engine "fallback", error set.
 */
export async function prepareOrderText(deps: YlDeps, input: PrepareInput): Promise<YlOrderText> {
  const keyLoader = deps.keyLoader ?? loadYiddishLabsKey;
  const transcribe = deps.transcribe ?? ylTranscribeSync;
  const translate = deps.translate ?? ylToEnglish;
  const readAudio = deps.readAudio ?? ((p: string) => readFile(p));
  const raw = String(input.text ?? "").trim();

  const key = await keyLoader(deps.db);
  if (!key) {
    return { transcript: raw, translation: "", engine: "fallback", error: "yl_not_configured" };
  }

  let transcript = raw;
  let engine: YlOrderText["engine"] = "passthrough";
  let error: string | undefined;

  if (input.kind === "voicemail") {
    const file = voicemailLocalAudioFile(input.localAudioPath);
    if (file) {
      try {
        const audio = await readAudio(file);
        transcript = await transcribe(key, audio, `${input.voicemailId ?? "vm"}${path.extname(file) || ".wav"}`);
        engine = "yiddishlabs";
      } catch (err: any) {
        // once, never retried — fall back to the stored transcript
        error = String(err?.code ?? err?.message ?? "yl_transcribe_failed").slice(0, 80);
        transcript = raw;
        engine = "fallback";
      }
    }
  }

  if (!transcript) return { transcript: "", translation: "", engine, error: error ?? "empty_source" };

  // English already? passthrough — YL credits are not spent re-translating English.
  if (!hasHebrewScript(transcript)) {
    return { transcript, translation: "", engine: engine === "yiddishlabs" ? "yiddishlabs" : "passthrough", error };
  }

  try {
    const english = await translate(key, transcript);
    return {
      transcript,
      translation: english,
      engine: engine === "yiddishlabs" ? "yiddishlabs" : "yiddishlabs_text",
      error,
    };
  } catch (err: any) {
    return {
      transcript,
      translation: "",
      engine: "fallback",
      error: String(err?.code ?? err?.message ?? "yl_translate_failed").slice(0, 80),
    };
  }
}
