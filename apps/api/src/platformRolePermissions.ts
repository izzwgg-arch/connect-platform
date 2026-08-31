import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  EMPTY_NAV_VISIBILITY,
  normalizeNavVisibility,
  expandLegacyPortalPermissions,
  isPortalPermissionKey,
  type PortalPermissionKey,
  type PortalNavVisibility,
} from "@connect/shared";
import { portalBucketFromJwtRole, PORTAL_ROLE_BUCKETS as SHARED_PORTAL_ROLE_BUCKETS } from "./userManagementRoles";
import { resolvePortalPermissionsWithCrmUserAccess } from "./crm/portalCrmPermissions";
import { invalidateAllPortalPermissions, withCachedRoleSnapshot } from "./permissionCache";

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

function rolesPayload(raw: unknown): {
  version: number;
  roles: SnapshotRoles;
  knownKeys: string[] | null;
  navVisibility: PortalNavVisibility;
} {
  if (!raw || typeof raw !== "object") {
    return { version: 1, roles: {}, knownKeys: null, navVisibility: { ...EMPTY_NAV_VISIBILITY } };
  }
  const obj = raw as SnapshotPayload & { version?: unknown; roles?: unknown; knownKeys?: unknown };
  const version = typeof (obj as { version?: unknown }).version === "number"
    ? Number((obj as { version: number }).version)
    : 1;
  const roles = version >= SNAPSHOT_VERSION && obj.roles && typeof obj.roles === "object"
    ? obj.roles
    : (obj as SnapshotRoles);
  const knownKeys = Array.isArray(obj.knownKeys)
    ? obj.knownKeys.map((x) => String(x).trim()).filter(Boolean)
    : null;
  // Sidebar visibility rides the SAME snapshot row as the role lists: it is
  // the same platform-wide navigation configuration, it is read on the same
  // hot path, and sharing the row means one cache and no migration.
  return {
    version,
    roles: roles || {},
    knownKeys,
    navVisibility: normalizeNavVisibility((obj as { navVisibility?: unknown }).navVisibility),
  };
}

/**
 * The set of permission keys that EXISTED the last time the snapshot was saved.
 *
 * Newer snapshots carry it explicitly as `knownKeys` (written by POST below).
 * Older v2 snapshots don't — but POST has always force-stored SUPER_ADMIN as
 * the complete key inventory of its day (see normalizeRolePermissionSet), so a
 * legacy row's stored SUPER_ADMIN list doubles as its write-time inventory.
 * Returns null when no inventory can be derived; callers must then treat the
 * stored lists literally (no forward-merge), because "new since the save" and
 * "removed by the admin" can no longer be told apart.
 */
function writeTimeKeyInventory(rawRoles: SnapshotRoles, knownKeys: string[] | null): Set<string> | null {
  if (knownKeys && knownKeys.length > 0) return new Set(knownKeys);
  const superList = Array.isArray(rawRoles.SUPER_ADMIN)
    ? (rawRoles.SUPER_ADMIN as unknown[]).map((x) => String(x).trim()).filter(Boolean)
    : [];
  return superList.length > 0 ? new Set(superList) : null;
}

const SECTION_PERMISSION_KEYS = new Set<string>(SIDEBAR_SECTIONS.map((s) => s.permission));
const SECTION_PERMISSION_BY_ID = new Map<string, string>(SIDEBAR_SECTIONS.map((s) => [s.id, s.permission]));
const ITEM_SECTION_PERMISSION = new Map<string, string>(
  SIDEBAR_ITEMS.map((i) => [i.permission as string, SECTION_PERMISSION_BY_ID.get(i.section) || ""]),
);

/**
 * Forward-merge: grant a bucket the DEFAULT keys that did not yet exist when
 * the snapshot was last saved. The snapshot is otherwise read literally, so a
 * feature shipped after the last save (Queues 2026-08-16, Conferences
 * 2026-08-20, ...) would never reach real tenant admins until a super admin
 * happened to re-save the permissions page. The inventory tells us which keys
 * the editor has actually SEEN: a default key outside it cannot have been
 * deliberately removed, so it is safe to add; a default key inside it but
 * absent from the bucket's list WAS deliberately removed and stays removed.
 *
 * Sidebar-item keys additionally require their section key to be effectively
 * granted — the same discipline as the can_view_admin_* back-merge below: if
 * the admin switched a whole section off, a new page inside that section must
 * not become reachable behind their back. New section keys merge first so a
 * genuinely new section (e.g. Tracking) brings its own pages with it.
 */
function forwardMergeNewDefaultKeys(
  set: Set<PortalPermissionKey>,
  bucket: PortalRoleBucket,
  inventory: Set<string> | null,
): void {
  if (!inventory || bucket === "SUPER_ADMIN") return;
  const candidates = DEFAULT_ROLE_PERMISSIONS[bucket].filter(
    (key) => !set.has(key) && !inventory.has(key as string),
  );
  for (const key of candidates) {
    if (SECTION_PERMISSION_KEYS.has(key as string)) set.add(key);
  }
  for (const key of candidates) {
    if (SECTION_PERMISSION_KEYS.has(key as string)) continue;
    const sectionKey = ITEM_SECTION_PERMISSION.get(key as string);
    if (sectionKey && !set.has(sectionKey as PortalPermissionKey)) continue;
    set.add(key);
  }
}

function normalizeStoredRoleList(
  rawRoles: SnapshotRoles,
  version: number,
  bucket: PortalRoleBucket,
  knownKeys: string[] | null = null,
): PortalPermissionKey[] {
  if (Object.prototype.hasOwnProperty.call(rawRoles, bucket)) {
    const normalized = normalizePermissionList(rawRoles[bucket]);
    const base = version >= SNAPSHOT_VERSION ? normalized : expandLegacyPortalPermissions(normalized);
    if (version >= SNAPSHOT_VERSION && bucket !== "SUPER_ADMIN") {
      const set = new Set(base);
      // Keys born after the snapshot's last save: grant them their default.
      forwardMergeNewDefaultKeys(set, bucket, writeTimeKeyInventory(rawRoles, knownKeys));
      // For TENANT_ADMIN: merge any missing can_view_admin_* page keys from
      // the current DEFAULT whose section gatekeeper is already granted. These keys are
      // absent because they were added to the can_view_admin expansion AFTER the snapshot
      // was last written — the admin could not have intentionally removed them.
      if (bucket === "TENANT_ADMIN" && set.has("can_view_section_admin" as PortalPermissionKey)) {
        for (const key of DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN) {
          if (!set.has(key) && (key as string).startsWith("can_view_admin_")) {
            set.add(key);
          }
        }
      }
      return normalizeRolePermissionSet([...set], bucket);
    }
    return normalizeRolePermissionSet(base, bucket);
  }
  return normalizeRolePermissionSet(DEFAULT_ROLE_PERMISSIONS[bucket], bucket);
}

function normalizeRolePermissionSet(input: unknown, bucket: PortalRoleBucket): PortalPermissionKey[] {
  const set = new Set(normalizePermissionList(input));
  if (bucket === "SUPER_ADMIN") {
    // Super admin always holds every currently-defined key regardless of snapshot age.
    // DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN = [...PORTAL_PERMISSION_KEYS], so the resolver
    // must match that intent. This also means newly-added keys never require a manual
    // snapshot update for super admins.
    for (const key of PORTAL_PERMISSION_KEYS) set.add(key);
  }
  return [...set];
}

/**
 * Reads the ONE global snapshot row. Every permission check on the platform hits
 * this, so it is memoized behind a short TTL — see permissionCache.ts. Writers
 * (POST /admin/role-permissions) must invalidate.
 */
async function loadSnapshotRoles(): Promise<ReturnType<typeof rolesPayload> | null> {
  return withCachedRoleSnapshot(async () => {
    const row = await db.platformRolePermissionSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
    if (!row || row.roles == null) return null;
    return rolesPayload(row.roles);
  });
}

/**
 * The platform-wide sidebar visibility record, for EVERY signed-in user.
 *
 * Rides the cached snapshot read, so it costs no extra query on the /me hot
 * path. ⛔ Fails OPEN: any read failure answers "nothing hidden", because a
 * database hiccup must leave the sidebar exactly as it was rather than empty
 * every customer's navigation. It can only ever hide a link — the permission
 * set and every server-side route gate are computed elsewhere and untouched.
 */
export async function getPortalNavVisibility(): Promise<PortalNavVisibility> {
  try {
    const snapshot = await loadSnapshotRoles();
    return snapshot ? snapshot.navVisibility : { ...EMPTY_NAV_VISIBILITY };
  } catch {
    return { ...EMPTY_NAV_VISIBILITY };
  }
}

export async function getEffectivePortalPermissionListForBucket(bucket: PortalRoleBucket): Promise<PortalPermissionKey[]> {
  const snapshot = await loadSnapshotRoles().catch(() => null);
  if (!snapshot) return [...DEFAULT_ROLE_PERMISSIONS[bucket]];
  return normalizeStoredRoleList(snapshot.roles, snapshot.version, bucket, snapshot.knownKeys);
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

/**
 * Permissions from a user's ACTIVE custom-role assignments.
 *
 * Custom roles are platform-wide: an admin in tenant A can assign a role to a
 * user who lives in tenant B, and the assignment row is stored under the
 * ADMIN's tenantId (see PUT /admin/users/:id/custom-roles). Therefore the
 * runtime lookup MUST scope by `userId` only — scoping by the user's own
 * tenantId silently drops every cross-tenant assignment (the historic
 * "custom role does nothing" bug). The `(userId, customRoleId)` unique index
 * guarantees no duplicate rows. `tenantId` is accepted for signature
 * compatibility but intentionally not used to filter assignments.
 */
export async function getEffectiveCustomRolePermissions(
  userId: string,
  _tenantId?: string | null,
): Promise<PortalPermissionKey[]> {
  try {
    const assignments = await db.userCustomRole.findMany({
      where: { userId, customRole: { active: true } },
      select: { customRole: { select: { permissions: true } } },
    });
    const out = new Set<PortalPermissionKey>();
    for (const a of assignments) {
      const perms = a.customRole.permissions;
      if (Array.isArray(perms)) {
        for (const p of perms) {
          if (isPortalPermissionKey(String(p))) out.add(String(p) as PortalPermissionKey);
        }
      }
    }
    return [...out];
  } catch {
    return [];
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
          ? normalizeStoredRoleList(snapshot.roles, snapshot.version, key, snapshot.knownKeys)
          : [...DEFAULT_ROLE_PERMISSIONS[key]];
      }
      return {
        permissions,
        version: SNAPSHOT_VERSION,
        keys: PORTAL_PERMISSION_KEYS,
        navVisibility: snapshot ? snapshot.navVisibility : { ...EMPTY_NAV_VISIBILITY },
      };
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
        // Optional on purpose. ⛔ An omitted field must PRESERVE what is
        // stored, never clear it: an older portal build (or any caller that
        // only means to change permissions) would otherwise un-hide every
        // page the owner had switched off, silently, on an unrelated save.
        navVisibility: z
          .object({
            hidden: z.array(z.string()).optional(),
            ownerOnlyLifted: z.array(z.string()).optional(),
          })
          .optional(),
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
      // knownKeys records which permission keys EXIST at save time. The reader's
      // forward-merge uses it to tell "added after this save" (grant the
      // default) from "deliberately removed by the admin" (stay removed).
      const storedVisibility = (await loadSnapshotRoles().catch(() => null))?.navVisibility;
      const navVisibility = body.navVisibility
        ? normalizeNavVisibility(body.navVisibility)
        : storedVisibility || { ...EMPTY_NAV_VISIBILITY };
      const payload = {
        version: SNAPSHOT_VERSION,
        roles: normalized,
        knownKeys: [...PORTAL_PERMISSION_KEYS],
        navVisibility,
      };
      await db.platformRolePermissionSnapshot.upsert({
        where: { id: SNAPSHOT_ID },
        create: { id: SNAPSHOT_ID, roles: payload },
        update: { roles: payload },
      });
      // Global snapshot — this changes the answer for every user on the platform.
      invalidateAllPortalPermissions();
      return { ok: true };
    } catch (err: any) {
      app.log.error({ err: err?.message }, "role-permissions: write failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });
}
