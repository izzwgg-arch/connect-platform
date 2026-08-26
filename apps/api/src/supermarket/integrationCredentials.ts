/**
 * Per-tenant integration keys — the one admin screen's storage layer
 * (supermarket plan Phase 5). Sola and the Tracking system (POS with Logic)
 * alike: pick the customer, pick the integration, paste the key.
 *
 * Storage is the EXISTING ProviderCredential table (tenantId + provider
 * unique, credentialsEncrypted envelope from @connect/security) — the repo's
 * established per-tenant credential convention. New enum values POS_TRACKING
 * and SOLA ride the same row shape.
 *
 * Rules:
 * - ⛔ Values are WRITE-ONLY. Reads return `configured` + a masked hint
 *   (last 4), never the secret (the signalwire describe pattern).
 * - ⛔ NO FALLBACK. resolvePosCredentials / resolveTenantSolaKey answer null
 *   when the tenant has no row — they never reach for a platform-level key.
 *   For Sola that wall is the whole point: a customer's charges must never
 *   ride the platform's own billing merchant account.
 * - Missing CREDENTIALS_MASTER_KEY degrades to "not configured" on reads and
 *   throws loudly on writes — a half-working vault is worse than none.
 */

import { PosWithLogicClient, type PosClientDeps } from "./posWithLogic";

export const SUPERMARKET_PROVIDERS = ["POS_TRACKING", "SOLA", "OPENAI"] as const;
export type SupermarketProvider = (typeof SUPERMARKET_PROVIDERS)[number];

export type StoredIntegrationKey = {
  /** The pasted key/secret. Wrapped in an object so the payload can grow. */
  apiKey: string;
  /** Optional base-url override (tests / sandbox); production leaves it unset. */
  baseUrl?: string;
  /** SOLA only: the merchant's PUBLIC iFields key (renders the card iframes). */
  ifieldsKey?: string;
};

export function isSupermarketProvider(value: unknown): value is SupermarketProvider {
  return SUPERMARKET_PROVIDERS.includes(value as SupermarketProvider);
}

export function maskKeyHint(apiKey: string): string {
  const trimmed = String(apiKey ?? "").trim();
  if (trimmed.length < 4) return "…";
  return `…${trimmed.slice(-4)}`;
}

export async function storeIntegrationKey(
  db: any,
  input: {
    tenantId: string;
    provider: SupermarketProvider;
    apiKey: string;
    baseUrl?: string;
    label?: string;
    ifieldsKey?: string;
    actorUserId: string;
  },
): Promise<{ id: string; hint: string }> {
  const sec = await import("@connect/security");
  if (!sec.hasCredentialsMasterKey()) throw new Error("credentials_master_key_missing");
  const apiKey = String(input.apiKey ?? "").trim();
  if (apiKey.length < 8 || apiKey.length > 512) throw new Error("integration_key_invalid");
  if (/[\r\n]/.test(apiKey)) throw new Error("integration_key_invalid");
  const payload: StoredIntegrationKey = { apiKey };
  if (input.baseUrl && /^https:\/\/[a-z0-9.-]+/i.test(input.baseUrl.trim())) {
    payload.baseUrl = input.baseUrl.trim();
  }
  const ifk = String(input.ifieldsKey ?? "").trim();
  if (ifk && ifk.length <= 200 && !/[\r\n]/.test(ifk)) payload.ifieldsKey = ifk;
  const credentialsEncrypted = sec.encryptJson(payload);
  const row = await db.providerCredential.upsert({
    where: { tenantId_provider: { tenantId: input.tenantId, provider: input.provider } },
    update: {
      credentialsEncrypted,
      label: input.label ?? undefined,
      isEnabled: true,
      updatedByUserId: input.actorUserId,
    },
    create: {
      tenantId: input.tenantId,
      provider: input.provider,
      label: input.label ?? null,
      isEnabled: true,
      credentialsEncrypted,
      createdByUserId: input.actorUserId,
      updatedByUserId: input.actorUserId,
    },
    select: { id: true },
  });
  return { id: row.id, hint: maskKeyHint(apiKey) };
}

/**
 * Remove a key. The row is DELETED (not blanked) so "configured" can never
 * read true off an empty envelope.
 */
export async function removeIntegrationKey(db: any, tenantId: string, provider: SupermarketProvider): Promise<void> {
  await db.providerCredential.deleteMany({ where: { tenantId, provider } });
}

export type IntegrationKeyStatus = {
  provider: SupermarketProvider;
  configured: boolean;
  hint: string | null;
  label: string | null;
  updatedAt: string | null;
};

export async function describeIntegrationKeys(db: any, tenantId: string): Promise<IntegrationKeyStatus[]> {
  const rows = await db.providerCredential.findMany({
    where: { tenantId, provider: { in: [...SUPERMARKET_PROVIDERS] }, isEnabled: true },
    select: { provider: true, label: true, credentialsEncrypted: true, updatedAt: true },
  });
  const byProvider = new Map<string, any>(rows.map((r: any) => [String(r.provider), r]));
  const out: IntegrationKeyStatus[] = [];
  let sec: any = null;
  for (const provider of SUPERMARKET_PROVIDERS) {
    const row = byProvider.get(provider);
    if (!row) {
      out.push({ provider, configured: false, hint: null, label: null, updatedAt: null });
      continue;
    }
    let hint: string | null = null;
    try {
      sec = sec ?? (await import("@connect/security"));
      if (sec.hasCredentialsMasterKey()) {
        const value = sec.decryptJson(row.credentialsEncrypted) as StoredIntegrationKey | null;
        if (value?.apiKey) hint = maskKeyHint(value.apiKey);
      }
    } catch {
      hint = null; // undecryptable row reads as configured-but-unreadable
    }
    out.push({
      provider,
      configured: true,
      hint,
      label: row.label ?? null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    });
  }
  return out;
}

/**
 * Resolve a tenant's stored key for one provider, or null. Never throws into
 * a route: any failure (missing master key, corrupt envelope) collapses to
 * null and the caller refuses in plain English.
 */
export async function resolveIntegrationKey(
  db: any,
  tenantId: string,
  provider: SupermarketProvider,
): Promise<StoredIntegrationKey | null> {
  try {
    const sec = await import("@connect/security");
    if (!sec.hasCredentialsMasterKey()) return null;
    const row = await db.providerCredential.findFirst({
      where: { tenantId, provider, isEnabled: true },
      select: { credentialsEncrypted: true },
    });
    if (!row) return null;
    const value = sec.decryptJson<StoredIntegrationKey>(row.credentialsEncrypted);
    if (!value || typeof value.apiKey !== "string" || value.apiKey.trim().length < 8) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * A ready POS client for a tenant, or null when the tenant holds no key.
 * ⛔ Null is an ANSWER ("this tenant has no register connection"), never a
 * signal to try some other credential.
 */
export async function posClientForTenant(
  db: any,
  tenantId: string,
  deps: PosClientDeps = {},
): Promise<PosWithLogicClient | null> {
  const key = await resolveIntegrationKey(db, tenantId, "POS_TRACKING");
  if (!key) return null;
  try {
    return new PosWithLogicClient({ apiKey: key.apiKey, baseUrl: key.baseUrl }, deps);
  } catch {
    return null;
  }
}
