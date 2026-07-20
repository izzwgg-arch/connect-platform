/**
 * Transcription pipeline (PLAN.md §10). Recording → transcript, stored in
 * AgentTranscript, tenant-isolated. Provider abstraction: English via OpenAI
 * Whisper; Yiddish via Everett.ai when its key is present. Language auto-detect
 * chooses the provider. Boots/degrades cleanly with no keys (jobs queue but
 * report "no provider" rather than crash).
 */
export type TranscriptionProvider = "whisper" | "everett" | "yiddishlabs" | "none";

export interface TranscriptionResult {
  ok: boolean;
  provider: TranscriptionProvider;
  language?: string;
  text?: string;
  summary?: string | null;
  keywords?: string[];
  error?: string;
}

export interface TranscriptionInput {
  recordingId: string;
  tenantId?: string | null;
  /** URL or local path to the audio. */
  audioRef: string;
  /** Hint if known ("en" | "yi"); else auto. */
  languageHint?: "en" | "yi" | "auto";
}

export interface ProviderClients {
  openaiApiKey: string | null;
  everettApiKey: string | null;
  yiddishLabsApiKey?: string | null;
}

export function chooseProvider(languageHint: "en" | "yi" | "auto" | undefined, clients: ProviderClients): TranscriptionProvider {
  // Yiddish Labs is the preferred provider for Yiddish AND auto-detect (it
  // natively detects yi/en/he/lk and is tuned for heimishe Yiddish).
  if (languageHint === "yi") return clients.yiddishLabsApiKey ? "yiddishlabs" : clients.everettApiKey ? "everett" : "none";
  if (languageHint === "en") return clients.openaiApiKey ? "whisper" : clients.yiddishLabsApiKey ? "yiddishlabs" : "none";
  // auto: prefer Yiddish Labs (best Yiddish/English detection for this audience);
  // fall back to whisper, then everett.
  if (clients.yiddishLabsApiKey) return "yiddishlabs";
  if (clients.openaiApiKey) return "whisper";
  if (clients.everettApiKey) return "everett";
  return "none";
}

export class Transcriber {
  constructor(
    private prisma: any,
    private clients: ProviderClients,
    private audit: { record: (e: any) => Promise<boolean> },
    /** optional: returns a short "context" string (dialect glossary) to bias STT. */
    private context?: () => Promise<string>,
  ) {}

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const provider = chooseProvider(input.languageHint, this.clients);
    if (provider === "none") {
      await this.audit.record({ actor: "system", event: "transcribe.no_provider", payload: { recordingId: input.recordingId } });
      return { ok: false, provider, error: "no_transcription_provider_configured" };
    }

    let result: TranscriptionResult;
    try {
      result = provider === "whisper" ? await this.whisper(input) : provider === "yiddishlabs" ? await this.yiddishlabs(input) : await this.everett(input);
    } catch (err) {
      await this.audit.record({ actor: "system", event: "transcribe.error", payload: { recordingId: input.recordingId, provider, error: String(err) } });
      return { ok: false, provider, error: String(err) };
    }

    if (result.ok && result.text) {
      try {
        await this.prisma.agentTranscript.upsert({
          where: { recordingId: input.recordingId },
          update: { text: result.text, language: result.language, model: provider },
          create: { recordingId: input.recordingId, tenantId: input.tenantId ?? null, text: result.text, language: result.language, model: provider },
        });
      } catch (err) {
        // Storage failure shouldn't lose the transcript signal.
        await this.audit.record({ actor: "system", event: "transcribe.store_failed", payload: { recordingId: input.recordingId, error: String(err) } });
      }
      await this.audit.record({ actor: "agent", event: "transcribe.done", tenantId: input.tenantId ?? undefined, payload: { recordingId: input.recordingId, provider, chars: result.text.length } });
    }
    return result;
  }

  private async whisper(input: TranscriptionInput): Promise<TranscriptionResult> {
    // Placeholder wiring for OpenAI Whisper. Real call added when key present +
    // audio fetch path finalized; kept behind the key check so it never runs
    // without credentials.
    if (!this.clients.openaiApiKey) return { ok: false, provider: "whisper", error: "no_key" };
    return { ok: false, provider: "whisper", error: "whisper_call_not_wired_pending_key" };
  }

  private async everett(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!this.clients.everettApiKey) return { ok: false, provider: "everett", error: "no_key" };
    return { ok: false, provider: "everett", error: "everett_call_not_wired_pending_key" };
  }

  /**
   * Yiddish Labs — auto-detect + transcribe. Reads the audio at audioRef,
   * submits synchronously (best for calls ≤5 min; longer returns async and the
   * webhook completes it), feeds the dialect glossary as `context`.
   */
  private async yiddishlabs(input: TranscriptionInput): Promise<TranscriptionResult> {
    const key = this.clients.yiddishLabsApiKey ?? null;
    if (!key) return { ok: false, provider: "yiddishlabs", error: "no_key" };
    const { YiddishLabsClient } = await import("./yiddishlabs");
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    let file: Buffer;
    try {
      file = await readFile(input.audioRef);
    } catch (err) {
      return { ok: false, provider: "yiddishlabs", error: `audio_read_failed: ${String(err)}` };
    }
    const client = new YiddishLabsClient(key);
    const context = this.context ? await this.context() : undefined;
    const res = await client.submitSync({
      file,
      filename: path.basename(input.audioRef),
      name: input.recordingId,
      language: input.languageHint === "en" ? "en" : input.languageHint === "yi" ? "yi" : "auto",
      context,
      rapid: true,
      webhookUrl: process.env.YIDDISHLABS_WEBHOOK_URL || undefined,
    });
    if (res.status === "completed" && res.text) {
      return { ok: true, provider: "yiddishlabs", text: res.text, language: YiddishLabsClient.normalizeLanguage(res), summary: res.summary, keywords: res.keywords };
    }
    // Long audio → async; the webhook will complete it. Report queued (not an error).
    return { ok: false, provider: "yiddishlabs", error: `async_queued:${res.id}` };
  }
}
