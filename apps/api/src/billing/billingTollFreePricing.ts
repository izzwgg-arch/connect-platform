/** Stored on `TenantBillingSettings.metadata.billingTollFreeDidPriceCents` — no migration. */
export const BILLING_TOLL_FREE_DID_PRICE_METADATA_KEY = "billingTollFreeDidPriceCents";

const DEFAULT_TOLL_FREE_DID_CENTS = 1500;

export function parseTollFreeDidPriceCents(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_TOLL_FREE_DID_PRICE_METADATA_KEY];
  if (raw === null || raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function resolveTollFreeDidPriceCents(metadata: unknown, localDidPriceCents: number): number {
  const stored = parseTollFreeDidPriceCents(metadata);
  if (stored !== null) return stored;
  return Math.max(0, Number(localDidPriceCents) || DEFAULT_TOLL_FREE_DID_CENTS);
}

export function mergeTollFreeDidPriceIntoMetadata(
  prev: unknown,
  tollFreeDidPriceCents: number | null | undefined,
): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  if (tollFreeDidPriceCents === undefined) return prevMeta;
  if (tollFreeDidPriceCents === null) {
    delete prevMeta[BILLING_TOLL_FREE_DID_PRICE_METADATA_KEY];
    return prevMeta;
  }
  return { ...prevMeta, [BILLING_TOLL_FREE_DID_PRICE_METADATA_KEY]: Math.max(0, Math.round(tollFreeDidPriceCents)) };
}
