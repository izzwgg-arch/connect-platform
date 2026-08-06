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
import { createHash } from "node:crypto";
import type { ToolSpec, ToolContext } from "./toolRegistry";

/**
 * Permissions an owner may hand out by chat, mapped from how a person actually
 * says it. Keys are REAL — taken from the API/portal source, never invented
 * (CLAUDE.md: grep the enum first; a made-up value fails silently).
 */
export const GRANTABLE_PERMISSIONS: Record<string, { key: string; plain: string }> = {
  ivr: { key: "can_manage_ivr_routing", plain: "change the phone menus (IVR routing)" },
  ivr_publish: { key: "can_publish_ivr_routing", plain: "publish phone-menu changes so callers hear them" },
  ivr_prompts: { key: "can_manage_ivr_prompts", plain: "change the recorded greetings used by the phone menus" },
  moh: { key: "can_manage_moh", plain: "change the music on hold" },
  moh_upload: { key: "can_upload_moh", plain: "upload new music on hold" },
  moh_publish: { key: "can_publish_moh", plain: "publish music-on-hold changes" },
  did_routing: { key: "can_manage_did_routing", plain: "change which phone number rings where" },
  call_forwarding: { key: "can_manage_call_forwarding", plain: "change call forwarding" },
  contacts: { key: "can_manage_contacts", plain: "manage the shared contact list" },
  sms: { key: "can_send_sms", plain: "send text messages" },
  tenant_settings: { key: "can_manage_tenant_settings", plain: "change company-wide settings" },
};

/**
 * Deliberately NOT grantable by chat, however the owner phrases it. These
 * either cross tenant boundaries or can take the platform down; they stay in
 * the portal where the full context is on screen.
 */
export const NEVER_GRANTABLE_BY_CHAT: ReadonlySet<string> = new Set([
  "can_manage_deploys",
  "can_switch_tenants",
  "can_manage_global_settings",
  "can_manage_voip_ms",
  "can_download_apk",
]);

export function resolvePermission(spoken: string): { key: string; plain: string } | null {
  const s = String(spoken ?? "").trim().toLowerCase();
  if (!s) return null;
  if (GRANTABLE_PERMISSIONS[s]) return GRANTABLE_PERMISSIONS[s];
  // Allow the raw permission key too, but only if it is on the allowlist.
  const byKey = Object.values(GRANTABLE_PERMISSIONS).find((p) => p.key === s);
  return byKey ?? null;
}

/** Binds an approval to this exact change — approving one grant can never apply another. */
export function permissionParamsHash(tenantId: string, targetUserId: string, permissionKey: string): string {
  return createHash("sha256").update(`grant_permission|${tenantId}|${targetUserId}|${permissionKey}`).digest("hex");
}

export const GRANT_CAPABILITY_ID = "action.grant_permission";

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
            requestedBy: ctx.clientUserId ?? "owner",
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
