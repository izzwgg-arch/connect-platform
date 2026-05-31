import { db } from "@connect/db";
import type { CrmAuthUser } from "./guard";
import { isAdminRole } from "./guard";
import { getCrmUserCampaignRestriction } from "./userCampaignAccess";

export type CrmContactAccessResult = "ok" | "not_found" | "forbidden";

/** Pure resolver after tenant-scoped contact existence is known. */
export function resolveCrmContactAccess(
  contactExists: boolean,
  userId: string,
  assignedToUserId: string | null | undefined,
  inAllowedCampaign: boolean,
  restriction: string[] | null,
  role: string | undefined,
): CrmContactAccessResult {
  if (!contactExists) return "not_found";
  if (isAdminRole(role)) return "ok";
  if (!restriction) return "ok";
  if (assignedToUserId === userId) return "ok";
  if (inAllowedCampaign) return "ok";
  return "forbidden";
}

/**
 * Whether a CRM user may access a contact for email, screen-pop, etc.
 * Platform admins bypass campaign restrictions; restricted users need assignment or campaign membership.
 */
export async function userCanAccessCrmContact(
  tenantId: string,
  userId: string,
  role: string | undefined,
  contactId: string,
): Promise<boolean> {
  if (isAdminRole(role)) return true;

  const restriction = await getCrmUserCampaignRestriction(tenantId, userId);
  if (!restriction) return true;

  const [meta, campaignMember] = await Promise.all([
    db.crmContactMeta.findFirst({
      where: { contactId, tenantId },
      select: { assignedToUserId: true },
    }),
    db.crmCampaignMember.findFirst({
      where: {
        contactId,
        tenantId,
        campaignId: { in: restriction },
      },
      select: { id: true },
    }),
  ]);

  return resolveCrmContactAccess(
    true,
    userId,
    meta?.assignedToUserId,
    !!campaignMember,
    restriction,
    role,
  ) === "ok";
}

type ContactAccessReply = {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
};

/** Returns false after sending 404 or 403 on reply. */
export async function assertCrmContactAllowed(
  user: Pick<CrmAuthUser, "sub" | "tenantId" | "role">,
  contactId: string,
  reply: ContactAccessReply,
): Promise<boolean> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!contact) {
    reply.code(404).send({ error: "contact_not_found" });
    return false;
  }

  const allowed = await userCanAccessCrmContact(user.tenantId, user.sub, user.role, contactId);
  if (!allowed) {
    reply.code(403).send({ error: "forbidden", detail: "Contact not in your CRM scope." });
    return false;
  }

  return true;
}
