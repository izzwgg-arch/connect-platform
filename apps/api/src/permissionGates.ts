/**
 * Shared decision helpers for action-permission gates.
 *
 * Two patterns are used when wiring previously-unenforced action permissions:
 *
 *  - Additive-OR (admin actions already gated by a role check today): allow when
 *    the existing role check passes OR the user effectively holds the new
 *    permission key. This never removes access from current role-based admins,
 *    and additionally lets authoritative custom roles grant the action.
 *
 *  - Owner carve-out (user-facing actions on personal data): allow when the user
 *    owns the resource OR effectively holds the permission key. Self-service is
 *    always preserved; acting on other users' data requires the permission.
 *
 * `decideActionGate` is a pure function so the policy is unit-testable without a
 * database; `userHasActionPermission` is the async resolver wrapper.
 */
import type { PortalPermissionKey } from "@connect/shared";
import { hasEffectivePortalPermission } from "./platformRolePermissions";

export type ActionGateInputs = {
  /** Platform super admin — always allowed, never weakened. */
  isSuperAdmin?: boolean;
  /** Existing role-based check result (additive-OR pattern). */
  roleAllowed?: boolean;
  /** User owns the target resource (owner carve-out for personal data). */
  isOwner?: boolean;
  /** User effectively holds the gating permission key. */
  hasKey?: boolean;
};

/** Pure gate decision — allow if any qualifying condition holds. */
export function decideActionGate(inputs: ActionGateInputs): boolean {
  return Boolean(inputs.isSuperAdmin || inputs.roleAllowed || inputs.isOwner || inputs.hasKey);
}

/** Resolve whether a user effectively holds a portal permission key (false on error). */
export async function userHasActionPermission(
  user: { sub?: string; tenantId?: string; role?: string; email?: string },
  key: PortalPermissionKey | string,
): Promise<boolean> {
  try {
    return await hasEffectivePortalPermission(user as any, key as any);
  } catch {
    return false;
  }
}
