/**
 * Transcription pipeline (PLAN.md §10). Recording → transcript, stored in
 * AgentTranscript, tenant-isolated. Provider abstraction: English via OpenAI
 * Whisper; Yiddish via Everett.ai when its key is present. Language auto-detect
 * chooses the provider. Boots/degrades cleanly with no keys (jobs queue but
 * report "no provider" rather than crash).
 */
export type TranscriptionProvider = "whisper" | "everett" | "none";

export interface TranscriptionResult {
  ok: boolean;
  provider: TranscriptionProvider;
  language?: string;
  text?: string;
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
}

export function chooseProvider(languageHint: "en" | "yi" | "auto" | undefined, clients: ProviderClients): TranscriptionProvider {
  if (languageHint === "yi") return clients.everettApiKey ? "everett" : "none";
  if (languageHint === "en") return clients.openaiApiKey ? "whisper" : "none";
  // auto: prefer whisper (has language detection); fall back to everett.
  if (clients.openaiApiKey) return "whisper";
  if (clients.everettApiKey) return "everett";
  return "none";
}

export class Transcriber {
  constructor(
    private prisma: any,
    private clients: ProviderClients,
    private audit: { record: (e: any) => Promise<boolean> },
  ) {}

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const provider = chooseProvider(input.languageHint, this.clients);
    if (provider === "none") {
      await this.audit.record({ actor: "system", event: "transcribe.no_provider", payload: { recordingId: input.recordingId } });
      return { ok: false, provider, error: "no_transcription_provider_configured" };
    }

    let result: TranscriptionResult;
    try {
      result = provider === "whisper" ? await this.whisper(input) : await this.everett(input);
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
}
