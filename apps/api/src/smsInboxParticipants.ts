/**
 * Shared SMS inbox participant resolution (API + worker keep logic aligned).
 * Batch-loads tenant users, role snapshot, and custom roles once per fan-out.
 */

import { db } from "@connect/db";
import {
  DEFAULT_ROLE_PERMISSIONS,
  isEligibleSharedSmsInboxParticipant,
  isPortalPermissionKey,
  type PortalPermissionKey,
} from "@connect/shared";
import {
  getEffectivePortalPermissionListForBucket,
  jwtRoleToPortalPermissionBucket,
} from "./platformRolePermissions";

const PORTAL_BUCKETS = ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const;
type PortalBucket = (typeof PORTAL_BUCKETS)[number];

function normalizeCustomPermissions(raw: unknown): PortalPermissionKey[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
    .filter(isPortalPermissionKey);
}

async function loadBucketPermissions(): Promise<Record<PortalBucket, PortalPermissionKey[]>> {
  const lists = await Promise.all(PORTAL_BUCKETS.map((b) => getEffectivePortalPermissionListForBucket(b)));
  return {
    END_USER: lists[0] ?? [...DEFAULT_ROLE_PERMISSIONS.END_USER],
    TENANT_ADMIN: lists[1] ?? [...DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN],
    SUPER_ADMIN: lists[2] ?? [...DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN],
  };
}

/** Users who should receive shared tenant SMS inbox threads (view and/or send). */
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
    const bucket = jwtRoleToPortalPermissionBucket(u.role);
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
  /** Always include these user ids (e.g. outbound thread creator). */
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
