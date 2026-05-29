/**
 * Pure helper functions for CRM email route logic.
 * Kept in a separate file so unit tests can import without pulling in DB/Redis/BullMQ.
 */

/**
 * Admins (tenant or platform) can manage TENANT-scoped shared senders.
 * Mirrors the `isAdminRole` pattern in guard.ts for CRM email access.
 */
export function canManageTenantSender(user: { role?: string }): boolean {
  const r = String(user.role || "").toUpperCase();
  return r === "ADMIN" || r === "TENANT_ADMIN" || r === "SUPER_ADMIN" || r === "MANAGER";
}

/** The OAuth scope required for reply tracking (reading inbox metadata). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** True when the granted OAuth scopes include the Gmail read-only scope. */
export function hasReadonlyScope(scopes: string[]): boolean {
  return scopes.includes(GMAIL_READONLY_SCOPE);
}

/**
 * Derives the reply-tracking state for a CRM email connection.
 * - "healthy"   : tracking enabled and gmail.readonly scope granted
 * - "no_scope"  : gmail.readonly not in scopes — user must reconnect
 * - "disabled"  : scope present but replyTrackingEnabled=false (backfill edge-case)
 * - "off"       : not configured (no scope, tracking flag is irrelevant)
 */
export function replyTrackingStatus(
  c: { replyTrackingEnabled: boolean; scopes: string[] },
): "healthy" | "no_scope" | "disabled" | "off" {
  const scope = hasReadonlyScope(c.scopes);
  if (c.replyTrackingEnabled && scope) return "healthy";
  if (!scope) return "no_scope";
  // scope present but tracking disabled — should be resolved by backfill migration
  return "disabled";
}
