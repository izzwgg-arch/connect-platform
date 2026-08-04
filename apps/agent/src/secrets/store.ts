/**
 * SecretStore — owner-managed API keys entered from the Assistant page, stored
 * encrypted at rest (AES-256-GCM via @connect/security) in AgentSecret.
 *
 * Rules:
 *  - Values are WRITE-ONLY from the UI: set() accepts a plaintext key, get()
 *    is server-side only, and there is NO endpoint that returns a value.
 *  - The agent resolves each key from the store first, falling back to env.
 *  - Never logged. status() reports only which keys are set + a masked hint.
 */
export type SecretKey = "anthropic_api_key" | "openai_api_key" | "yiddishlabs_api_key" | "ivrit_api_key" | "elevenlabs_api_key" | "chat_model";

export const SECRET_ENV_FALLBACK: Record<SecretKey, string> = {
  anthropic_api_key: "ANTHROPIC_API_KEY",
  openai_api_key: "OPENAI_API_KEY",
  yiddishlabs_api_key: "YIDDISHLABS_API_KEY",
  ivrit_api_key: "EVERETT_API_KEY", // ivrit.ai RunPod key (a.k.a. Everett)
  elevenlabs_api_key: "ELEVENLABS_API_KEY", // voices for IVR greetings
  // Not a secret — the owner's chat-model pick ("provider:modelId") from the
  // Assistant page. Rides this store for its encryption/persist/hot-reload
  // plumbing; no env fallback (unset = code defaults in llm/router.ts).
  chat_model: "AGENT_CHAT_MODEL",
};

export interface Crypto {
  encryptJson: (v: unknown) => string;
  decryptJson: <T = any>(s: string) => T;
  hasMasterKey: () => boolean;
}

export class SecretStore {
  private cache = new Map<SecretKey, string | null>();

  constructor(
    private prisma: any,
    private crypto: Crypto,
    private audit: { record: (e: any) => Promise<boolean> },
  ) {}

  /** Resolve a key: DB (decrypted) first, then env fallback. Cached in-process. */
  async get(key: SecretKey): Promise<string | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    let val: string | null = null;
    if (this.crypto.hasMasterKey()) {
      try {
        const row = await this.prisma.agentSecret.findUnique({ where: { key } });
        if (row?.valueEnc) val = this.crypto.decryptJson<string>(row.valueEnc);
      } catch {
        val = null;
      }
    }
    if (!val) {
      const env = process.env[SECRET_ENV_FALLBACK[key]];
      val = env && env.trim() && !/paste|your-?(new|real)?-?key|\.\.\./i.test(env) ? env.trim() : null;
    }
    this.cache.set(key, val);
    return val;
  }

  /** Save a key (encrypted). Empty/whitespace clears it. Never returns the value. */
  async set(key: SecretKey, plaintext: string, updatedBy: string): Promise<void> {
    if (!this.crypto.hasMasterKey()) throw new Error("credentials_master_key_missing");
    const clean = (plaintext ?? "").trim();
    if (!clean) {
      await this.prisma.agentSecret.deleteMany({ where: { key } }).catch(() => {});
      this.cache.set(key, null);
    } else {
      const valueEnc = this.crypto.encryptJson(clean);
      await this.prisma.agentSecret.upsert({
        where: { key },
        update: { valueEnc, updatedBy },
        create: { key, valueEnc, updatedBy },
      });
      this.cache.set(key, clean);
    }
    await this.audit.record({ actor: "owner", event: "secret.set", payload: { key, cleared: !clean, by: updatedBy } });
  }

  /** Masked status for the UI — configured? source? last 4 chars only. */
  async status(): Promise<Record<SecretKey, { configured: boolean; source: "store" | "env" | "none"; hint?: string }>> {
    const keys: SecretKey[] = ["anthropic_api_key", "openai_api_key", "yiddishlabs_api_key", "ivrit_api_key", "elevenlabs_api_key", "chat_model"];
    const out: any = {};
    for (const k of keys) {
      let source: "store" | "env" | "none" = "none";
      let hint: string | undefined;
      let stored: string | null = null;
      if (this.crypto.hasMasterKey()) {
        try {
          const row = await this.prisma.agentSecret.findUnique({ where: { key: k } });
          if (row?.valueEnc) { stored = this.crypto.decryptJson<string>(row.valueEnc); source = "store"; }
        } catch { /* ignore */ }
      }
      const val = stored ?? (source === "none" ? await this.get(k) : stored);
      if (val) {
        if (source === "none") source = "env";
        hint = "…" + val.slice(-4);
      }
      out[k] = { configured: !!val, source, hint };
    }
    return out;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
