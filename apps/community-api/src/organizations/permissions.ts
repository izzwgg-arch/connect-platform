import type { Db } from "../db.js";
import { forbidden, notFound } from "../lib/errors.js";
import type { Actor } from "../auth/actor.js";

/** Granular org permission keys (brief §1). Presets map to sets; CUSTOM uses the explicit list. */
export const ORG_PERMISSIONS = [
  "org.edit_page",
  "org.manage_members",
  "org.manage_roles",
  "org.post",
  "org.schedule_posts",
  "org.quote",
  "org.manage_rfqs",
  "org.hire",
  "org.manage_jobs",
  "org.manage_listings",
  "org.manage_events",
  "org.billing",
  "org.verify",
  "org.moderate",
  "org.view_analytics",
  "org.manage_locations",
  "org.delete",
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

const ALL = [...ORG_PERMISSIONS] as OrgPermission[];
export const ROLE_PRESETS: Record<string, OrgPermission[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== "org.delete"),
  MANAGER: ["org.edit_page", "org.post", "org.schedule_posts", "org.quote", "org.manage_rfqs", "org.manage_jobs", "org.hire", "org.manage_listings", "org.manage_events", "org.view_analytics", "org.manage_locations"],
  EMPLOYEE: [],
  RECRUITER: ["org.hire", "org.manage_jobs", "org.view_analytics"],
  SALES: ["org.quote", "org.manage_rfqs", "org.manage_listings", "org.view_analytics"],
  MARKETING: ["org.post", "org.schedule_posts", "org.manage_events", "org.edit_page", "org.view_analytics"],
  BILLING_ADMIN: ["org.billing", "org.view_analytics"],
  MODERATOR: ["org.moderate"],
  CUSTOM: [],
};

export function permissionsForMembership(m: { role: string; permissions: string[] }): Set<OrgPermission> {
  const base = ROLE_PRESETS[m.role] ?? [];
  return new Set<OrgPermission>([...base, ...(m.permissions as OrgPermission[])]);
}

export async function membershipOf(db: Db, personId: string, organizationId: string) {
  return db.membership.findUnique({ where: { personId_organizationId: { personId, organizationId } } });
}

export async function hasOrgPermission(db: Db, actor: Actor, organizationId: string, perm: OrgPermission): Promise<boolean> {
  if (actor.staffRole === "ADMIN") return true;
  const m = await membershipOf(db, actor.personId, organizationId);
  if (!m) return false;
  return permissionsForMembership(m).has(perm);
}

/** 404 when the org does not exist, 403 when the person lacks the permission. */
export async function requireOrgPermission(db: Db, actor: Actor, organizationId: string, perm: OrgPermission) {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, status: true } });
  if (!org) throw notFound("That company");
  if (!(await hasOrgPermission(db, actor, organizationId, perm))) {
    throw forbidden("You don't have that permission for this company. Ask an admin.");
  }
  return org;
}
