/**
 * Where the Grandstream GDMS credentials come from.
 *
 * Same store and encryption as the Polly credentials (AgentSecret, AES-256-GCM under
 * CREDENTIALS_MASTER_KEY), one row holding all five values, because they are only ever
 * useful together and a half-saved credential fails exactly like a typo.
 *
 * ⛔⛔ GDMS NEEDS THE ACCOUNT'S USERNAME AND PASSWORD AS WELL AS THE API ID AND SECRET KEY.
 * Its token endpoint is an OAuth password grant — the API ID alone signs nothing in.
 *
 * ⛔ WRITE-ONLY. `describeGdmsCredentials` returns hints and nothing else; no route
 * anywhere returns a value. Nothing here logs.
 *
 * Env is a local-development fallback only, and it refuses placeholder-shaped values.
 */
import type { GdmsCredentials, GdmsRegion } from "./gdmsClient";

const SECRET_KEY = "gdms_credentials";
const CACHE_MS = 60_000;
const PLACEHOLDER = /paste|your-?(new|real)?-?(key|secret|id|password|user)?|\.\.\.|changeme/i;

let cached: { value: GdmsCredentials | null; at: number } | null = null;
const listeners: Array<() => void> = [];

export function clearGdmsCredentialsCache(): void {
  cached = null;
  for (const fn of listeners) { try { fn(); } catch { /* a listener must never break a save */ } }
}

/** Something holding a GDMS session asks to be told when the credentials change. */
export function onGdmsCredentialsChanged(fn: () => void): void {
  listeners.push(fn);
}

export function validateGdmsCredentials(input: {
  region?: unknown; apiId?: unknown; secretKey?: unknown; username?: unknown; password?: unknown;
}): { ok: true; value: GdmsCredentials } | { ok: false; message: string } {
  const region = String(input.region ?? "us").trim().toLowerCase();
  const apiId = String(input.apiId ?? "").trim();
  const secretKey = String(input.secretKey ?? "").trim();
  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");
  if (region !== "us" && region !== "eu") return { ok: false, message: "Choose the GDMS region: United States or Europe." };
  if (!apiId) return { ok: false, message: "Enter the GDMS API ID." };
  if (!/^\S{4,128}$/.test(apiId)) return { ok: false, message: "That API ID doesn't look right. Copy it again from GDMS → System → API Developer." };
  if (!secretKey) return { ok: false, message: "Enter the GDMS Secret Key." };
  if (!/^\S{8,256}$/.test(secretKey)) return { ok: false, message: "That Secret Key looks too short or contains spaces." };
  if (secretKey === apiId) return { ok: false, message: "The API ID and the Secret Key are the same value. The Secret Key is the longer one." };
  if (!username) return { ok: false, message: "Enter the GDMS account username (the one used to sign in to gdms.cloud)." };
  if (username.length > 128) return { ok: false, message: "That username is too long." };
  if (!password) return { ok: false, message: "Enter the GDMS account password. GDMS signs the API in with the account password." };
  if (password.length > 256) return { ok: false, message: "That password is too long." };
  return { ok: true, value: { region: region as GdmsRegion, apiId, secretKey, username, password } };
}

export async function resolveGdmsCredentials(db: any, env: NodeJS.ProcessEnv = process.env): Promise<GdmsCredentials | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value: GdmsCredentials | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: SECRET_KEY } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<GdmsCredentials>(row.valueEnc);
        const check = validateGdmsCredentials(decrypted ?? {});
        if (check.ok) value = check.value;
      }
    }
  } catch {
    // A missing master key, absent row or decrypt failure all mean "not configured".
    value = null;
  }
  if (!value) {
    const fromEnv = {
      region: env.GDMS_REGION || "us",
      apiId: env.GDMS_API_ID || "",
      secretKey: env.GDMS_SECRET_KEY || "",
      username: env.GDMS_USERNAME || "",
      password: env.GDMS_PASSWORD || "",
    };
    const looksReal = [fromEnv.apiId, fromEnv.secretKey, fromEnv.username, fromEnv.password].every((v) => v && !PLACEHOLDER.test(v));
    if (looksReal) {
      const check = validateGdmsCredentials(fromEnv);
      if (check.ok) value = check.value;
    }
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function storeGdmsCredentials(db: any, value: GdmsCredentials | null, updatedBy: string): Promise<void> {
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
  clearGdmsCredentialsCache();
}

const tail = (s: string, n = 4) => (s.length <= n ? "…" : `…${s.slice(-n)}`);

export async function describeGdmsCredentials(db: any): Promise<{
  configured: boolean;
  source: "store" | "env" | "none";
  region: GdmsRegion | null;
  apiIdHint: string | null;
  usernameHint: string | null;
  secretHint: string | null;
}> {
  const value = await resolveGdmsCredentials(db);
  if (!value) return { configured: false, source: "none", region: null, apiIdHint: null, usernameHint: null, secretHint: null };
  let source: "store" | "env" = "env";
  try {
    const row = await db.agentSecret.findUnique({ where: { key: SECRET_KEY } });
    if (row?.valueEnc) source = "store";
  } catch { /* cosmetic label only */ }
  const at = value.username.indexOf("@");
  const usernameHint = at > 0 ? `${value.username.slice(0, 1)}…${value.username.slice(at)}` : `${value.username.slice(0, 1)}…`;
  return { configured: true, source, region: value.region, apiIdHint: tail(value.apiId), usernameHint, secretHint: tail(value.secretKey) };
}
