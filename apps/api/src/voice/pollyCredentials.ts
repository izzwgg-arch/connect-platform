/**
 * Where the Amazon Polly credentials come from.
 *
 * Same store and same encryption as the ElevenLabs key — AgentSecret, AES-256-GCM
 * under CREDENTIALS_MASTER_KEY — but written from the API rather than the agent.
 * That is deliberate: the agent has no part in Polly (it neither stores nor
 * spends these credentials), and the agent container is rebuilt by hand rather
 * than through the deploy queue, so routing a write through it would make the
 * Polly page depend on a manual step to work.
 *
 * Unlike the ElevenLabs key, this is three values that are only ever useful
 * together, so they live in ONE row as a JSON object. A half-saved credential
 * (new key, old secret) fails in a way that reads exactly like a typo, and
 * writing all three at once removes that state entirely.
 *
 * The secret is WRITE-ONLY: `describe()` returns a masked hint and nothing else,
 * and no route anywhere returns the value.
 *
 * Env is a fallback for local development only, and a deliberately picky one —
 * treating a `.env.example` placeholder as a real credential produces a
 * baffling 403 instead of an honest "not configured yet".
 */

const CACHE_MS = 60_000;
let cached: { value: StoredPollyCredentials | null; at: number } | null = null;

const SECRET_KEY = "polly_credentials";
const PLACEHOLDER = /paste|your-?(new|real)?-?(key|secret)?|\.\.\./i;

/** AWS access key ids are 16–128 uppercase alphanumerics (AKIA…, ASIA…). */
const ACCESS_KEY_RE = /^[A-Z0-9]{16,128}$/;
/** Regions look like us-east-1 / eu-west-2 / ap-southeast-3. */
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export interface StoredPollyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string | null;
}

export function clearPollyCredentialsCache(): void {
  cached = null;
}

/** The region used when someone saves credentials without naming one. */
export const DEFAULT_POLLY_REGION = "us-east-1";

/**
 * Regions offered in the picker. Polly runs in many more, but a dropdown of
 * thirty is a worse experience than a short list plus "type your own" — these
 * are the ones a US/EU/IL customer base actually lands in.
 */
export const SUGGESTED_POLLY_REGIONS = [
  { id: "us-east-1", label: "US East (N. Virginia)" },
  { id: "us-east-2", label: "US East (Ohio)" },
  { id: "us-west-2", label: "US West (Oregon)" },
  { id: "eu-west-1", label: "Europe (Ireland)" },
  { id: "eu-west-2", label: "Europe (London)" },
  { id: "eu-central-1", label: "Europe (Frankfurt)" },
  { id: "il-central-1", label: "Israel (Tel Aviv)" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
] as const;

/** Shape-check what someone typed, before it is ever sent to AWS. Both failures
 *  below come back from AWS as the same unhelpful 403, so catching them here is
 *  the difference between "you pasted the key twice" and an afternoon lost. */
export function validatePollyCredentials(input: {
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
  region?: unknown;
}): { ok: true; value: StoredPollyCredentials } | { ok: false; message: string } {
  const accessKeyId = String(input.accessKeyId ?? "").trim();
  const secretAccessKey = String(input.secretAccessKey ?? "").trim();
  const region = String(input.region ?? "").trim() || DEFAULT_POLLY_REGION;

  if (!accessKeyId) return { ok: false, message: "Enter the access key ID." };
  if (!ACCESS_KEY_RE.test(accessKeyId)) {
    return {
      ok: false,
      message: "That access key ID doesn't look right. Amazon's are all capitals and numbers, and usually start with AKIA.",
    };
  }
  if (!secretAccessKey) return { ok: false, message: "Enter the secret access key." };
  if (secretAccessKey.length < 20) {
    return { ok: false, message: "That secret access key looks too short — check the whole thing was copied." };
  }
  if (secretAccessKey === accessKeyId) {
    return { ok: false, message: "The access key ID and the secret are the same. The secret is the longer, mixed-case one." };
  }
  if (!REGION_RE.test(region)) {
    return { ok: false, message: `"${region}" doesn't look like an AWS region. They look like us-east-1.` };
  }
  return { ok: true, value: { accessKeyId, secretAccessKey, region } };
}

/** Resolve the stored credentials, or null when Polly isn't set up. */
export async function resolvePollyCredentials(db: any): Promise<StoredPollyCredentials | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: StoredPollyCredentials | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: SECRET_KEY } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<StoredPollyCredentials>(row.valueEnc);
        if (decrypted?.accessKeyId && decrypted?.secretAccessKey) {
          value = {
            accessKeyId: String(decrypted.accessKeyId).trim(),
            secretAccessKey: String(decrypted.secretAccessKey).trim(),
            region: String(decrypted.region || DEFAULT_POLLY_REGION).trim(),
            sessionToken: decrypted.sessionToken ? String(decrypted.sessionToken).trim() : null,
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
    const id = (process.env.POLLY_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "").trim();
    const secret = (process.env.POLLY_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "").trim();
    const region = (process.env.POLLY_REGION || process.env.AWS_REGION || DEFAULT_POLLY_REGION).trim();
    if (id && secret && !PLACEHOLDER.test(id) && !PLACEHOLDER.test(secret)) {
      value = { accessKeyId: id, secretAccessKey: secret, region, sessionToken: null };
    }
  }

  cached = { value, at: Date.now() };
  return value;
}

/** Save (or, with a blank access key, clear) the credentials. Never returns them. */
export async function storePollyCredentials(
  db: any,
  value: StoredPollyCredentials | null,
  updatedBy: string,
): Promise<void> {
  const sec = await import("@connect/security");
  if (!sec.hasCredentialsMasterKey()) throw new Error("credentials_master_key_missing");

  if (!value) {
    await db.agentSecret.deleteMany({ where: { key: SECRET_KEY } });
  } else {
    const valueEnc = sec.encryptJson(value);
    await db.agentSecret.upsert({
      where: { key: SECRET_KEY },
      update: { valueEnc, updatedBy },
      create: { key: SECRET_KEY, valueEnc, updatedBy },
    });
  }
  clearPollyCredentialsCache();
  const { clearPollyReadCaches } = await import("./polly");
  clearPollyReadCaches();
}

/**
 * What the settings page is allowed to see: never the secret, only enough to
 * tell whether what got saved is what was typed. A credential that never made
 * it in — mistyped, half-pasted, refilled by the browser — is otherwise
 * indistinguishable from one that AWS simply rejected.
 */
export async function describePollyCredentials(db: any): Promise<{
  configured: boolean;
  source: "store" | "env" | "none";
  accessKeyId: string | null;
  secretHint: string | null;
  region: string | null;
}> {
  const value = await resolvePollyCredentials(db);
  if (!value) return { configured: false, source: "none", accessKeyId: null, secretHint: null, region: null };

  let source: "store" | "env" = "env";
  try {
    const row = await db.agentSecret.findUnique({ where: { key: SECRET_KEY } });
    if (row?.valueEnc) source = "store";
  } catch {
    // Fall back to reporting "env" — a wrong label here is cosmetic, and this
    // page must never fail to render because a status lookup threw.
  }

  return {
    configured: true,
    source,
    // The access key ID is an identifier, not a secret (it appears in AWS's own
    // console and in every signed request header). Showing it in full is what
    // makes "did my paste actually land" answerable.
    accessKeyId: value.accessKeyId,
    secretHint: `…${value.secretAccessKey.slice(-4)}`,
    region: value.region,
  };
}
