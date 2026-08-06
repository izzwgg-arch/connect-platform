/**
 * Who counts as an ADMIN in the agent — one source of truth.
 *
 * This existed in two places and both were wrong the same way: they treated
 * only SUPER_ADMIN as owner, so a TENANT_ADMIN — the customer's OWN admin, the
 * person who actually runs their phone system — was handed customer-level
 * access and could not do admin work through the agent (Izzy, 2026-08-06).
 *
 * Three ways to be an admin here:
 *   1. SUPER_ADMIN  — Connect staff (platform owner).
 *   2. TENANT_ADMIN — the tenant's own administrator.
 *   3. An active CustomRole literally named "owner" on that tenant.
 *
 * ⛔ (3) needs a database read, so it can NOT be decided from a JWT alone.
 * `mapUserRole` is the pure, synchronous part; `elevateForCustomOwnerRole` is
 * the async top-up. Callers that have a Prisma client should run both — a
 * caller that runs only the pure part fails CLOSED (customer), never open.
 *
 * Note this decides the agent's own admin *mode*. It is not a substitute for
 * the API's permission checks: a privileged write still goes through the
 * approval flow and the API's own `requireRoleOrPortalPermission`.
 */
import type { Role } from "./conversation/store";

/** Platform enum values that are admin-grade on sight. */
export const ADMIN_USER_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "TENANT_ADMIN"]);

/** Custom-role name (case-insensitive) that confers admin mode. */
export const OWNER_CUSTOM_ROLE_NAME = "owner";

/** Pure mapping from the platform UserRole enum. Fails closed. */
export function mapUserRole(role: string | null | undefined): Role {
  return ADMIN_USER_ROLES.has(String(role ?? "").trim().toUpperCase()) ? "owner" : "customer";
}

/**
 * Upgrade "customer" → "owner" when the user holds an ACTIVE custom role named
 * "owner" on this tenant. Already-owner input is returned untouched.
 *
 * Any lookup failure returns the input role — a database blip must never
 * silently promote someone.
 */
export async function elevateForCustomOwnerRole(
  prisma: any,
  input: { tenantId: string; clientUserId: string | null; role: Role },
): Promise<Role> {
  if (input.role === "owner" || !input.clientUserId || !prisma) return input.role;
  try {
    const hit = await prisma.userCustomRole.findFirst({
      where: {
        tenantId: input.tenantId,
        userId: input.clientUserId,
        customRole: {
          active: true,
          tenantId: input.tenantId,
          name: { equals: OWNER_CUSTOM_ROLE_NAME, mode: "insensitive" },
        },
      },
      select: { id: true },
    });
    return hit ? "owner" : input.role;
  } catch {
    return input.role;
  }
}
