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
