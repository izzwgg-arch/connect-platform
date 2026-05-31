import { db } from "@connect/db";
import type { CrmAuthUser } from "./guard";
import { crmRoleBypassesContactRestriction, isAdminRole, loadCrmUserAccessRole } from "./guard";
import { getCrmUserCampaignRestriction } from "./userCampaignAccess";

export type CrmContactScopeContext = {
  userId: string;
  platformRole?: string;
  crmAccessRole?: string | null;
  campaignRestriction?: string[] | null;
};

/** True when list/search queries must filter to assigned + allowed-campaign contacts only. */
export function shouldApplyCrmContactListScope(ctx: CrmContactScopeContext): boolean {
  if (isAdminRole(ctx.platformRole)) return false;
  if (crmRoleBypassesContactRestriction(ctx.crmAccessRole)) return false;
  return Array.isArray(ctx.campaignRestriction) && ctx.campaignRestriction.length > 0;
}

/** Prisma where fragment for Contact list/search (assigned OR member of allowed campaigns). */
export function buildCrmContactListScopeWhere(
  tenantId: string,
  ctx: CrmContactScopeContext,
): Record<string, unknown> | null {
  if (!shouldApplyCrmContactListScope(ctx)) return null;
  const restriction = ctx.campaignRestriction!;
  return {
    OR: [
      { crmMeta: { is: { tenantId, assignedToUserId: ctx.userId } } },
      {
        crmCampaignMembers: {
          some: {
            tenantId,
            campaignId: { in: restriction },
          },
        },
      },
    ],
  };
}

/** Prisma where fragment for CrmContactMeta aggregate queries (stats). */
export function buildCrmContactMetaListScopeWhere(
  tenantId: string,
  ctx: CrmContactScopeContext,
): Record<string, unknown> | null {
  if (!shouldApplyCrmContactListScope(ctx)) return null;
  const restriction = ctx.campaignRestriction!;
  return {
    OR: [
      { assignedToUserId: ctx.userId },
      {
        contact: {
          crmCampaignMembers: {
            some: {
              tenantId,
              campaignId: { in: restriction },
            },
          },
        },
      },
    ],
  };
}

/** Merge Prisma where clauses with AND (single clause returned as-is). */
export function mergeAndWhereClauses(
  ...clauses: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  const parts = clauses.filter(Boolean) as Record<string, unknown>[];
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { AND: parts };
}

/** Load campaign restriction + CRM role for list/search scope decisions. */
export async function resolveCrmContactScopeContext(
  user: Pick<CrmAuthUser, "sub" | "tenantId" | "role">,
): Promise<CrmContactScopeContext> {
  if (isAdminRole(user.role)) {
    return {
      userId: user.sub,
      platformRole: user.role,
      crmAccessRole: null,
      campaignRestriction: null,
    };
  }
  const [crmAccessRole, campaignRestriction] = await Promise.all([
    loadCrmUserAccessRole(user.tenantId, user.sub),
    getCrmUserCampaignRestriction(user.tenantId, user.sub),
  ]);
  return {
    userId: user.sub,
    platformRole: user.role,
    crmAccessRole,
    campaignRestriction,
  };
}

export type CrmContactAccessResult = "ok" | "not_found" | "forbidden";

/** Pure resolver after tenant-scoped contact existence is known. */
export function resolveCrmContactAccess(
  contactExists: boolean,
  userId: string,
  assignedToUserId: string | null | undefined,
  inAllowedCampaign: boolean,
  restriction: string[] | null,
  role: string | undefined,
  crmAccessRole?: string | null,
): CrmContactAccessResult {
  if (!contactExists) return "not_found";
  if (isAdminRole(role)) return "ok";
  if (crmRoleBypassesContactRestriction(crmAccessRole)) return "ok";
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
  crmAccessRole?: string | null,
): Promise<boolean> {
  if (isAdminRole(role)) return true;

  const resolvedCrmRole =
    crmAccessRole !== undefined ? crmAccessRole : await loadCrmUserAccessRole(tenantId, userId);
  if (crmRoleBypassesContactRestriction(resolvedCrmRole)) return true;

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
    resolvedCrmRole,
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
