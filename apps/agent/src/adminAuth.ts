/**
 * Admin-route authorization for the agent's `/agent/admin/*` + `/agent/diag/*`
 * HTTP surface (reachable from the public internet via nginx `/agent-api/`).
 *
 * ⛔ THE DISTINCTION THIS FILE EXISTS TO ENFORCE — and the bug it closes:
 * `requireOwner` (`id.role === "owner"`) admits SUPER_ADMIN *and* every
 * TENANT_ADMIN, because the agent maps TENANT_ADMIN → admin mode (2026-08-06,
 * correct for chat). But several `/agent/admin/*` routes are Connect-STAFF
 * consoles or take a body/param `tenantId` — so "admin mode" let a customer's
 * own admin (9 live accounts) read/write ACROSS tenants: platform LLM keys, any
 * tenant's policies/approvals/activity/incidents/trainer lessons, and — via the
 * chat `investigate` tool — raw SQL against both production databases.
 *
 * `resolveAdminCaller` returns admin-mode callers with an `isStaff` flag
 * (SUPER_ADMIN only, via `isPlatformStaff`). Routes then either require
 * `isStaff` (inherently global/cross-tenant consoles) or bind the tenant to the
 * caller's own unless `isStaff` (per-tenant operations). Fails closed: a bad or
 * missing token, or a non-admin, returns null.
 */
import { verifyPortalJwt } from "./auth";
import { isPlatformStaff } from "./authRoles";

export interface AdminCaller {
  /** The caller's OWN tenant, from the verified JWT. Never trust a body tenantId. */
  tenantId: string;
  clientUserId: string | null;
  /** True only for SUPER_ADMIN (Connect staff). A TENANT_ADMIN is false. */
  isStaff: boolean;
}

/**
 * Resolve an admin-mode caller from the request's bearer JWT, or null.
 * "Admin mode" = SUPER_ADMIN or TENANT_ADMIN (the agent's `role === "owner"`).
 * `isStaff` further narrows to Connect staff (SUPER_ADMIN) for staff-only routes.
 */
export function resolveAdminCaller(req: any): AdminCaller | null {
  const auth = req?.headers?.authorization;
  const id = typeof auth === "string" && auth.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
  if (!id || id.role !== "owner") return null;
  return {
    tenantId: id.tenantId,
    clientUserId: id.clientUserId,
    isStaff: isPlatformStaff(id.platformRole),
  };
}

/** Resolve a caller that must be Connect staff (SUPER_ADMIN), or null. */
export function resolveStaffCaller(req: any): AdminCaller | null {
  const caller = resolveAdminCaller(req);
  return caller?.isStaff ? caller : null;
}
