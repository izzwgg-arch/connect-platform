/**
 * Where the SignalWire credentials come from.
 *
 * SignalWire is being EVALUATED as the carrier to replace VoIP.ms (Izzy,
 * 2026-08-18: "I want to start pivoting away from voip.ms … set this up and
 * test it … build this inside Loopcom"). This is the platform-owner account,
 * exactly as `GlobalVoipMsConfig` is for VoIP.ms — one set of credentials for
 * the whole platform, never per tenant.
 *
 * Same store and same encryption as the ElevenLabs key and the Polly
 * credentials — AgentSecret, AES-256-GCM under CREDENTIALS_MASTER_KEY, written
 * from the API. ⛔ Deliberately NOT a new Prisma model: an evaluation must not
 * cost a migration, and the AgentSecret row is already the sanctioned home for
 * "one JSON credential, platform-wide" (see voice/pollyCredentials.ts). If
 * SignalWire is adopted, the row can be promoted to a real model then, with the
 * per-number columns (`TenantSmsNumber.provider = SIGNALWIRE`, …) that a real
 * cut-over needs anyway.
 *
 * Three values, only ever useful together, so they live in ONE row:
 *   spaceUrl   — `<space>.signalwire.com` (the Space is the account; every API
 *                call is addressed to it)
 *   projectId  — a UUID; the API "username" AND the account id in the
 *                Twilio-compatible paths (`/Accounts/<projectId>/…`)
 *   apiToken   — `PT…`, the API "password". WRITE-ONLY here: `describe()`
 *                returns a masked hint and nothing else, and no route anywhere
 *                returns the value.
 *
 * Env is a fallback for local development only, and a deliberately picky one —
 * treating a `.env.example` placeholder as a real credential produces a
 * baffling 401 instead of an honest "not configured yet".
 */

const CACHE_MS = 60_000;
let cached: { value: StoredSignalWireCredentials | null; at: number } | null = null;

export const SIGNALWIRE_SECRET_KEY = "signalwire_credentials";
const PLACEHOLDER = /paste|your-?(new|real)?-?(key|secret|token)?|\.\.\.|example/i;

/** Project IDs are UUIDs. */
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `<space>.signalwire.com` — the space name is a DNS label. */
const SPACE_URL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.signalwire\.com$/i;

export interface StoredSignalWireCredentials {
  /** Bare host, e.g. `loopcom.signalwire.com` — no scheme, no path, no port. */
  spaceUrl: string;
  projectId: string;
  apiToken: string;
  /**
   * The project's SIGNING KEY (`PSK…`), from the dashboard's API/Credentials
   * page. Not needed for any outbound call — it is what SignalWire signs
   * inbound webhooks with (`X-SignalWire-Signature`), so without it the
   * inbound-SMS door stays shut. Optional at save time; the webhook fails
   * closed until it is set.
   */
  signingKey?: string | null;
}

export function clearSignalWireCredentialsCache(): void {
  cached = null;
}

/**
 * Accept what people actually paste for the Space — `loopcom`,
 * `loopcom.signalwire.com`, `https://loopcom.signalwire.com/`, even a full
 * dashboard URL — and reduce it to the bare host. Returns null when nothing
 * usable can be recovered.
 */
export function normalizeSpaceUrl(input: unknown): string | null {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/:\d+$/, "");
  if (!s) return null;
  if (!s.includes(".")) s = `${s}.signalwire.com`;
  if (!SPACE_URL_RE.test(s)) return null;
  return s;
}

/** Shape-check what someone typed, before it is ever sent to SignalWire. A
 *  malformed value and a rejected one both come back from the provider as a
 *  401, and only one of them is worth an afternoon. */
export function validateSignalWireCredentials(input: {
  spaceUrl?: unknown;
  projectId?: unknown;
  apiToken?: unknown;
  signingKey?: unknown;
}): { ok: true; value: StoredSignalWireCredentials } | { ok: false; message: string } {
  const spaceUrl = normalizeSpaceUrl(input.spaceUrl);
  const projectId = String(input.projectId ?? "").trim();
  const apiToken = String(input.apiToken ?? "").trim();
  const signingKey = String(input.signingKey ?? "").trim();
  if (signingKey && signingKey.length < 20) {
    return { ok: false, message: "That signing key looks too short — check the whole thing was copied. (Leave it blank if you don't have one yet.)" };
  }
  if (signingKey && signingKey === apiToken) {
    return { ok: false, message: "The signing key and the API token are the same value. The signing key is a separate string on the API page (it usually starts with PSK)." };
  }

  if (!String(input.spaceUrl ?? "").trim()) return { ok: false, message: "Enter the Space URL (it looks like yourspace.signalwire.com)." };
  if (!spaceUrl) {
    return { ok: false, message: "That Space URL doesn't look right. It should be yourspace.signalwire.com — the address you sign in to." };
  }
  if (!projectId) return { ok: false, message: "Enter the Project ID." };
  if (!PROJECT_ID_RE.test(projectId)) {
    return { ok: false, message: "That Project ID doesn't look right. SignalWire's are UUIDs (8-4-4-4-12 hex characters), shown on the project's API page." };
  }
  if (!apiToken) return { ok: false, message: "Enter the API token." };
  if (apiToken.length < 20) return { ok: false, message: "That API token looks too short — check the whole thing was copied." };
  if (!/^PT/i.test(apiToken)) {
    return { ok: false, message: "That doesn't look like a SignalWire API token — they start with PT. Make sure you copied the token, not the project ID or the signing key." };
  }
  if (apiToken === projectId) return { ok: false, message: "The Project ID and the API token are the same. The token is the one starting with PT." };
  return { ok: true, value: { spaceUrl, projectId, apiToken, signingKey: signingKey || null } };
}

/** Resolve the stored credentials, or null when SignalWire isn't set up. */
export async function resolveSignalWireCredentials(db: any): Promise<StoredSignalWireCredentials | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: StoredSignalWireCredentials | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: SIGNALWIRE_SECRET_KEY } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<StoredSignalWireCredentials>(row.valueEnc);
        const spaceUrl = normalizeSpaceUrl(decrypted?.spaceUrl);
        if (spaceUrl && decrypted?.projectId && decrypted?.apiToken) {
          value = {
            spaceUrl,
            projectId: String(decrypted.projectId).trim(),
            apiToken: String(decrypted.apiToken).trim(),
            signingKey: decrypted.signingKey ? String(decrypted.signingKey).trim() : null,
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
    const spaceUrl = normalizeSpaceUrl(process.env.SIGNALWIRE_SPACE_URL || "");
    const projectId = (process.env.SIGNALWIRE_PROJECT_ID || "").trim();
    const apiToken = (process.env.SIGNALWIRE_API_TOKEN || "").trim();
    if (spaceUrl && projectId && apiToken && !PLACEHOLDER.test(projectId) && !PLACEHOLDER.test(apiToken)) {
      const signingKey = (process.env.SIGNALWIRE_SIGNING_KEY || "").trim();
      value = { spaceUrl, projectId, apiToken, signingKey: signingKey && !PLACEHOLDER.test(signingKey) ? signingKey : null };
    }
  }

  cached = { value, at: Date.now() };
  return value;
}

/** Save (or, with null, clear) the credentials. Never returns them. */
export async function storeSignalWireCredentials(
  db: any,
  value: StoredSignalWireCredentials | null,
  updatedBy: string,
): Promise<void> {
  const sec = await import("@connect/security");
  if (!sec.hasCredentialsMasterKey()) throw new Error("credentials_master_key_missing");

  if (!value) {
    await db.agentSecret.deleteMany({ where: { key: SIGNALWIRE_SECRET_KEY } });
  } else {
    const valueEnc = sec.encryptJson(value);
    await db.agentSecret.upsert({
      where: { key: SIGNALWIRE_SECRET_KEY },
      update: { valueEnc, updatedBy },
      create: { key: SIGNALWIRE_SECRET_KEY, valueEnc, updatedBy },
    });
  }
  clearSignalWireCredentialsCache();
}

/**
 * What the settings page is allowed to see: never the token, only enough to
 * tell whether what got saved is what was typed. The Space and Project ID are
 * identifiers (they appear in every URL and in SignalWire's own dashboard), so
 * they are shown in full — that is what makes "did my paste actually land"
 * answerable.
 */
export async function describeSignalWireCredentials(db: any): Promise<{
  configured: boolean;
  source: "store" | "env" | "none";
  spaceUrl: string | null;
  projectId: string | null;
  tokenHint: string | null;
  signingKeySet: boolean;
}> {
  const value = await resolveSignalWireCredentials(db);
  if (!value) return { configured: false, source: "none", spaceUrl: null, projectId: null, tokenHint: null, signingKeySet: false };

  let source: "store" | "env" = "env";
  try {
    const row = await db.agentSecret.findUnique({ where: { key: SIGNALWIRE_SECRET_KEY } });
    if (row?.valueEnc) source = "store";
  } catch {
    // Fall back to reporting "env" — a wrong label here is cosmetic, and this
    // page must never fail to render because a status lookup threw.
  }

  return {
    configured: true,
    source,
    spaceUrl: value.spaceUrl,
    projectId: value.projectId,
    tokenHint: `…${value.apiToken.slice(-4)}`,
    signingKeySet: Boolean(value.signingKey),
  };
}
