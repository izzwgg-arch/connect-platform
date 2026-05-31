/**
 * Shared SMS inbox participant resolution — keep aligned with apps/api/src/smsInboxParticipants.ts
 */

import { db } from "@connect/db";
import {
  DEFAULT_ROLE_PERMISSIONS,
  expandLegacyPortalPermissions,
  isEligibleSharedSmsInboxParticipant,
  isPortalPermissionKey,
  PORTAL_PERMISSION_KEYS,
  type PortalPermissionKey,
} from "@connect/shared";

const SNAPSHOT_ID = "default";
const SNAPSHOT_VERSION = 2;
const PORTAL_BUCKETS = ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const;
type PortalBucket = (typeof PORTAL_BUCKETS)[number];

function portalBucketFromJwtRole(jwtRole: string | undefined | null): PortalBucket {
  const r = String(jwtRole || "").toUpperCase();
  if (r === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (r === "TENANT_ADMIN") return "TENANT_ADMIN";
  if (["ADMIN", "BILLING", "BILLING_ADMIN", "MESSAGING", "SUPPORT", "MANAGER"].includes(r)) {
    return "TENANT_ADMIN";
  }
  return "END_USER";
}

function normalizePermissionList(input: unknown): PortalPermissionKey[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((x) => String(x).trim()).filter(Boolean))].filter(isPortalPermissionKey);
}

function normalizeStoredRoleList(rawRoles: Record<string, unknown>, version: number, bucket: PortalBucket): PortalPermissionKey[] {
  if (Object.prototype.hasOwnProperty.call(rawRoles, bucket)) {
    const normalized = normalizePermissionList(rawRoles[bucket]);
    return version >= SNAPSHOT_VERSION ? normalized : expandLegacyPortalPermissions(normalized);
  }
  return [...DEFAULT_ROLE_PERMISSIONS[bucket]];
}

async function loadBucketPermissions(): Promise<Record<PortalBucket, PortalPermissionKey[]>> {
  const row = await db.platformRolePermissionSnapshot.findUnique({ where: { id: SNAPSHOT_ID } }).catch(() => null);
  const payload = row?.roles && typeof row.roles === "object" ? (row.roles as { version?: number; roles?: Record<string, unknown> }) : null;
  const version = typeof payload?.version === "number" ? payload.version : 1;
  const roles = version >= SNAPSHOT_VERSION && payload?.roles ? payload.roles : (payload as Record<string, unknown> | null) ?? {};
  const out = {} as Record<PortalBucket, PortalPermissionKey[]>;
  for (const bucket of PORTAL_BUCKETS) {
    let perms = normalizeStoredRoleList(roles, version, bucket);
    if (bucket === "SUPER_ADMIN") {
      const set = new Set(perms);
      for (const key of PORTAL_PERMISSION_KEYS) set.add(key);
      perms = [...set];
    }
    out[bucket] = perms;
  }
  return out;
}

function normalizeCustomPermissions(raw: unknown): PortalPermissionKey[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].filter(isPortalPermissionKey);
}

export async function listSharedSmsInboxParticipantUserIds(tenantId: string): Promise<string[]> {
  const [users, bucketPerms, assignments] = await Promise.all([
    db.user.findMany({
      where: { tenantId },
      select: { id: true, role: true },
      orderBy: { email: "asc" },
      take: 500,
    }),
    loadBucketPermissions(),
    db.userCustomRole.findMany({
      where: { tenantId, customRole: { active: true } },
      select: { userId: true, customRole: { select: { permissions: true } } },
    }),
  ]);

  const customByUser = new Map<string, PortalPermissionKey[]>();
  for (const row of assignments) {
    const add = normalizeCustomPermissions(row.customRole.permissions);
    const prev = customByUser.get(row.userId) ?? [];
    customByUser.set(row.userId, [...new Set([...prev, ...add])]);
  }

  const eligible: string[] = [];
  for (const u of users) {
    const bucket = portalBucketFromJwtRole(u.role);
    const base = bucketPerms[bucket] ?? DEFAULT_ROLE_PERMISSIONS[bucket];
    const custom = customByUser.get(u.id) ?? [];
    const effective = [...new Set([...base, ...custom])] as PortalPermissionKey[];
    if (isEligibleSharedSmsInboxParticipant(effective)) eligible.push(u.id);
  }
  return eligible;
}

export async function upsertSmsThreadParticipants(input: {
  threadId: string;
  tenantId: string;
  inboxOwnerUserId: string;
  assignedExtensionId?: string | null;
  ensureUserIds?: string[];
}): Promise<void> {
  const userIds = input.inboxOwnerUserId
    ? [input.inboxOwnerUserId]
    : await listSharedSmsInboxParticipantUserIds(input.tenantId);

  const allUserIds = [...new Set([...userIds, ...(input.ensureUserIds ?? [])])];
  for (const uid of allUserIds) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: input.threadId, participantKey: `u:${uid}` } },
      create: { threadId: input.threadId, participantKey: `u:${uid}`, userId: uid, role: "MEMBER" },
      update: { leftAt: null },
    });
  }
  if (input.assignedExtensionId) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: input.threadId, participantKey: `e:${input.assignedExtensionId}` } },
      create: {
        threadId: input.threadId,
        participantKey: `e:${input.assignedExtensionId}`,
        extensionId: input.assignedExtensionId,
        role: "MEMBER",
      },
      update: { leftAt: null },
    });
  }
}
