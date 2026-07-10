/**
 * Voicemail RBAC — deny-by-default helpers. List/stream/patch/delete in server.ts
 * must never widen scope based on client-supplied tenantId for non–super-admin users.
 */

/** Roles that may list or mutate any mailbox within their JWT tenant (portal / trusted staff). */
export function isTenantLevelVoicemailAdministrator(role: string | undefined): boolean {
  const r = role || "USER";
  return r === "TENANT_ADMIN" || r === "ADMIN";
}

/**
 * SEV-1 containment: when true (default), TENANT_ADMIN / ADMIN use the same
 * owned-mailbox scope as USER on /voice/voicemail (mobile + portal list route).
 * Set **`VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE=false`** only after explicit
 * approval to restore tenant-wide admin listing on this route.
 */
export function voicemailForceOwnedExtensionScope(): boolean {
  return (process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE || "true").toLowerCase() !== "false";
}

/**
 * Non–super-admin list/item access: owned mailboxes only vs legacy tenant-wide (admins).
 */
export function voicemailNonSuperAdminUsesOwnedMailboxesOnly(
  role: string | undefined,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return false;
  if (voicemailForceOwnedExtensionScope()) return true;
  return !isTenantLevelVoicemailAdministrator(role);
}

/**
 * After tenant match on the voicemail row: deny-by-default extension check.
 * Used by list `where`, stream, patch, and delete.
 */
export function userMayAccessVoicemailRowAfterTenantMatch(args: {
  vmExtension: string;
  userRole: string | undefined;
  ownedExtensions: string[];
}): boolean {
  if (voicemailNonSuperAdminUsesOwnedMailboxesOnly(args.userRole, false)) {
    return args.ownedExtensions.includes(args.vmExtension);
  }
  if (isTenantLevelVoicemailAdministrator(args.userRole)) return true;
  return args.ownedExtensions.includes(args.vmExtension);
}

/**
 * Read-state ownership for PATCH /voice/voicemail/:id.
 *
 * The listened/readAt flags belong to the mailbox owner, NOT to whoever is
 * merely permitted to view the mailbox. A user with the "see everybody's
 * voicemails" custom permission (`can_view_tenant_voicemails`), a tenant-wide
 * viewer, or a super-admin previewing another extension's voicemail must NOT
 * flip its read/unread state for the real owner — a voicemail is only "read"
 * once the extension's own user listens to it. Only when the acting user owns
 * the mailbox do we persist listened/readAt. Folder moves stay allowed for
 * anyone with access.
 *
 * Pure so it can be unit-tested without spinning up the server.
 */
export function computeVoicemailPatchUpdate(args: {
  body: { listened?: boolean; folder?: "inbox" | "old" | "urgent" };
  currentReadAt: Date | null;
  isOwnMailbox: boolean;
  now?: Date;
}): { data: Record<string, unknown>; readStateSkipped: boolean } {
  const { body, currentReadAt, isOwnMailbox } = args;
  const now = args.now ?? new Date();
  const listened = body.listened ?? true;
  // Preserve legacy default: a bare PATCH (no listened, no folder) means "mark read".
  const wantsReadStateChange = body.listened !== undefined || body.folder === undefined;
  const readStateSkipped = wantsReadStateChange && !isOwnMailbox;
  const data: Record<string, unknown> = {};
  if (wantsReadStateChange && isOwnMailbox) {
    data.listened = listened;
    data.readAt = listened ? (currentReadAt ?? now) : null;
  }
  if (body.folder !== undefined) {
    data.folder = body.folder;
  }
  return { data, readStateSkipped };
}
