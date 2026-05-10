/**
 * Canonical tenant slug derivation for AstDB families
 * (`connect/t_<slug>/...`) — used by both the API (`getIvrSlugForTenant` in
 * apps/api/src/server.ts) and the worker (`workerCanonicalTenantSlug` in
 * apps/worker/src/main.ts).
 *
 * Both code paths MUST produce the same slug for a given tenant. If they
 * diverge, the API and worker write to different families, which means
 * inbound calls read whichever family the dialplan happens to match — a
 * silent slug-drift bug investigated 2026-05 against tenant "Secro Selutions"
 * (PBX directory slug `secro_selution`, Connect Tenant.name slug
 * `secro_selutions`).
 *
 * Selection order:
 *   1. The synced `PbxTenantDirectory.tenantSlug` (run through the same
 *      slugify rules so it can never carry forbidden characters).
 *   2. The Connect `Tenant.name` slug.
 *   3. The tenant id (already URL-safe; used only when both above are empty).
 */

/** Lowercase ASCII slug; same regex as `apps/api/src/server.ts toIvrSlug`. */
export function toCanonicalTenantSlug(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Pure slug-selection helper. Callers do the DB lookups and pass the resolved
 * inputs in. Returning the first non-empty result keeps API and worker behavior
 * identical when the directory slug is present, and falls back deterministically
 * to the Tenant.name slug otherwise.
 */
export function pickCanonicalTenantSlug(
  directorySlug: string | null | undefined,
  tenantName: string | null | undefined,
  tenantId: string,
): string {
  const fromDirectory = toCanonicalTenantSlug(directorySlug);
  if (fromDirectory) return fromDirectory;
  const fromName = toCanonicalTenantSlug(tenantName);
  if (fromName) return fromName;
  return toCanonicalTenantSlug(tenantId);
}
