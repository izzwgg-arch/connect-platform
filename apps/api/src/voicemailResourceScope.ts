/**
 * Single source of truth for non–SUPER_ADMIN voicemail list + row access:
 * resolved tenant id set (cuid + vpbx: forms) × owned mailbox extensions.
 */

export type VoicemailOwnedScope = {
  tenantIds: string[];
  extensions: string[];
};

export function buildVoicemailListWhere(
  folder: "inbox" | "old" | "urgent",
  scope: VoicemailOwnedScope,
): Record<string, unknown> {
  const { tenantIds, extensions } = scope;
  return {
    deletedAt: null,
    folder,
    tenantId: tenantIds.length === 1 ? tenantIds[0] : { in: tenantIds },
    extension: extensions.length === 1 ? extensions[0] : { in: extensions },
  };
}

/** Row-level check — must match list Prisma `where` semantics. */
export function voicemailRowInOwnedScope(
  vm: { tenantId: string | null; extension: string },
  scope: VoicemailOwnedScope,
): boolean {
  if (!vm.tenantId) return false;
  if (!scope.tenantIds.includes(vm.tenantId)) return false;
  const ext = String(vm.extension || "").trim();
  return scope.extensions.includes(ext);
}
