/**
 * Where the Telnyx credentials come from.
 *
 * Telnyx is the SECOND carrier being evaluated beside SignalWire (Izzy,
 * 2026-09-15: "create a new page inside Loopcom called Telnyx and wire the
 * whole API in, so if we want to, I can switch between SignalWire, [VoIP.ms],
 * and Telnyx"). Same shape as the SignalWire evaluation: platform-owner
 * account, one credential for the whole platform, never per tenant.
 *
 * Same store and same encryption as the SignalWire / ElevenLabs / Polly
 * credentials — AgentSecret, AES-256-GCM under CREDENTIALS_MASTER_KEY.
 * ⛔ Deliberately NOT a new Prisma model: an evaluation must not cost a
 * migration (the SignalWire rule, kept on purpose).
 *
 * Telnyx auth is ONE value — an API v2 key (`KEY…`), sent as
 * `Authorization: Bearer KEY…` to `https://api.telnyx.com/v2`. The optional
 * public key is Telnyx's per-account Ed25519 WEBHOOK verify key (shown on the
 * portal's "Public Key" page); no webhook is registered yet, but storing it
 * with the credential means the webhook door can be built without another
 * round trip to the dashboard.
 *
 * The API key is WRITE-ONLY here: `describe()` returns a masked hint and
 * nothing else, and no route anywhere returns the value.
 */

const CACHE_MS = 60_000;
let cached: { value: StoredTelnyxCredentials | null; at: number } | null = null;

export const TELNYX_SECRET_KEY = "telnyx_credentials";
const PLACEHOLDER = /paste|your-?(new|real)?-?(key|secret|token)?|\.\.\.|example/i;

/** Telnyx API v2 keys start with `KEY` followed by a long identifier+secret. */
const API_KEY_RE = /^KEY[A-Za-z0-9_-]{20,}$/;

export interface StoredTelnyxCredentials {
  /** The API v2 key, `KEY…` — the only value Telnyx auth needs. */
  apiKey: string;
  /**
   * The account's Ed25519 webhook public key (base64), from the portal's
   * API Keys → Public Key page. Optional; only webhooks need it, and none are
   * registered yet — the field exists so the door can be built later without
   * re-asking for a dashboard value.
   */
  publicKey?: string | null;
}

export function clearTelnyxCredentialsCache(): void {
  cached = null;
}

/** Shape-check what someone typed, before it is ever sent to Telnyx. A
 *  malformed value and a rejected one both come back as a 401, and only one
 *  of them is worth an afternoon. */
export function validateTelnyxCredentials(input: {
  apiKey?: unknown;
  publicKey?: unknown;
}): { ok: true; value: StoredTelnyxCredentials } | { ok: false; message: string } {
  const apiKey = String(input.apiKey ?? "").trim();
  const publicKey = String(input.publicKey ?? "").trim();

  if (!apiKey) return { ok: false, message: "Enter the API key." };
  if (apiKey.length < 20) return { ok: false, message: "That API key looks too short — check the whole thing was copied." };
  if (!/^KEY/i.test(apiKey)) {
    return { ok: false, message: "That doesn't look like a Telnyx API key — v2 keys start with KEY. Make sure you copied the API key, not the public key or a key name." };
  }
  if (!API_KEY_RE.test(apiKey)) {
    return { ok: false, message: "That API key has characters Telnyx keys never contain — check it was copied cleanly, with nothing cut off or added." };
  }
  if (publicKey && publicKey.length < 20) {
    return { ok: false, message: "That public key looks too short — copy the whole base64 value from the Public Key page. (Leave it blank if you don't have it yet.)" };
  }
  if (publicKey && publicKey === apiKey) {
    return { ok: false, message: "The public key and the API key are the same value. The public key is the separate base64 string on the portal's Public Key page." };
  }
  return { ok: true, value: { apiKey, publicKey: publicKey || null } };
}

/** Resolve the stored credentials, or null when Telnyx isn't set up. */
export async function resolveTelnyxCredentials(db: any): Promise<StoredTelnyxCredentials | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: StoredTelnyxCredentials | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: TELNYX_SECRET_KEY } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<StoredTelnyxCredentials>(row.valueEnc);
        const apiKey = String(decrypted?.apiKey ?? "").trim();
        if (apiKey) {
          value = {
            apiKey,
            publicKey: decrypted?.publicKey ? String(decrypted.publicKey).trim() : null,
          };
        }
      }
    }
  } catch {
    // A missing master key, an absent row, or a decrypt failure all mean the
    // same thing to the caller: not configured. Never throw into a route.
    value = null;
  }

  if (!value) {
    const apiKey = (process.env.TELNYX_API_KEY || "").trim();
    if (apiKey && !PLACEHOLDER.test(apiKey)) {
      const publicKey = (process.env.TELNYX_PUBLIC_KEY || "").trim();
      value = { apiKey, publicKey: publicKey && !PLACEHOLDER.test(publicKey) ? publicKey : null };
    }
  }

  cached = { value, at: Date.now() };
  return value;
}

/** Save (or, with null, clear) the credentials. Never returns them. */
export async function storeTelnyxCredentials(
  db: any,
  value: StoredTelnyxCredentials | null,
  updatedBy: string,
): Promise<void> {
  const sec = await import("@connect/security");
  if (!sec.hasCredentialsMasterKey()) throw new Error("credentials_master_key_missing");

  if (!value) {
    await db.agentSecret.deleteMany({ where: { key: TELNYX_SECRET_KEY } });
  } else {
    const valueEnc = sec.encryptJson(value);
    await db.agentSecret.upsert({
      where: { key: TELNYX_SECRET_KEY },
      update: { valueEnc, updatedBy },
      create: { key: TELNYX_SECRET_KEY, valueEnc, updatedBy },
    });
  }
  clearTelnyxCredentialsCache();
}

/**
 * What the settings page is allowed to see: never the key, only enough to
 * tell whether what got saved is what was typed.
 */
export async function describeTelnyxCredentials(db: any): Promise<{
  configured: boolean;
  source: "store" | "env" | "none";
  keyHint: string | null;
  publicKeySet: boolean;
}> {
  const value = await resolveTelnyxCredentials(db);
  if (!value) return { configured: false, source: "none", keyHint: null, publicKeySet: false };

  let source: "store" | "env" = "env";
  try {
    const row = await db.agentSecret.findUnique({ where: { key: TELNYX_SECRET_KEY } });
    if (row?.valueEnc) source = "store";
  } catch {
    // Fall back to reporting "env" — a wrong label here is cosmetic, and this
    // page must never fail to render because a status lookup threw.
  }

  return {
    configured: true,
    source,
    keyHint: `${value.apiKey.slice(0, 5)}…${value.apiKey.slice(-4)}`,
    publicKeySet: Boolean(value.publicKey),
  };
}
