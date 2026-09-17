/**
 * Everett (ivrit.ai) client for the Yiddish Corpus engine's `transcribe` stage.
 *
 * A copy of `apps/agent/src/transcription/everett.ts` (same RunPod serverless
 * payload, same polling shape), narrowed for this one caller:
 *
 *  - Language is ALWAYS "yi". Never "he", never auto-detect, never a caller
 *    override. The base model is Hebrew-tuned; left to guess, it decodes
 *    Yiddish speech as Modern Hebrew. This platform speaks Yiddish + English
 *    only, so every request is pinned to "yi" no matter what.
 *  - `word_timestamps: true` is always set, so a segment's `words` array is
 *    available for the alignment stage and for the eventual dataset builder.
 *  - Configuration comes from `EVERETT_API_KEY` / `EVERETT_ENDPOINT_ID` /
 *    `EVERETT_MODEL`, read fresh via `EverettClient.fromEnv()` rather than
 *    baked in at module load — a worker process's env can be refreshed
 *    without a restart-and-hope, and a test can set/unset it per case.
 *  - `fetch` is injectable (`deps.fetchImpl`), so this module is unit
 *    testable with no network and no RunPod account.
 *  - ⛔ Never logs the API key. `sanitizeRaw` below is the only thing that
 *    ever gets logged from a response, and it never includes the request.
 */

export interface EverettWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface EverettSegment {
  text: string;
  start: number;
  end: number;
  words?: EverettWord[];
  /** faster-whisper's average log-probability for this segment, if given. */
  avgLogprob?: number | null;
  /** faster-whisper's no-speech probability for this segment, if given. */
  noSpeechProb?: number | null;
}

export interface EverettTranscribeResult {
  id: string;
  status: "completed" | "failed" | string;
  text?: string;
  language?: string;
  segments?: EverettSegment[];
  executionMs?: number;
  raw?: any;
}

export interface EverettTranscribeInput {
  /** Audio bytes, base64'd into the request. Keep the chunk small (≤ ~7 MB). */
  file: Buffer;
}

export interface EverettClientDeps {
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so a poll loop does not really sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** runsync request cap is 10MB; base64 inflates 4/3 → raw audio limit. */
const MAX_BLOB_BYTES = 7 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * ⛔ This platform is Yiddish + English ONLY — never Hebrew. Every request
 * this client sends carries this exact language tag; there is no parameter
 * anywhere in this file that can change it to "he" or "auto".
 */
export const EVERETT_LANGUAGE = "yi" as const;

export class EverettClient {
  constructor(
    private apiKey: string | null,
    private endpointId: string | null,
    public readonly model: string,
    private deps: EverettClientDeps = {},
  ) {}

  /** Build a client from the current environment. Reads env fresh — never cached at import time. */
  static fromEnv(deps: EverettClientDeps = {}): EverettClient {
    return new EverettClient(
      process.env.EVERETT_API_KEY || null,
      process.env.EVERETT_ENDPOINT_ID || null,
      process.env.EVERETT_MODEL || "ivrit-ai/whisper-large-v3-turbo-ct2",
      deps,
    );
  }

  get configured(): boolean {
    return !!this.apiKey && !!this.endpointId;
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private get sleepImpl(): (ms: number) => Promise<void> {
    return this.deps.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  private get base(): string {
    return process.env.EVERETT_BASE_URL || "https://api.runpod.ai/v2";
  }

  /** ⛔ Never logs `this.apiKey`. Only ever used to build the one header. */
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey ?? ""}`, "Content-Type": "application/json" };
  }

  /** Submit one chunk and wait for the transcript (runsync + status polling for long chunks). */
  async transcribeChunk(input: EverettTranscribeInput): Promise<EverettTranscribeResult> {
    if (!this.configured) throw new Error("everett_not_configured");
    if (!input.file || !input.file.length) throw new Error("everett_no_audio");
    if (input.file.length > MAX_BLOB_BYTES) {
      throw new Error(`everett_audio_too_large:${input.file.length}b_max_${MAX_BLOB_BYTES}b`);
    }

    const transcribe_args: Record<string, any> = {
      blob: input.file.toString("base64"),
      // ⛔ Always "yi". This is the whole point of this client existing
      // separately from the general-purpose agent one.
      language: EVERETT_LANGUAGE,
      word_timestamps: true,
    };

    const body = JSON.stringify({
      input: { engine: "faster-whisper", model: this.model, transcribe_args, streaming: false },
    });

    const res = await this.fetchImpl(`${this.base}/${this.endpointId}/runsync`, {
      method: "POST",
      headers: this.headers(),
      body,
    });
    if (!res.ok) throw new Error(`everett runsync failed: ${res.status} ${await safeText(res)}`);
    let j: any = await res.json();

    const started = Date.now();
    while (j.status === "IN_QUEUE" || j.status === "IN_PROGRESS") {
      if (Date.now() - started > POLL_TIMEOUT_MS) throw new Error(`everett_timeout:${j.id}`);
      await this.sleepImpl(POLL_INTERVAL_MS);
      const poll = await this.fetchImpl(`${this.base}/${this.endpointId}/status/${encodeURIComponent(j.id)}`, {
        headers: this.headers(),
      });
      if (!poll.ok) throw new Error(`everett status failed: ${poll.status}`);
      j = await poll.json();
    }

    return this.parse(j);
  }

  /**
   * Parse a RunPod response. `output` is the list of items the serverless
   * handler yielded; each is `{ result: [batches] }` whose batch entries are
   * `{ type: "progress" | "segments", data }`. We collect the segments.
   */
  private parse(j: any): EverettTranscribeResult {
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
          segments.push({
            text: s.text ?? "",
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            words: Array.isArray(s.words) ? s.words : undefined,
            avgLogprob: numOrNull(s.avg_logprob ?? s.avgLogprob),
            noSpeechProb: numOrNull(s.no_speech_prob ?? s.noSpeechProb),
          });
        }
      }
    }
    const text = segments.map((s) => s.text).join("").trim();
    return {
      id: j.id ?? "",
      status: "completed",
      text,
      language: EVERETT_LANGUAGE,
      segments,
      executionMs: j.executionTime,
      raw: undefined, // raw carries the full base64-heavy payload; drop it
    };
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeRaw(j: any): any {
  // Keep only small diagnostic fields — never echo request/audio payloads,
  // and never anything that could carry the API key.
  return { id: j?.id, status: j?.status, error: j?.error, delayTime: j?.delayTime };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
