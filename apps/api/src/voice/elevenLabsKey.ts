/**
 * Where the ElevenLabs key comes from.
 *
 * The owner types it once on the ElevenLabs settings page, which stores it
 * encrypted in AgentSecret (AES-256-GCM, CREDENTIALS_MASTER_KEY). The API reads
 * that same row — one place to set it, one place it lives.
 *
 * Env is a fallback for local development only, and a deliberately picky one:
 * `.env.example` ships placeholders like "paste-your-key-here", and treating a
 * placeholder as a real key produces a baffling 401 instead of an honest "no
 * key configured". The same guard exists in the agent's SecretStore; both have
 * to agree or the two processes disagree about whether the feature is on.
 *
 * Cached for a minute so a page that lists voices and checks status doesn't
 * decrypt twice, but short enough that saving a new key takes effect while the
 * owner is still looking at the page.
 */

const CACHE_MS = 60_000;
let cached: { value: string | null; at: number } | null = null;

const PLACEHOLDER = /paste|your-?(new|real)?-?key|\.\.\./i;

export function clearElevenLabsKeyCache(): void {
  cached = null;
}

export async function resolveElevenLabsKey(db: any): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: string | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: "elevenlabs_api_key" } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<string>(row.valueEnc);
        if (typeof decrypted === "string" && decrypted.trim()) value = decrypted.trim();
      }
    }
  } catch {
    // A missing master key, an absent row, or a decrypt failure all mean the
    // same thing to the caller: no key. Never let this throw into a route.
    value = null;
  }

  if (!value) {
    const env = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (env && !PLACEHOLDER.test(env)) value = env;
  }

  cached = { value, at: Date.now() };
  return value;
}
