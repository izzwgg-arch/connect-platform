/** Stored on `TenantBillingSettings.metadata.billingVirtualExtensionPriceCents` — no migration. */
export const BILLING_VIRTUAL_EXTENSION_PRICE_METADATA_KEY = "billingVirtualExtensionPriceCents";

export function parseVirtualExtensionPriceCents(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_VIRTUAL_EXTENSION_PRICE_METADATA_KEY];
  if (raw === null || raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function resolveVirtualExtensionPriceCents(metadata: unknown, extensionPriceCents: number): number {
  const stored = parseVirtualExtensionPriceCents(metadata);
  if (stored !== null) return stored;
  return Math.max(0, Number(extensionPriceCents) || 0);
}

export function mergeVirtualExtensionPriceIntoMetadata(
  prev: unknown,
  virtualExtensionPriceCents: number | null | undefined,
): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  if (virtualExtensionPriceCents === undefined) return prevMeta;
  if (virtualExtensionPriceCents === null) {
    delete prevMeta[BILLING_VIRTUAL_EXTENSION_PRICE_METADATA_KEY];
    return prevMeta;
  }
  return {
    ...prevMeta,
    [BILLING_VIRTUAL_EXTENSION_PRICE_METADATA_KEY]: Math.max(0, Math.round(virtualExtensionPriceCents)),
  };
}
