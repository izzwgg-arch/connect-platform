/**
 * OpenAI speech-to-text for the LIVE MIC (input capture).
 *
 * Yiddish Labs' transcription queue is 20–40s — fine for background call
 * recordings, far too slow for someone speaking to type a message. OpenAI's
 * transcription models return in ~1–3s and auto-detect Yiddish/English, so we
 * use them for the mic. The captured text is editable and, when sent, still
 * flows through the Yiddish Labs translate-bridge — so answer quality is
 * unchanged; only the fast input capture differs.
 *
 * Supported input containers include webm (MediaRecorder default), wav, mp3,
 * m4a, ogg. Model is env-overridable (OPENAI_TRANSCRIBE_MODEL).
 */
export interface OpenAiSttResult {
  text: string;
  model: string;
}

const DEFAULT_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

export async function openaiTranscribe(
  apiKey: string,
  file: Buffer,
  filename = "mic.webm",
  opts: { model?: string; language?: string } = {},
): Promise<OpenAiSttResult> {
  if (!apiKey) throw new Error("openai_not_configured");
  const model = opts.model || DEFAULT_MODEL;
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(file)]), filename);
  fd.append("model", model);
  fd.append("response_format", "json");
  // Language is auto-detected when omitted (handles Yiddish + English). Callers
  // may pass a hint (e.g. "yi") if they already know.
  if (opts.language) fd.append("language", opts.language);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai_stt_failed:${res.status}:${body.slice(0, 160)}`);
  }
  const j: any = await res.json();
  return { text: typeof j.text === "string" ? j.text : "", model };
}
