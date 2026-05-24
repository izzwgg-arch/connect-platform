/**
 * Custom Role CRUD + user-assignment API routes.
 *
 * Security model:
 *  - SUPER_ADMIN  : can manage roles for any tenant (pass ?tenantId= or body.tenantId)
 *  - TENANT_ADMIN : can manage roles within their own tenantId only
 *  - END_USER     : blocked (403)
 *
 * Grantability:
 *  - SUPER_ADMIN can include any PortalPermissionKey in a role.
 *  - TENANT_ADMIN can only include permissions that are in their own effective
 *    permission set, minus PROTECTED_PLATFORM_ADMIN_PERMISSIONS.
 *
 * Permissions are additive only (union with built-in role bucket). No deny/override.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  PORTAL_PERMISSION_KEYS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  isPortalPermissionKey,
  type PortalPermissionKey,
  SIDEBAR_SECTIONS,
  SIDEBAR_ITEMS,
  ACTION_PERMISSION_KEYS,
} from "@connect/shared";
import { portalBucketFromJwtRole } from "./userManagementRoles";
import {
  getEffectivePortalPermissionListForBucket,
  getEffectiveCustomRolePermissions,
} from "./platformRolePermissions";
import { resolvePortalPermissionsWithCrmUserAccess } from "./crm/portalCrmPermissions";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getUser(req: any) {
  return req.user as { sub: string; tenantId: string; role: string; email: string };
}

function isSuperAdmin(role: string): boolean {
  return String(role).toUpperCase() === "SUPER_ADMIN";
}

function isTenantAdminOrAbove(role: string): boolean {
  const bucket = portalBucketFromJwtRole(role);
  return bucket === "SUPER_ADMIN" || bucket === "TENANT_ADMIN";
}

/**
 * Resolve which tenantId an actor is scoping their action to.
 * - SUPER_ADMIN: uses body/query tenantId if provided, otherwise their own.
 * - TENANT_ADMIN: always their own tenantId, never overridable.
 */
function resolveTargetTenantId(
  actorRole: string,
  actorTenantId: string,
  inputTenantId?: string | null,
): string {
  if (isSuperAdmin(actorRole) && inputTenantId && typeof inputTenantId === "string") {
    return inputTenantId;
  }
  return actorTenantId;
}

/**
 * The set of permissions an actor is allowed to grant inside a custom role.
 * SUPER_ADMIN → all keys.
 * TENANT_ADMIN → their effective permissions minus protected platform-admin keys.
 */
async function getGrantablePermissions(
  actorRole: string,
  actorUserId: string,
  actorTenantId: string,
): Promise<Set<PortalPermissionKey>> {
  if (isSuperAdmin(actorRole)) {
    return new Set(PORTAL_PERMISSION_KEYS);
  }
  const bucket = portalBucketFromJwtRole(actorRole);
  const basePerms = await getEffectivePortalPermissionListForBucket(bucket);
  const customPerms = await getEffectiveCustomRolePermissions(actorUserId, actorTenantId);
  const all = new Set<PortalPermissionKey>([...basePerms, ...customPerms]);
  for (const p of PROTECTED_PLATFORM_ADMIN_PERMISSIONS) all.delete(p);
  return all;
}

function normalizePermissions(raw: unknown): PortalPermissionKey[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x).trim()).filter(isPortalPermissionKey))] as PortalPermissionKey[];
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createRoleSchema = z.object({
  tenantId: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional().nullable(),
  active: z.boolean().optional().default(true),
  permissions: z.array(z.string()).optional().default([]),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
});

// ─── Route registration ───────────────────────────────────────────────────────

export async function registerCustomRoleRoutes(app: FastifyInstance) {

  // ── Permission catalog ──────────────────────────────────────────────────────
  app.get("/admin/custom-roles/permissions-catalog", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const grantable = await getGrantablePermissions(actor.role, actor.sub, actor.tenantId);
    return {
      keys: PORTAL_PERMISSION_KEYS,
      grantableKeys: [...grantable],
      sections: SIDEBAR_SECTIONS,
      items: SIDEBAR_ITEMS,
      actionKeys: ACTION_PERMISSION_KEYS,
    };
  });

  // ── List custom roles ───────────────────────────────────────────────────────
  app.get("/admin/custom-roles", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const query = req.query as { tenantId?: string };
    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, query.tenantId);

    const roles = await db.customRole.findMany({
      where: { tenantId },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        tenantId: true,
        name: true,
        description: true,
        active: true,
        permissions: true,
        createdAt: true,
        updatedAt: true,
        createdByUserId: true,
        updatedByUserId: true,
        _count: { select: { userAssignments: true } },
      },
    });

    return {
      roles: (roles as any[]).map((r) => ({
        ...r,
        userCount: r._count.userAssignments,
        _count: undefined,
      })),
    };
  });

  // ── Get single custom role ──────────────────────────────────────────────────
  app.get("/admin/custom-roles/:id", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { id } = req.params as { id: string };

    const role = await db.customRole.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        name: true,
        description: true,
        active: true,
        permissions: true,
        createdAt: true,
        updatedAt: true,
        createdByUserId: true,
        updatedByUserId: true,
        _count: { select: { userAssignments: true } },
      },
    });
    if (!role) return reply.code(404).send({ error: "not_found" });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, role.tenantId);
    if (role.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    return { role: { ...role, userCount: role._count.userAssignments, _count: undefined } };
  });

  // ── Create custom role ──────────────────────────────────────────────────────
  app.post("/admin/custom-roles", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = createRoleSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error", issues: body.error.issues });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, body.data.tenantId);
    const requestedPerms = normalizePermissions(body.data.permissions);
    const grantable = await getGrantablePermissions(actor.role, actor.sub, actor.tenantId);
    const blocked = requestedPerms.filter((p) => !grantable.has(p));
    if (blocked.length > 0) {
      return reply.code(403).send({ error: "ungrantable_permissions", blocked });
    }

    try {
      const role = await db.customRole.create({
        data: {
          tenantId,
          name: body.data.name,
          description: body.data.description ?? null,
          active: body.data.active ?? true,
          permissions: requestedPerms,
          createdByUserId: actor.sub,
          updatedByUserId: actor.sub,
        },
      });
      return reply.code(201).send({ role });
    } catch (err: any) {
      if (err?.code === "P2002") {
        return reply.code(409).send({ error: "name_conflict", message: "A role with that name already exists in this tenant." });
      }
      app.log.error({ err: err?.message }, "custom-roles: create failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });

  // ── Update custom role ──────────────────────────────────────────────────────
  app.put("/admin/custom-roles/:id", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { id } = req.params as { id: string };
    const body = updateRoleSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error", issues: body.error.issues });

    const existing = await db.customRole.findUnique({ where: { id }, select: { tenantId: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, existing.tenantId);
    if (existing.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    const updateData: Record<string, unknown> = { updatedByUserId: actor.sub };

    if (body.data.name !== undefined) updateData.name = body.data.name;
    if (body.data.description !== undefined) updateData.description = body.data.description;
    if (body.data.active !== undefined) updateData.active = body.data.active;

    if (body.data.permissions !== undefined) {
      const requestedPerms = normalizePermissions(body.data.permissions);
      const grantable = await getGrantablePermissions(actor.role, actor.sub, actor.tenantId);
      const blocked = requestedPerms.filter((p) => !grantable.has(p));
      if (blocked.length > 0) {
        return reply.code(403).send({ error: "ungrantable_permissions", blocked });
      }
      updateData.permissions = requestedPerms;
    }

    try {
      const role = await db.customRole.update({ where: { id }, data: updateData as any });
      return { role };
    } catch (err: any) {
      if (err?.code === "P2002") {
        return reply.code(409).send({ error: "name_conflict", message: "A role with that name already exists in this tenant." });
      }
      app.log.error({ err: err?.message }, "custom-roles: update failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });

  // ── Duplicate custom role ───────────────────────────────────────────────────
  app.post("/admin/custom-roles/:id/duplicate", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { id } = req.params as { id: string };
    const source = await db.customRole.findUnique({ where: { id } });
    if (!source) return reply.code(404).send({ error: "not_found" });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, source.tenantId);
    if (source.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    const baseName = `${source.name} (Copy)`;
    let newName = baseName;
    let attempt = 1;
    while (attempt < 20) {
      const exists = await db.customRole.findUnique({ where: { tenantId_name: { tenantId, name: newName } } });
      if (!exists) break;
      attempt++;
      newName = `${baseName} ${attempt}`;
    }

    const role = await db.customRole.create({
      data: {
        tenantId,
        name: newName,
        description: source.description,
        active: false,
        permissions: source.permissions ?? [],
        createdByUserId: actor.sub,
        updatedByUserId: actor.sub,
      },
    });
    return reply.code(201).send({ role });
  });

  // ── Delete custom role ──────────────────────────────────────────────────────
  app.delete("/admin/custom-roles/:id", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { id } = req.params as { id: string };
    const existing = await db.customRole.findUnique({
      where: { id },
      select: { tenantId: true, _count: { select: { userAssignments: true } } },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, existing.tenantId);
    if (existing.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    await db.customRole.delete({ where: { id } });
    return { ok: true };
  });

  // ── List users assigned to a custom role ────────────────────────────────────
  app.get("/admin/custom-roles/:id/users", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { id } = req.params as { id: string };
    const role = await db.customRole.findUnique({ where: { id }, select: { tenantId: true } });
    if (!role) return reply.code(404).send({ error: "not_found" });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, role.tenantId);
    if (role.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    const assignments = await db.userCustomRole.findMany({
      where: { customRoleId: id, tenantId },
      select: {
        id: true,
        createdAt: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true, displayName: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return { users: (assignments as any[]).map((a) => ({ ...a.user, assignedAt: a.createdAt, assignmentId: a.id })) };
  });

  // ── Get custom roles for a user ─────────────────────────────────────────────
  app.get("/admin/users/:userId/custom-roles", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { userId } = req.params as { userId: string };
    const query = req.query as { tenantId?: string };
    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, query.tenantId);

    const user = await db.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    if (user.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    const assignments = await db.userCustomRole.findMany({
      where: { userId, tenantId },
      select: {
        id: true,
        createdAt: true,
        customRole: { select: { id: true, name: true, description: true, active: true, permissions: true } },
      },
    });
    return { customRoles: (assignments as any[]).map((a) => ({ ...a.customRole, assignmentId: a.id, assignedAt: a.createdAt })) };
  });

  // ── Set custom role assignments for a user (replace) ────────────────────────
  app.put("/admin/users/:userId/custom-roles", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { userId } = req.params as { userId: string };
    const body = z.object({
      customRoleIds: z.array(z.string()),
      tenantId: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error", issues: body.error.issues });

    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, body.data.tenantId);

    const targetUser = await db.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
    if (!targetUser) return reply.code(404).send({ error: "not_found" });
    if (targetUser.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    const roleIds = body.data.customRoleIds;
    if (roleIds.length > 0) {
      const roles = await db.customRole.findMany({
        where: { id: { in: roleIds }, tenantId },
        select: { id: true },
      });
      if (roles.length !== roleIds.length) {
        return reply.code(400).send({ error: "invalid_role_ids", message: "One or more custom role IDs do not belong to this tenant." });
      }
    }

    await db.$transaction([
      db.userCustomRole.deleteMany({ where: { userId, tenantId } }),
      ...roleIds.map((customRoleId) =>
        db.userCustomRole.create({
          data: { tenantId, userId, customRoleId, assignedByUserId: actor.sub },
        }),
      ),
    ]);

    return { ok: true };
  });

  // ── Get effective permissions for a user ────────────────────────────────────
  app.get("/admin/users/:userId/effective-permissions", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { userId } = req.params as { userId: string };
    const query = req.query as { tenantId?: string };
    const tenantId = resolveTargetTenantId(actor.role, actor.tenantId, query.tenantId);

    const targetUser = await db.user.findUnique({
      where: { id: userId },
      select: { tenantId: true, role: true },
    });
    if (!targetUser) return reply.code(404).send({ error: "not_found" });
    if (targetUser.tenantId !== tenantId) return reply.code(403).send({ error: "forbidden" });

    const permissions = await resolvePortalPermissionsWithCrmUserAccess(
      targetUser.role,
      userId,
      tenantId,
    );

    return { userId, permissions: permissions ?? [], role: targetUser.role };
  });
}
