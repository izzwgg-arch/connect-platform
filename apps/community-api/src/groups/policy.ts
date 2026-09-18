/**
 * Pure decisions for the groups domain. Routes fetch rows and call these —
 * never re-derive a membership/visibility rule inline (CONVENTIONS §3).
 */

export type GroupRole = "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";
export type GroupMemberState = "ACTIVE" | "PENDING" | "BANNED" | "LEFT";

export type GroupShape = { isPrivate: boolean; requiresApproval: boolean };
export type MembershipShape = { role: GroupRole; state: GroupMemberState } | null;

/** Rank used to decide who can act on whom (owner > admin > moderator > member). */
const RANK: Record<GroupRole, number> = { OWNER: 3, ADMIN: 2, MODERATOR: 1, MEMBER: 0 };

export function isAdmin(m: MembershipShape): boolean {
  return !!m && m.state === "ACTIVE" && (m.role === "OWNER" || m.role === "ADMIN");
}

export function isModeratorOrAbove(m: MembershipShape): boolean {
  return !!m && m.state === "ACTIVE" && RANK[m.role] >= RANK.MODERATOR;
}

export function isActiveMember(m: MembershipShape): boolean {
  return !!m && m.state === "ACTIVE";
}

/** A non-member can see a public group's page; a private group shows only its name/description to a stranger. */
export function canSeeGroupDetail(group: GroupShape, m: MembershipShape): "full" | "preview" {
  if (isActiveMember(m)) return "full";
  return group.isPrivate ? "preview" : "full";
}

/** Whether a group post is visible: ACTIVE members always; a public group's posts are open to anyone. */
export function canSeeGroupPost(group: GroupShape, m: MembershipShape): boolean {
  if (isActiveMember(m)) return true;
  return !group.isPrivate;
}

export type JoinOutcome = "active" | "pending" | "blocked";

/** Public+no-approval joins straight in; requiresApproval queues; private groups are invite-only (the route 404s instead of calling this). */
export function joinOutcome(group: GroupShape): JoinOutcome {
  if (group.isPrivate) return "blocked";
  return group.requiresApproval ? "pending" : "active";
}

/** Only the owner may demote/ban/remove the owner; nobody may demote themselves out of being the last owner via this check (routes verify "last owner" separately). */
export function canActOnMember(actor: MembershipShape, target: MembershipShape): boolean {
  if (!isModeratorOrAbove(actor)) return false;
  if (!target) return true;
  if (target.role === "OWNER") return actor?.role === "OWNER";
  return RANK[actor!.role] > RANK[target.role] || actor?.role === "OWNER" || actor?.role === "ADMIN";
}

export const GROUP_ROLE_VALUES: GroupRole[] = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
export const GROUP_MEMBER_STATE_VALUES: GroupMemberState[] = ["ACTIVE", "PENDING", "BANNED", "LEFT"];
