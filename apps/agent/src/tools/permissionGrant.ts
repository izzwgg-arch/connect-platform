/**
 * "Give Yehuda permission to change the IVRs" — the PREPARE half.
 *
 * ⛔ THIS FILE NEVER GRANTS ANYTHING. It writes a DRAFT AgentAction describing
 * exactly one permission change and hands back a plain-English summary. The
 * grant is applied by the API only after the portal has re-checked the
 * requester's password, and the API re-verifies authority on its own.
 *
 * Why the split (Izzy, 2026-08-06 — "the agent should prompt a pop-up to enter
 * the account password"):
 *   - Anything the agent receives passes through a language model and lands in
 *     conversation history and the audit log. A password must never go there.
 *   - If the agent were the thing checking the password, anyone who could talk
 *     the agent into a mistake could grant themselves admin. The password check
 *     exists precisely to be something the agent cannot be argued out of.
 *
 * So: agent drafts → portal asks for the password → API applies and re-checks.
 */
import type { ToolSpec, ToolContext } from "./toolRegistry";
import {
  CHAT_GRANTABLE_PERMISSIONS,
  NEVER_GRANTABLE_BY_CHAT,
  resolveChatGrantablePermission,
  GRANT_CAPABILITY_ID,
} from "@connect/shared";
import { permissionParamsHash } from "@connect/shared/chatPermissionGrantHash";

/**
 * ⛔ The allow-list, the deny-list and the approval hash live in
 * `@connect/shared` — because the API re-checks all three when it applies the
 * grant, and a second copy here is a copy that eventually drifts open.
 * Re-exported under the original names so this module stays the one place the
 * agent side reads them from.
 */
export { NEVER_GRANTABLE_BY_CHAT, GRANT_CAPABILITY_ID, permissionParamsHash };
export const GRANTABLE_PERMISSIONS = CHAT_GRANTABLE_PERMISSIONS;
export const resolvePermission = resolveChatGrantablePermission;

export interface PermissionGrantDeps {
  prisma: any;
}

export function buildPermissionTools(deps: PermissionGrantDeps): ToolSpec[] {
  return [
    {
      name: "prepare_permission_grant",
      description:
        "Prepare (do NOT apply) giving one person one permission on this account — for example letting someone change the phone menus or the music on hold. " +
        "Returns a summary and a confirmation id. The change only takes effect after the person asking re-enters their own account password in the app, " +
        "so always tell them a password prompt is coming. If the permission asked for is not one you can prepare, say so plainly instead of guessing.",
      minRole: "internal",
      parameters: {
        type: "object",
        properties: {
          targetEmail: { type: "string", description: "Email address of the person who should receive the permission." },
          permission: {
            type: "string",
            description: `What they should be allowed to do. One of: ${Object.keys(GRANTABLE_PERMISSIONS).join(", ")}.`,
          },
        },
        required: ["targetEmail", "permission"],
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        const perm = resolvePermission(String(args.permission ?? ""));
        if (!perm) {
          return {
            ok: false,
            error: "unknown_permission",
            message: "I can't grant that one from chat. I can prepare: " +
              Object.values(GRANTABLE_PERMISSIONS).map((p) => p.plain).join("; ") + ".",
          };
        }
        if (NEVER_GRANTABLE_BY_CHAT.has(perm.key)) {
          return { ok: false, error: "not_grantable_by_chat", message: "That permission has to be changed in the portal, not by chat." };
        }

        const email = String(args.targetEmail ?? "").trim().toLowerCase();
        if (!email) return { ok: false, error: "no_target", message: "Tell me which person, by their email address." };

        // ⛔ A draft is offered back to the person who asked, by user id — that
        // is how the portal finds it and how the password is bound to a human.
        // A server-to-server conversation has nobody to confirm it, so a draft
        // written there would sit forever with no way to apply or cancel it.
        if (!ctx.clientUserId) {
          return {
            ok: false,
            error: "no_requester",
            message: "This has to be asked for from a signed-in account, because it needs a password to confirm.",
          };
        }

        // ⛔ Scoped to the caller's own tenant. Someone in another company
        // simply does not exist from here.
        const target = await deps.prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" }, tenantId: ctx.tenantId },
          select: { id: true, email: true, firstName: true, lastName: true, status: true },
        });
        if (!target) {
          return { ok: false, error: "user_not_found", message: `I couldn't find anyone on this account with the email ${email}.` };
        }

        const who = [target.firstName, target.lastName].filter(Boolean).join(" ") || target.email;
        const summary = `Give ${who} (${target.email}) permission to ${perm.plain}.`;

        const action = await deps.prisma.agentAction.create({
          data: {
            tenantId: ctx.tenantId,
            capabilityId: GRANT_CAPABILITY_ID,
            params: { targetUserId: target.id, targetEmail: target.email, permission: perm.key },
            riskTier: "high",
            status: "DRAFT",
            summary,
            requestedBy: ctx.clientUserId,
            requestedRole: ctx.role,
            paramsHash: permissionParamsHash(ctx.tenantId, target.id, perm.key),
          },
          select: { id: true },
        });

        return {
          ok: true,
          actionId: action.id,
          summary,
          // The model must tell the user this — the change is NOT done yet.
          requiresPasswordConfirmation: true,
          message: `${summary} This is not applied yet — confirm it with your account password and it will take effect.`,
        };
      },
    },
  ];
}
