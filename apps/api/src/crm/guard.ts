import { db } from "@connect/db";

// ── Types ──────────────────────────────────────────────────────────────────────

export type CrmAuthUser = {
  sub: string;
  tenantId: string;
  role?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export function isAdminRole(role: string | undefined): boolean {
  return role === "ADMIN" || role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
}

/** Body fields used to decide queue PATCH ownership (action + raw status path). */
export type CrmQueuePatchAuthInput = {
  action?: string;
  status?: string;
};

/**
 * Non–platform-admin CRM users may only PATCH queue members assigned to them.
 * Exception: `action: "assign-to-me"` is allowed for unassigned members, or when
 * already assigned to the caller (idempotent).
 *
 * Platform admins ({@link isAdminRole}) are never blocked here.
 *
 * @returns true when the caller must receive 403 (forbidden), not 404.
 */
export function isCrmQueuePatchOwnershipForbidden(
  role: string | undefined,
  userId: string,
  assignedToUserId: string | null | undefined,
  body: CrmQueuePatchAuthInput,
): boolean {
  if (isAdminRole(role)) return false;
  const assignee = assignedToUserId ?? null;
  if (body.action === "assign-to-me") {
    if (assignee == null) return false;
    if (assignee === userId) return false;
    return true;
  }
  if (assignee == null || assignee !== userId) return true;
  return false;
}

// ── CRM Access Guard ───────────────────────────────────────────────────────────

/**
 * Standard guard for all /crm/* routes except GET /crm/settings.
 *
 * The global Fastify onRequest hook already calls jwtVerify() for every route,
 * so req.user is already set when this guard runs. We only need to check
 * tenant CRM enablement and per-user CRM access.
 *
 * Error codes returned:
 *   crm_not_enabled      — tenant has not enabled CRM (or no settings row)
 *   crm_user_not_enabled — user has no CrmUserAccess row with enabled=true
 *                          (skipped for ADMIN / TENANT_ADMIN / SUPER_ADMIN roles)
 */
export async function requireCrmAccess(
  req: any,
  reply: any,
): Promise<CrmAuthUser | null> {
  const user = req.user as CrmAuthUser | undefined;
  if (!user?.sub) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }

  const { tenantId, sub: userId, role } = user;
  if (!tenantId) {
    reply.status(400).send({ error: "no_tenant" });
    return null;
  }

  // 1. Tenant CRM must be enabled
  const settings = await db.crmTenantSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  });
  if (!settings?.enabled) {
    reply
      .status(403)
      .send({ error: "crm_not_enabled", detail: "CRM is not enabled for this tenant" });
    return null;
  }

  // 2. Admin roles bypass per-user access check
  if (isAdminRole(role)) return user;

  // 3. Regular users must have an active CrmUserAccess row
  const access = await db.crmUserAccess.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { enabled: true },
  });
  if (!access?.enabled) {
    reply
      .status(403)
      .send({ error: "crm_user_not_enabled", detail: "CRM access not granted for this user" });
    return null;
  }

  return user;
}

/**
 * Admin-only guard: requires ADMIN / TENANT_ADMIN / SUPER_ADMIN role
 * AND tenant CRM enabled. Used for CRM management operations.
 */
export async function requireCrmAdmin(
  req: any,
  reply: any,
): Promise<CrmAuthUser | null> {
  const user = req.user as CrmAuthUser | undefined;
  if (!user?.sub) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }

  if (!isAdminRole(user.role)) {
    reply.status(403).send({ error: "crm_permission_denied", detail: "CRM admin access required" });
    return null;
  }

  const tenantId = user.tenantId;
  if (!tenantId) {
    reply.status(400).send({ error: "no_tenant" });
    return null;
  }

  const settings = await db.crmTenantSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  });
  if (!settings?.enabled) {
    reply
      .status(403)
      .send({ error: "crm_not_enabled", detail: "CRM is not enabled for this tenant" });
    return null;
  }

  return user;
}
