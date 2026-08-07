/**
 * "Give Yehuda permission to change the phone menus" — as a capability.
 *
 * The gates (password, single-use claim, params hash, tenant scoping, rate
 * limiting, audit) all live in `agentConfirmations.ts`. What is here is only
 * what is specific to a permission grant: who may hand one out, what sentence
 * describes it, and where the permission lands.
 */
import {
  NEVER_GRANTABLE_BY_CHAT,
  resolveChatGrantablePermission,
  chatGrantRoleName,
  grantParamsHashInput,
  GRANT_CAPABILITY_ID,
  isPortalPermissionKey,
  type PortalPermissionKey,
} from "@connect/shared";
import {
  refuse,
  type ConfirmCapability,
  type ConfirmDeps,
  type CapabilityContext,
} from "../agentConfirmations";

export type GrantParams = {
  targetUserId: string;
  targetEmail: string;
  permission: PortalPermissionKey;
};

export const permissionGrantCapability: ConfirmCapability<GrantParams> = {
  id: GRANT_CAPABILITY_ID,
  transactional: true, // pure DB work — a failure rolls the approval back

  parseParams(raw) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const targetUserId = typeof p.targetUserId === "string" ? p.targetUserId : "";
    const permission = typeof p.permission === "string" ? p.permission : "";
    const targetEmail = typeof p.targetEmail === "string" ? p.targetEmail : "";
    if (!targetUserId || !permission || !isPortalPermissionKey(permission)) return null;
    return { targetUserId, targetEmail, permission };
  },

  hashInput(tenantId, params) {
    return grantParamsHashInput(tenantId, params.targetUserId, params.permission);
  },

  async authorize(deps, ctx) {
    const { permission } = ctx.params;
    // Checked three ways, none of them the agent's word: a real key, one chat
    // is allowed to hand out, and one THIS actor personally holds.
    if (NEVER_GRANTABLE_BY_CHAT.has(permission) || !resolveChatGrantablePermission(permission)) {
      return {
        status: 403,
        error: "not_grantable_by_chat",
        message: "That permission has to be changed in the portal, not by chat.",
      };
    }
    const grantable = await deps.grantablePermissions(ctx.actor.role, ctx.actor.sub, ctx.actor.tenantId);
    if (!grantable.has(permission)) {
      return {
        status: 403,
        error: "not_yours_to_grant",
        message: "You can't hand out a permission you don't have yourself.",
      };
    }
    return null;
  },

  async describe(deps, ctx) {
    const plain = resolveChatGrantablePermission(ctx.params.permission)?.plain;
    if (!plain) return null;
    const target = await deps.db.user.findUnique({
      where: { id: ctx.params.targetUserId },
      select: { email: true, firstName: true, lastName: true, tenantId: true, status: true },
    });
    if (!target || target.tenantId !== ctx.tenantId || target.status === "DISABLED") return null;
    const who = [target.firstName, target.lastName].filter(Boolean).join(" ") || target.email;
    return {
      summary: `Give ${who} (${target.email}) permission to ${plain}.`,
      priceLine: null, // a permission costs nothing
    };
  },

  async execute(deps, ctx: CapabilityContext<GrantParams>, tx) {
    const { permission, targetUserId } = ctx.params;

    // The draft is minutes old — the person may have been deleted, disabled, or
    // moved to another company since it was written.
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, tenantId: true, status: true },
    });
    if (!target || target.tenantId !== ctx.tenantId || target.status === "DISABLED") {
      throw refuse(409, "target_unavailable", "That person is no longer on this account, so nothing was changed.");
    }

    // One visible, revocable role per recipient — not a permission sprinkled
    // somewhere nobody will ever find it again.
    const roleName = chatGrantRoleName(target.email, target.id);
    const role = await tx.customRole.upsert({
      where: { tenantId_name: { tenantId: ctx.tenantId, name: roleName } },
      create: {
        tenantId: ctx.tenantId,
        name: roleName,
        description: "Permissions granted through the assistant chat. Safe to edit or delete here.",
        active: true,
        // Deliberately empty: the add-step below is the ONE place a permission
        // enters the role, so "did they already have this?" is answered the
        // same way whether the role is brand new or years old.
        permissions: [],
        createdByUserId: ctx.actor.sub,
        updatedByUserId: ctx.actor.sub,
      },
      update: { active: true, updatedByUserId: ctx.actor.sub },
      select: { id: true, permissions: true },
    });

    const existing = Array.isArray(role.permissions)
      ? role.permissions.map((p: unknown) => String(p)).filter(isPortalPermissionKey)
      : [];
    const alreadyHeld = existing.includes(permission);
    if (!alreadyHeld) {
      await tx.customRole.update({
        where: { id: role.id },
        data: { permissions: [...existing, permission], updatedByUserId: ctx.actor.sub },
      });
    }

    await tx.userCustomRole.upsert({
      where: { userId_customRoleId: { userId: target.id, customRoleId: role.id } },
      create: {
        tenantId: ctx.tenantId,
        userId: target.id,
        customRoleId: role.id,
        assignedByUserId: ctx.actor.sub,
      },
      update: {},
    });

    const plain = resolveChatGrantablePermission(permission)?.plain ?? permission;
    return {
      message: alreadyHeld
        ? `${target.email} could already ${plain}, so nothing changed.`
        : `Done — ${target.email} can now ${plain}. You can undo this any time under Roles, in "${roleName}".`,
      details: { permission, targetEmail: target.email, roleName, alreadyHeld },
    };
  },
};
