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

/**
 * ⛔ CONNECT STAFF — a DIFFERENT question from `mapUserRole`, and conflating the
 * two cost the platform every tenant admin's escalations for two weeks.
 *
 * `mapUserRole` answers "does this person get ADMIN MODE in the agent?", and
 * since 2026-08-06 a TENANT_ADMIN — the customer's OWN administrator — answers
 * yes. `isPlatformStaff` answers a different question: "is this person US?"
 * Only SUPER_ADMIN is.
 *
 * The distinction matters wherever the agent decides whether to hand something
 * to Connect. Escalating to the platform owner is noise when the platform owner
 * is the one typing; it is the entire point when a customer's admin is typing.
 * `EscalationService` used the agent's "owner" mode for that decision, so from
 * 2026-08-06 every TENANT_ADMIN was told "I've passed this to the Connect team"
 * and nothing was ever passed — 93 promises across 3 tenants, measured
 * 2026-08-19 (Ezra's 2026-08-18 trainer session alone accounts for 48).
 *
 * ⛔ FAILS TOWARD ESCALATING. An unknown or missing role is NOT staff, so the
 * request reaches a person. A spurious escalation is a text somebody reads and
 * corrects; a dropped one is silence, and silence is the bug being fixed here.
 */
export const PLATFORM_STAFF_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN"]);

export function isPlatformStaff(platformRole: string | null | undefined): boolean {
  return PLATFORM_STAFF_ROLES.has(String(platformRole ?? "").trim().toUpperCase());
}
