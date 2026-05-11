/**
 * Voicemail RBAC — deny-by-default helpers. List/stream/patch/delete in server.ts
 * must never widen scope based on client-supplied tenantId for non–super-admin users.
 */

/** Roles that may list or mutate any mailbox within their JWT tenant (portal / trusted staff). */
export function isTenantLevelVoicemailAdministrator(role: string | undefined): boolean {
  const r = role || "USER";
  return r === "TENANT_ADMIN" || r === "ADMIN";
}
