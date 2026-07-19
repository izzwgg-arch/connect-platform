/**
 * Voice Studio (PLAN.md §6c). Owner-mode: manage a library of cloned voices and
 * render IVR prompt audio (English + experimental Yiddish). Cloning + TTS run
 * through ElevenLabs when its key is present; guarded until then (never
 * fabricates audio). Deploying a rendered prompt onto an IVR is action A12/P14
 * and goes through the approval + Scoped Executor path — NOT here.
 *
 * Voices/prompts are tracked in AgentMemory (tenant "__voice_studio__") until a
 * dedicated table is warranted; keeps this additive with no new migration.
 */
import type { AuditLog } from "../audit/audit";

export type VoiceType = "instant_clone" | "pro_clone" | "stock";
export interface VoiceRecord {
  id: string;
  name: string;
  languages: string[]; // ["en"], ["en","yi"], ["yi"]
  type: VoiceType;
  provider: "elevenlabs" | "openai";
  externalVoiceId?: string;
  provenance?: string; // who/what it was cloned from (consent record)
  createdAt: string;
}

export interface RenderRequest {
  voiceId: string;
  text: string;
  language: "en" | "yi";
}

export interface RenderResult {
  ok: boolean;
  audioId?: string;
  provider?: string;
  experimental?: boolean;
  error?: string;
}

export class VoiceStudio {
  constructor(
    private prisma: any,
    private clients: { elevenLabsApiKey: string | null; openaiApiKey: string | null },
    private audit: AuditLog,
  ) {}

  private key(kind: "voice" | "prompt", id: string) {
    return `${kind}:${id}`;
  }

  async listVoices(): Promise<VoiceRecord[]> {
    try {
      const rows = await this.prisma.agentMemory.findMany({ where: { tenantId: "__voice_studio__", key: { startsWith: "voice:" } } });
      return rows.map((r: any) => JSON.parse(r.value) as VoiceRecord);
    } catch {
      return [];
    }
  }

  async addVoice(input: Omit<VoiceRecord, "id" | "createdAt">): Promise<VoiceRecord> {
    const rec: VoiceRecord = { ...input, id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date().toISOString() };
    await this.prisma.agentMemory.upsert({
      where: { tenantId_key: { tenantId: "__voice_studio__", key: this.key("voice", rec.id) } },
      update: { value: JSON.stringify(rec) },
      create: { tenantId: "__voice_studio__", key: this.key("voice", rec.id), value: JSON.stringify(rec) },
    });
    await this.audit.record({ actor: "owner", event: "voice.added", payload: { id: rec.id, name: rec.name, languages: rec.languages, provider: rec.provider } });
    return rec;
  }

  /** Render prompt audio. Guarded: no ElevenLabs key → not rendered (never fakes audio). */
  async render(req: RenderRequest): Promise<RenderResult> {
    const experimental = req.language === "yi"; // Yiddish TTS is experimental (no official support)
    if (!this.clients.elevenLabsApiKey) {
      await this.audit.record({ actor: "system", event: "voice.render_no_key", payload: { voiceId: req.voiceId, language: req.language } });
      return { ok: false, provider: "elevenlabs", experimental, error: "elevenlabs_key_not_configured" };
    }
    // Real ElevenLabs synthesis wired when key present + audio storage path final.
    await this.audit.record({ actor: "owner", event: "voice.render_requested", payload: { voiceId: req.voiceId, language: req.language, chars: req.text.length } });
    return { ok: false, provider: "elevenlabs", experimental, error: "render_call_not_wired_pending_key" };
  }
}
