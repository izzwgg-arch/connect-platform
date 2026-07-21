/**
 * Yiddish Labs client (docs/ai-support-agent/YIDDISHLABS_INTEGRATION.md).
 * Advanced Yiddish↔English transcription with automatic language detection.
 *
 * Endpoints (X-API-KEY header, base https://app.yiddishlabs.com/api/v1):
 *   POST /transcriptions        — async job (any length) → webhook/poll
 *   POST /transcriptions/sync   — waits for result when audio ≤ 5 min
 *   GET  /transcriptions/:id     — poll status/result
 *   POST /process/text          — Text Processing API: grammar / rewrite /
 *                                 translate (source auto-detected, target set
 *                                 by `action`). This is the translate-bridge:
 *                                 Yiddish text ↔ English text, both ways.
 *
 * language "auto" detects Yiddish vs English (also he / lk). The `context`
 * field is fed our dialect glossary so heimishe terms transcribe right.
 *
 * The key lives ONLY in the server env (YIDDISHLABS_API_KEY). This client never
 * logs it. Boots/degrades cleanly with no key.
 */
export type YLLanguage = "auto" | "yi" | "en" | "he" | "lk";

/** Text Processing API actions. Translation is by TARGET (source auto-detected). */
export type YLProcessAction =
  | "fix_grammar"
  | "rewrite"
  | "translate-yiddish"
  | "translate-english"
  | "translate-hebrew"
  | "translate-lk";

export interface YLProcessResult {
  text: string;
  creditsConsumed: number;
  raw?: any;
}

export interface YLResult {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | string;
  text?: string;
  summary?: string | null;
  keywords?: string[];
  language?: string; // detected language if the API reports it
  durationSeconds?: number;
  creditsCost?: number;
  wordCount?: number;
  raw?: any;
}

export interface YLSubmit {
  /** audio bytes + filename (multipart). */
  file: Buffer | Blob;
  filename: string;
  name?: string;
  /** bias terms — we pass the dialect glossary here. */
  context?: string;
  language?: YLLanguage; // default "auto"
  rapid?: boolean;
  webhookUrl?: string;
  timestamps?: boolean;
}

const BASE = process.env.YIDDISHLABS_BASE_URL || "https://app.yiddishlabs.com/api/v1";

export class YiddishLabsClient {
  constructor(private apiKey: string | null) {}

  get configured(): boolean {
    return !!this.apiKey;
  }

  private headers(): Record<string, string> {
    return { "X-API-KEY": this.apiKey ?? "" };
  }

  /** Detect the language the API reports, normalized to our tags. */
  static normalizeLanguage(res: YLResult): "yi" | "en" | "he" | "lk" | "yi-en" | undefined {
    const l = (res.language ?? "").toLowerCase();
    if (l === "yi" || l === "en" || l === "he" || l === "lk") return l as any;
    // If not reported, infer from text (Hebrew script + latin mix → yi-en).
    if (res.text) {
      const hasHebrew = /[֐-׿]/.test(res.text);
      const hasLatin = /[a-z]/i.test(res.text);
      if (hasHebrew && hasLatin) return "yi-en";
      if (hasHebrew) return "yi";
      if (hasLatin) return "en";
    }
    return undefined;
  }

  private form(input: YLSubmit): FormData {
    const fd = new FormData();
    const blob = input.file instanceof Blob ? input.file : new Blob([new Uint8Array(input.file)]);
    fd.append("file", blob, input.filename);
    if (input.name) fd.append("name", input.name);
    if (input.context) fd.append("context", input.context);
    fd.append("language", input.language ?? "auto");
    if (input.rapid) fd.append("rapid", "true");
    if (input.webhookUrl) fd.append("webhook_url", input.webhookUrl);
    return fd;
  }

  private parse(j: any): YLResult {
    return {
      id: j.id,
      status: j.status,
      text: j.text,
      summary: j.summary ?? null,
      keywords: j.keywords ?? [],
      language: j.language,
      durationSeconds: j.duration_seconds,
      creditsCost: j.credits_cost,
      wordCount: j.word_count,
      raw: j,
    };
  }

  /** Async submit (any length). Result arrives via webhook or poll. */
  async submit(input: YLSubmit): Promise<YLResult> {
    if (!this.apiKey) throw new Error("yiddishlabs_not_configured");
    const url = `${BASE}/transcriptions${input.timestamps ? "?timestamps=true" : ""}`;
    const res = await fetch(url, { method: "POST", headers: this.headers(), body: this.form(input) });
    if (!res.ok) throw new Error(`yiddishlabs submit failed: ${res.status} ${await safeText(res)}`);
    return this.parse(await res.json());
  }

  /** Synchronous (waits) — best for calls ≤ 5 min. Longer → async response. */
  async submitSync(input: YLSubmit): Promise<YLResult> {
    if (!this.apiKey) throw new Error("yiddishlabs_not_configured");
    const url = `${BASE}/transcriptions/sync${input.timestamps ? "?timestamps=true" : ""}`;
    const res = await fetch(url, { method: "POST", headers: this.headers(), body: this.form(input) });
    if (!res.ok) throw new Error(`yiddishlabs sync failed: ${res.status} ${await safeText(res)}`);
    return this.parse(await res.json());
  }

  async get(id: string, timestamps = false): Promise<YLResult> {
    if (!this.apiKey) throw new Error("yiddishlabs_not_configured");
    const url = `${BASE}/transcriptions/${encodeURIComponent(id)}${timestamps ? "?timestamps=true" : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`yiddishlabs get failed: ${res.status}`);
    return this.parse(await res.json());
  }

  // ── Text Processing API (translate-bridge) ──────────────────────────────

  /**
   * Text Processing API — grammar fix / rewrite / translate. Source language
   * is auto-detected; `action` selects the operation (and, for translation,
   * the target language). Returns the processed text + credits consumed.
   */
  async processText(textContent: string, action: YLProcessAction): Promise<YLProcessResult> {
    if (!this.apiKey) throw new Error("yiddishlabs_not_configured");
    const text = (textContent ?? "").trim();
    if (!text) return { text: "", creditsConsumed: 0 };
    const res = await fetch(`${BASE}/process/text`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text_content: text, action }),
    });
    if (!res.ok) throw new Error(`yiddishlabs process failed: ${res.status} ${await safeText(res)}`);
    const j: any = await res.json();
    return { text: typeof j.text === "string" ? j.text : "", creditsConsumed: j.credits_consumed ?? 0, raw: j };
  }

  /** Translate text INTO the target language (source auto-detected by YL). */
  async translate(text: string, target: "yi" | "en" | "he" | "lk"): Promise<YLProcessResult> {
    const map: Record<typeof target, YLProcessAction> = {
      yi: "translate-yiddish",
      en: "translate-english",
      he: "translate-hebrew",
      lk: "translate-lk",
    };
    return this.processText(text, map[target]);
  }

  /** Convenience: any language → English (for the LLM to reason on). */
  toEnglish(text: string): Promise<YLProcessResult> {
    return this.translate(text, "en");
  }

  /** Convenience: English → Yiddish (what the customer reads/hears). */
  toYiddish(text: string): Promise<YLProcessResult> {
    return this.translate(text, "yi");
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
