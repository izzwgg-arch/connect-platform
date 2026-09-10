/**
 * Pure helper functions for CRM email route logic.
 * Kept in a separate file so unit tests can import without pulling in DB/Redis/BullMQ.
 */

/** Platform admins can manage TENANT-scoped shared senders. */
export function isPlatformTenantSenderAdmin(user: { role?: string }): boolean {
  const r = String(user.role || "").toUpperCase();
  return r === "ADMIN" || r === "TENANT_ADMIN" || r === "SUPER_ADMIN";
}

/**
 * Platform admins or CRM ADMIN users can manage TENANT-scoped shared senders.
 * CRM MANAGER can send with a tenant sender, but cannot manage Google connection settings.
 */
export function canManageTenantSender(user: { role?: string }, crmAccessRole?: string | null): boolean {
  if (isPlatformTenantSenderAdmin(user)) return true;
  return String(crmAccessRole || "").toUpperCase() === "ADMIN";
}

export type CrmSenderRef = {
  id: string;
  scope: "USER" | "TENANT";
  userId?: string | null;
  isDefaultForTenant?: boolean;
};

/**
 * Pure implicit sender order for CRM sends. Explicit connectionId is handled by the caller.
 * CRM defaults to the tenant sender when present, then falls back to the caller's USER sender.
 */
export function resolveImplicitSenderConnectionOrder<T extends CrmSenderRef>(rows: T[], userId: string): T | null {
  const connectedTenantDefault = rows.find((r) => r.scope === "TENANT" && r.isDefaultForTenant);
  if (connectedTenantDefault) return connectedTenantDefault;

  const tenantRows = rows.filter((r) => r.scope === "TENANT");
  if (tenantRows.length === 1) return tenantRows[0];

  return rows.find((r) => r.scope === "USER" && r.userId === userId) || null;
}

/** The OAuth scope required for reply tracking (reading inbox metadata). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** True when the granted OAuth scopes include the Gmail read-only scope. */
export function hasReadonlyScope(scopes: string[]): boolean {
  return scopes.includes(GMAIL_READONLY_SCOPE);
}

/**
 * Derives the reply-tracking state for a CRM email connection.
 * - "healthy"     : tracking enabled and gmail.readonly scope granted (a grant
 *                   from before 2026-09-10 — the connect flow no longer asks for it)
 * - "unavailable" : gmail.readonly not granted. ⛔ NOT "reconnect to enable":
 *                   reply tracking is no longer offered (the scope is RESTRICTED at
 *                   Google and was dropped from the app on 2026-09-02), so a
 *                   reconnect can never obtain it. Screens must say so, not nag.
 * - "disabled"    : scope present but replyTrackingEnabled=false (backfill edge-case)
 * - "off"         : not configured (no scope, tracking flag is irrelevant)
 */
export type ReplyTrackingState = "healthy" | "unavailable" | "disabled" | "off";
export function replyTrackingStatus(
  c: { replyTrackingEnabled: boolean; scopes: string[] },
): ReplyTrackingState {
  const scope = hasReadonlyScope(c.scopes);
  if (c.replyTrackingEnabled && scope) return "healthy";
  if (!scope) return "unavailable";
  // scope present but tracking disabled — should be resolved by backfill migration
  return "disabled";
}
