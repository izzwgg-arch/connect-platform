/**
 * Pure SOLA billing config rules shared by tenant (`server.ts`) and platform admin (`routes.ts`) paths.
 */

export function solaWebhookPinMissingForProd(mode: "sandbox" | "prod", pin: string | null | undefined): boolean {
  return mode === "prod" && !String(pin ?? "").trim();
}

export function solaEnableBlockedMissingProdPin(recordMode: string, pin: string | null | undefined): boolean {
  return recordMode === "PROD" && !String(pin ?? "").trim();
}

export function resolveSolaPutApiBaseUrl(
  input: string | null | undefined,
  existing: string | null | undefined,
  fallback = "https://x1.cardknox.com"
): string {
  const trimmed = input != null && String(input).trim() ? String(input).trim() : "";
  return trimmed || (existing != null && String(existing).trim() ? String(existing).trim() : "") || fallback;
}

/** Tenant PUT: omitting `pathOverrides` keeps the existing JSON. */
export function tenantPutPathOverridesSource(inputPathOverrides: unknown | undefined, existingPathOverrides: unknown | undefined): unknown {
  return inputPathOverrides !== undefined ? inputPathOverrides : existingPathOverrides || {};
}

/** Admin PUT: omitting `pathOverrides` falls back to existing (same as `input || existing`). */
export function adminPutPathOverridesSource(inputPathOverrides: unknown | undefined, existingPathOverrides: unknown | undefined): unknown {
  return inputPathOverrides || existingPathOverrides || {};
}

export function resolveTenantPutAuthMode(
  input: "xkey_body" | "authorization_header" | undefined,
  existingAuthDb: string | null | undefined
): "xkey_body" | "authorization_header" {
  if (input !== undefined) return input;
  return existingAuthDb === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body";
}
