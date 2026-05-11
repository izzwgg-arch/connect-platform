import type { Prisma } from "@connect/db";
import { db } from "@connect/db";
import { chooseExtensionForVoicemailNotify } from "./voicemailNotifyResolveExtensionCore";

export type VoicemailNotifyResolveExtensionRow = Prisma.ExtensionGetPayload<{ include: { pbxLink: true } }>;

export type VoicemailNotifyResolveResult = {
  extension: VoicemailNotifyResolveExtensionRow | null;
  reason: string;
};

/**
 * Resolve Extension for AMI MessageWaiting: mailbox digit + Asterisk voicemail context.
 * Never use findFirst(mailbox) alone — extNumber is only unique per tenant.
 */
export async function resolveExtensionForVoicemailNotify(
  mailbox: string,
  contextRaw: string,
): Promise<VoicemailNotifyResolveResult> {
  const mb = String(mailbox || "").trim();
  if (!mb) return { extension: null, reason: "empty_mailbox" };

  const candidates = await db.extension.findMany({
    where: { extNumber: mb, status: "ACTIVE" },
    include: { pbxLink: true },
  });

  const noLink = candidates.filter((c) => !c.pbxLink?.pbxExtensionId);
  const linked = candidates.filter((c) => c.pbxLink?.pbxExtensionId);
  if (linked.length === 0) {
    return { extension: null, reason: noLink.length ? "missing_pbx_extension_link" : "no_active_extension_for_mailbox" };
  }

  const ctx = String(contextRaw ?? "").trim().toLowerCase();

  const tenantMatchesVoicemailContext = async (tenantId: string): Promise<boolean> => {
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId } });
    if (!link?.pbxInstanceId) return false;
    const dir = await db.pbxTenantDirectory.findFirst({
      where: {
        pbxInstanceId: link.pbxInstanceId,
        tenantSlug: { equals: ctx, mode: "insensitive" },
        ...(link.pbxTenantId ? { vitalTenantId: link.pbxTenantId } : {}),
      },
    });
    return !!dir;
  };

  const syncScores = new Map<string, boolean>();
  for (const c of linked) {
    syncScores.set(c.tenantId, await tenantMatchesVoicemailContext(c.tenantId));
  }

  const { choice, reason } = chooseExtensionForVoicemailNotify(linked, contextRaw, (tid) => syncScores.get(tid) === true);
  return { extension: choice ?? null, reason };
}
