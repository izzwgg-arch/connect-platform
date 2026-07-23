/**
 * Everett (ivrit.ai) client — Hebrew/Yiddish STT on OUR OWN RunPod serverless
 * endpoint, set up per the ivrit.ai walkthrough video
 * (github.com/ivrit-ai/runpod-serverless). Pay-per-second (~3–4¢ per audio
 * hour), scales to zero when idle.
 *
 * Endpoints (Authorization: Bearer <RunPod API key>, base
 * https://api.runpod.ai/v2/{endpointId}):
 *   POST /runsync       — waits for the result (RunPod caps the wait; if the
 *                         job is still running we poll /status below)
 *   POST /run           — async submit
 *   GET  /status/{id}   — poll status/result
 *
 * Payload (see ivrit-ai/runpod-serverless infer.py):
 *   { input: { engine: "faster-whisper", model, transcribe_args: { blob|url,
 *     language?, diarize? }, streaming: false } }
 * Audio goes as base64 `blob` (runsync request cap ~10MB → keep audio ≤ ~7MB)
 * or as a public `url` for bigger files.
 *
 * Keys live ONLY in the server env (EVERETT_API_KEY + EVERETT_ENDPOINT_ID).
 * This client never logs them. Boots/degrades cleanly with no key.
 */

export interface EverettSegment {
  text: string;
  start: number;
  end: number;
  words?: { word: string; start: number; end: number; probability?: number }[];
}

export interface EverettResult {
  id: string;
  status: "completed" | "failed" | string;
  text?: string;
  language?: string;
  segments?: EverettSegment[];
  /** RunPod worker latency, ms (excludes cold-start delay). */
  executionMs?: number;
  raw?: any;
}

export interface EverettSubmit {
  /** audio bytes (base64'd into the request) — OR a public URL. */
  file?: Buffer;
  url?: string;
  filename?: string;
  /** Whisper language hint ("he" | "yi" | "en"); omit for auto-detect. */
  language?: string;
  diarize?: boolean;
}

const DEFAULT_MODEL = process.env.EVERETT_MODEL || "ivrit-ai/whisper-large-v3-turbo-ct2";
const BASE = process.env.EVERETT_BASE_URL || "https://api.runpod.ai/v2";
/**
 * Language policy: this platform is Yiddish + English ONLY — never Hebrew.
 * The ivrit.ai model is Hebrew-tuned, so if left on auto-detect it can decode
 * Yiddish speech as Modern Hebrew. We therefore decode as Yiddish by default
 * (env-overridable to "en" or "auto"); "he" is always refused.
 */
const DEFAULT_LANGUAGE = process.env.EVERETT_LANGUAGE || "yi";
/** runsync request cap is 10MB; base64 inflates 4/3 → raw audio limit. */
const MAX_BLOB_BYTES = 7 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export class EverettClient {
  constructor(
    private apiKey: string | null,
    private endpointId: string | null,
    private model: string = DEFAULT_MODEL,
  ) {}

  get configured(): boolean {
    return !!this.apiKey && !!this.endpointId;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey ?? ""}`, "Content-Type": "application/json" };
  }

  /**
   * Infer our language tag from the transcript text. This platform is Yiddish +
   * English ONLY — Hebrew-script text is always treated as Yiddish, never "he".
   * A caller hint of "he" is likewise coerced to "yi".
   */
  static normalizeLanguage(text: string | undefined, hint?: string): string | undefined {
    const h = hint && hint !== "auto" ? (hint === "he" ? "yi" : hint) : undefined;
    if (h) return h;
    if (!text) return undefined;
    const hasHebrew = /[֐-׿]/.test(text);
    const hasLatin = /[a-z]/i.test(text);
    if (hasHebrew && hasLatin) return "yi-en";
    if (hasHebrew) return "yi"; // Hebrew script = Yiddish here, never Hebrew
    if (hasLatin) return "en";
    return undefined;
  }

  /** Submit and wait (runsync + status polling for long jobs). */
  async transcribe(input: EverettSubmit): Promise<EverettResult> {
    if (!this.configured) throw new Error("everett_not_configured");
    if (!input.file && !input.url) throw new Error("everett_no_audio");
    if (input.file && input.file.length > MAX_BLOB_BYTES) {
      throw new Error(`everett_audio_too_large:${input.file.length}b_max_${MAX_BLOB_BYTES}b_use_url`);
    }

    const transcribe_args: Record<string, any> = {};
    if (input.file) transcribe_args.blob = input.file.toString("base64");
    else transcribe_args.url = input.url;
    // Never Hebrew: a caller "he" hint is coerced to Yiddish. Fall back to the
    // platform default (Yiddish) when the caller says "auto"/nothing.
    let lang = input.language && input.language !== "auto" ? input.language : DEFAULT_LANGUAGE;
    if (lang === "he") lang = "yi";
    if (lang && lang !== "auto") transcribe_args.language = lang;
    if (input.diarize) transcribe_args.diarize = true;

    const body = JSON.stringify({
      input: { engine: "faster-whisper", model: this.model, transcribe_args, streaming: false },
    });

    const res = await fetch(`${BASE}/${this.endpointId}/runsync`, {
      method: "POST",
      headers: this.headers(),
      body,
    });
    if (!res.ok) throw new Error(`everett runsync failed: ${res.status} ${await safeText(res)}`);
    let j: any = await res.json();

    // Long audio: runsync returns before completion → poll /status/{id}.
    const started = Date.now();
    while (j.status === "IN_QUEUE" || j.status === "IN_PROGRESS") {
      if (Date.now() - started > POLL_TIMEOUT_MS) throw new Error(`everett_timeout:${j.id}`);
      await sleep(POLL_INTERVAL_MS);
      const poll = await fetch(`${BASE}/${this.endpointId}/status/${encodeURIComponent(j.id)}`, {
        headers: this.headers(),
      });
      if (!poll.ok) throw new Error(`everett status failed: ${poll.status}`);
      j = await poll.json();
    }

    return this.parse(j);
  }

  /**
   * Parse a RunPod response. `output` is the list of items the serverless
   * handler yielded; each is { result: [batches] } whose batch entries are
   * { type: "progress" | "segments", data }. We collect the segments.
   */
  private parse(j: any): EverettResult {
    if (j.status !== "COMPLETED") {
      return { id: j.id ?? "", status: "failed", raw: sanitizeRaw(j) };
    }
    const segments: EverettSegment[] = [];
    const outputs = Array.isArray(j.output) ? j.output : [j.output];
    for (const item of outputs) {
      const resultBatches = item?.result;
      const batches = Array.isArray(resultBatches) ? resultBatches.flat() : [];
      for (const entry of batches) {
        if (entry?.type !== "segments" || !Array.isArray(entry.data)) continue;
        for (const s of entry.data) {
          segments.push({ text: s.text ?? "", start: s.start ?? 0, end: s.end ?? 0, words: s.words });
        }
      }
    }
    const text = segments.map((s) => s.text).join("").trim();
    return {
      id: j.id ?? "",
      status: "completed",
      text,
      segments,
      executionMs: j.executionTime,
      raw: undefined, // raw carries the full base64-heavy payload; drop it
    };
  }
}

function sanitizeRaw(j: any): any {
  // Keep only small diagnostic fields — never echo request/audio payloads.
  return { id: j?.id, status: j?.status, error: j?.error, delayTime: j?.delayTime };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
