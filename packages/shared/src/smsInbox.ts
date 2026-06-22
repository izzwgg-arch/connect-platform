import type { PortalPermissionKey } from "./portalPermissions";

export const SMS_INBOX_ASSIGNMENT_MODES = ["SHARED", "PERSONAL"] as const;
export type SmsInboxAssignmentMode = (typeof SMS_INBOX_ASSIGNMENT_MODES)[number];

export function normalizeSmsInboxAssignmentMode(value: unknown): SmsInboxAssignmentMode {
  return String(value || "").toUpperCase() === "PERSONAL" ? "PERSONAL" : "SHARED";
}

/** Dedupe key suffix: empty string = tenant-wide shared SMS inbox. */
export function resolveSmsInboxScope(input: {
  assignedUserId?: string | null;
  extensionOwnerUserId?: string | null;
}): string {
  if (input.assignedUserId) return input.assignedUserId;
  if (input.extensionOwnerUserId) return input.extensionOwnerUserId;
  return "";
}

export function buildSmsDedupeKey(
  tenantId: string,
  tenantE164: string,
  externalE164: string,
  inboxScope: string,
): string {
  return `sms:${tenantId}:${tenantE164}:${externalE164}:${inboxScope || ""}`;
}

/** True when the thread routes to all eligible tenant users (not a personal inbox). */
export function isSharedTenantSmsInbox(inboxScope: string): boolean {
  return inboxScope === "";
}

export function smsInboxScopeForAssignedUser(input: {
  userId: string;
  inboxMode?: unknown;
}): string {
  return normalizeSmsInboxAssignmentMode(input.inboxMode) === "PERSONAL" ? input.userId : "";
}

/**
 * Extension assigned but `ownerUserId` is null → inboxScope is "" (same as shared tenant inbox).
 * Kept intentionally: misconfigured numbers remain routable without breaking inbound SMS.
 */
export function isExtensionWithoutOwnerFallback(input: {
  assignedExtensionId?: string | null;
  extensionOwnerUserId?: string | null;
}): boolean {
  return Boolean(input.assignedExtensionId) && !input.extensionOwnerUserId;
}

export function isEligibleSharedSmsInboxParticipant(permissions: readonly PortalPermissionKey[]): boolean {
  return permissions.includes("can_send_sms") || permissions.includes("can_view_tenant_chats");
}

/** Portal permission path for SMS send (used together with legacy JWT role checks). */
export function canSendSmsByPortalPermission(permissions: readonly PortalPermissionKey[]): boolean {
  return permissions.includes("can_send_sms");
}
