import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  expandLegacyPortalPermissions,
  isPortalPermissionKey,
  type PortalPermissionKey,
} from "@connect/shared";
import { portalBucketFromJwtRole, PORTAL_ROLE_BUCKETS as SHARED_PORTAL_ROLE_BUCKETS } from "./userManagementRoles";
import { resolvePortalPermissionsWithCrmUserAccess } from "./crm/portalCrmPermissions";

const SNAPSHOT_ID = "default";
const SNAPSHOT_VERSION = 2;

export { PORTAL_PERMISSION_KEYS };

const PORTAL_ROLE_BUCKETS = SHARED_PORTAL_ROLE_BUCKETS;
type PortalRoleBucket = (typeof PORTAL_ROLE_BUCKETS)[number];

type PortalUser = { sub?: string; tenantId?: string; email?: string; role?: string };
type SnapshotRoles = Partial<Record<PortalRoleBucket, unknown>>;
type SnapshotPayload = SnapshotRoles | { version?: unknown; roles?: SnapshotRoles };

function user(req: any): PortalUser {
  return req.user as PortalUser;
}

async function requireSuperAdminPortal(req: any, reply: any): Promise<PortalUser | null> {
  const u = user(req);
  if (u.role !== "SUPER_ADMIN") {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return u;
}

export function jwtRoleToPortalPermissionBucket(jwtRole: string | undefined): PortalRoleBucket {
  return portalBucketFromJwtRole(jwtRole);
}

function normalizePermissionList(input: unknown): PortalPermissionKey[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((x) => String(x).trim()).filter(Boolean))]
    .filter(isPortalPermissionKey);
}

function rolesPayload(raw: unknown): { version: number; roles: SnapshotRoles } {
  if (!raw || typeof raw !== "object") return { version: 1, roles: {} };
  const obj = raw as SnapshotPayload & { version?: unknown; roles?: unknown };
  const version = typeof (obj as { version?: unknown }).version === "number"
    ? Number((obj as { version: number }).version)
    : 1;
  const roles = version >= SNAPSHOT_VERSION && obj.roles && typeof obj.roles === "object"
    ? obj.roles
    : (obj as SnapshotRoles);
  return { version, roles: roles || {} };
}

function normalizeStoredRoleList(rawRoles: SnapshotRoles, version: number, bucket: PortalRoleBucket): PortalPermissionKey[] {
  if (Object.prototype.hasOwnProperty.call(rawRoles, bucket)) {
    const normalized = normalizePermissionList(rawRoles[bucket]);
    return normalizeRolePermissionSet(version >= SNAPSHOT_VERSION ? normalized : expandLegacyPortalPermissions(normalized), bucket);
  }
  return normalizeRolePermissionSet(DEFAULT_ROLE_PERMISSIONS[bucket], bucket);
}

function normalizeRolePermissionSet(input: unknown, bucket: PortalRoleBucket): PortalPermissionKey[] {
  const set = new Set(normalizePermissionList(input));
  if (bucket === "SUPER_ADMIN") {
    for (const key of PROTECTED_PLATFORM_ADMIN_PERMISSIONS) set.add(key);
  }
  return [...set];
}

async function loadSnapshotRoles(): Promise<{ version: number; roles: SnapshotRoles } | null> {
  const row = await db.platformRolePermissionSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
  if (!row || row.roles == null) return null;
  return rolesPayload(row.roles);
}

export async function getEffectivePortalPermissionListForBucket(bucket: PortalRoleBucket): Promise<PortalPermissionKey[]> {
  const snapshot = await loadSnapshotRoles().catch(() => null);
  if (!snapshot) return [...DEFAULT_ROLE_PERMISSIONS[bucket]];
  return normalizeStoredRoleList(snapshot.roles, snapshot.version, bucket);
}

export async function getEffectivePortalPermissionSetForJwtRole(
  jwtRole: string | undefined
): Promise<PortalPermissionKey[] | null> {
  const bucket = jwtRoleToPortalPermissionBucket(jwtRole);
  try {
    return await getEffectivePortalPermissionListForBucket(bucket);
  } catch {
    return null;
  }
}

export async function hasEffectivePortalPermission(
  user: PortalUser,
  permission: PortalPermissionKey,
): Promise<boolean> {
  const list =
    (await resolvePortalPermissionsWithCrmUserAccess(user.role, user.sub || "", user.tenantId)) ||
    DEFAULT_ROLE_PERMISSIONS[jwtRoleToPortalPermissionBucket(user.role)];
  return list.includes(permission);
}

export async function requirePortalPermission(
  req: any,
  reply: any,
  permission: PortalPermissionKey,
): Promise<PortalUser | null> {
  const u = user(req);
  if (!(await hasEffectivePortalPermission(u, permission))) {
    reply.code(403).send({ error: "forbidden", permission });
    return null;
  }
  return u;
}

export async function registerPlatformRolePermissionRoutes(app: FastifyInstance) {
  app.get("/admin/role-permissions", async (req, reply) => {
    const admin = await requireSuperAdminPortal(req, reply);
    if (!admin) return;
    try {
      const snapshot = await loadSnapshotRoles();
      const permissions: Partial<Record<PortalRoleBucket, PortalPermissionKey[]>> = {};
      for (const key of PORTAL_ROLE_BUCKETS) {
        permissions[key] = snapshot
          ? normalizeStoredRoleList(snapshot.roles, snapshot.version, key)
          : [...DEFAULT_ROLE_PERMISSIONS[key]];
      }
      return { permissions, version: SNAPSHOT_VERSION, keys: PORTAL_PERMISSION_KEYS };
    } catch (err: any) {
      app.log.error({ err: err?.message }, "role-permissions: read failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });

  app.post("/admin/role-permissions", async (req, reply) => {
    const admin = await requireSuperAdminPortal(req, reply);
    if (!admin) return;

    const body = z
      .object({
        permissions: z.record(z.string(), z.array(z.string())),
      })
      .parse(req.body || {});

    const normalized: Record<PortalRoleBucket, PortalPermissionKey[]> = {
      END_USER: [],
      TENANT_ADMIN: [],
      SUPER_ADMIN: [],
    };

    for (const key of Object.keys(body.permissions)) {
      if (!PORTAL_ROLE_BUCKETS.includes(key as PortalRoleBucket)) {
        return reply.code(400).send({ error: "invalid_role", message: `Unknown role key: ${key}` });
      }
    }

    for (const bucket of PORTAL_ROLE_BUCKETS) {
      normalized[bucket] = normalizeRolePermissionSet(body.permissions[bucket], bucket);
    }

    const missingProtectedSuperAdmin = PROTECTED_PLATFORM_ADMIN_PERMISSIONS.filter((key) => !normalized.SUPER_ADMIN.includes(key));
    if (missingProtectedSuperAdmin.length > 0) {
      return reply.code(400).send({
        error: "invalid_super_admin_permissions",
        message: "Platform Admin must retain access to Permissions Management.",
      });
    }

    try {
      await db.platformRolePermissionSnapshot.upsert({
        where: { id: SNAPSHOT_ID },
        create: { id: SNAPSHOT_ID, roles: { version: SNAPSHOT_VERSION, roles: normalized } },
        update: { roles: { version: SNAPSHOT_VERSION, roles: normalized } },
      });
      return { ok: true };
    } catch (err: any) {
      app.log.error({ err: err?.message }, "role-permissions: write failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });
}
