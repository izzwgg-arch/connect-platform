/**
 * The one list of permissions an owner may hand out BY CHAT, and the one list
 * that may never be handed out that way.
 *
 * ⛔ Why this lives in shared and not next to the agent: the grant is prepared
 * by `apps/agent` and applied by `apps/api`, and the API re-checks the deny-list
 * itself rather than trusting what the agent wrote. Two copies of a deny-list is
 * a deny-list that eventually disagrees with itself — and the half that drifts
 * open is the half that grants something it shouldn't.
 *
 * ⛔ No `node:crypto` here on purpose. This file is re-exported from the package
 * root, which the portal bundles for the browser. The hashing half lives in
 * `chatPermissionGrantHash.ts` (Node-only subpath import).
 */
import type { PortalPermissionKey } from "./portalPermissions";

/**
 * Permissions an owner may hand out by chat, keyed by how a person actually
 * says it. Every `key` is a REAL `PortalPermissionKey` — typed, so an invented
 * one is a compile error rather than a permission that silently never applies.
 */
export const CHAT_GRANTABLE_PERMISSIONS: Record<string, { key: PortalPermissionKey; plain: string }> = {
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
 * Deliberately NOT grantable by chat, however anyone phrases it. These either
 * cross tenant boundaries or can take the platform down; they stay in the
 * portal where the full context is on screen.
 */
export const NEVER_GRANTABLE_BY_CHAT: ReadonlySet<PortalPermissionKey> = new Set<PortalPermissionKey>([
  "can_manage_deploys",
  "can_switch_tenants",
  "can_manage_global_settings",
  "can_manage_voip_ms",
  "can_download_apk",
]);

/** Plain speech ("moh") or the raw key — but only if it is on the allow-list. */
export function resolveChatGrantablePermission(
  spoken: string,
): { key: PortalPermissionKey; plain: string } | null {
  const s = String(spoken ?? "").trim().toLowerCase();
  if (!s) return null;
  if (CHAT_GRANTABLE_PERMISSIONS[s]) return CHAT_GRANTABLE_PERMISSIONS[s];
  const byKey = Object.values(CHAT_GRANTABLE_PERMISSIONS).find((p) => p.key === s);
  return byKey ?? null;
}

/** The capability id every chat-prepared grant is filed under. */
export const GRANT_CAPABILITY_ID = "action.grant_permission";

/**
 * The exact string the approval hash is taken over. Defined once so the side
 * that WRITES the hash (agent, at prepare time) and the side that RECOMPUTES it
 * (api, at apply time) can never disagree — a disagreement here would either
 * reject every real grant or, worse, accept a tampered one.
 */
export function grantParamsHashInput(
  tenantId: string,
  targetUserId: string,
  permissionKey: string,
): string {
  return `grant_permission|${tenantId}|${targetUserId}|${permissionKey}`;
}

/**
 * Where every chat-granted permission for one person is collected. One visible,
 * revocable role per recipient beats permissions scattered across the account
 * with no record of where they came from.
 *
 * The portal's role editor caps a name at 80 characters, so a very long email
 * is shortened — but never to a bare prefix, which two people at the same long
 * domain could share. A truncated name carries the user id's tail, so two
 * recipients can never collapse into one role (which would hand a permission to
 * the wrong person).
 */
export const CHAT_GRANT_ROLE_PREFIX = "Assistant grants — ";
const CHAT_GRANT_ROLE_NAME_MAX = 80;

export function chatGrantRoleName(targetEmail: string, targetUserId: string): string {
  const email = String(targetEmail ?? "").trim().toLowerCase();
  const full = `${CHAT_GRANT_ROLE_PREFIX}${email}`;
  if (full.length <= CHAT_GRANT_ROLE_NAME_MAX) return full;
  const tail = ` (${String(targetUserId ?? "").slice(-8)})`;
  const room = CHAT_GRANT_ROLE_NAME_MAX - CHAT_GRANT_ROLE_PREFIX.length - tail.length - 1;
  return `${CHAT_GRANT_ROLE_PREFIX}${email.slice(0, Math.max(1, room))}…${tail}`;
}
