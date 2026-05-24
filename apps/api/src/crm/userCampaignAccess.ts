import { db } from "@connect/db";
import type { CrmAuthUser } from "./guard";
import { isAdminRole } from "./guard";

/**
 * Returns assigned campaign ids when the user has explicit campaign restrictions.
 * Returns null when no rows exist (unrestricted — all tenant campaigns allowed).
 */
export async function getCrmUserCampaignRestriction(
  tenantId: string,
  userId: string,
): Promise<string[] | null> {
  const rows = await db.crmUserCampaignAssignment.findMany({
    where: { tenantId, userId },
    select: { campaignId: true },
  });
  if (!rows.length) return null;
  return rows.map((r) => r.campaignId);
}

/** Pure check: may this user access this campaign id given a preloaded restriction list? */
export function isCrmCampaignIdAllowed(
  campaignId: string,
  restriction: string[] | null,
  role: string | undefined,
): boolean {
  if (isAdminRole(role)) return true;
  if (!restriction) return true;
  return restriction.includes(campaignId);
}

export type CrmCampaignAccessResult = "ok" | "not_found" | "forbidden";

/** Pure resolver after tenant-scoped campaign existence is known. */
export function resolveCrmCampaignAccess(
  campaignExists: boolean,
  campaignId: string,
  restriction: string[] | null,
  role: string | undefined,
): CrmCampaignAccessResult {
  if (!campaignExists) return "not_found";
  if (!isCrmCampaignIdAllowed(campaignId, restriction, role)) return "forbidden";
  return "ok";
}

/** Campaign filter for non-admin CRM users with explicit campaign assignments. */
export async function crmCampaignScopeForUser(
  tenantId: string,
  userId: string,
  role: string | undefined,
): Promise<{ id: { in: string[] } } | Record<string, never>> {
  if (isAdminRole(role)) return {};
  const restricted = await getCrmUserCampaignRestriction(tenantId, userId);
  if (!restricted) return {};
  return { id: { in: restricted } };
}

type CampaignAccessReply = {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
};

/**
 * Verifies the campaign exists in the user's tenant and passes campaign allow-list rules.
 * Platform admins bypass allow-list. Returns false after sending 404 or 403 on reply.
 */
export async function assertCrmCampaignAllowed(
  user: Pick<CrmAuthUser, "sub" | "tenantId" | "role">,
  campaignId: string,
  reply: CampaignAccessReply,
): Promise<boolean> {
  const campaign = await db.crmCampaign.findFirst({
    where: { id: campaignId, tenantId: user.tenantId },
    select: { id: true },
  });

  const restriction = isAdminRole(user.role)
    ? null
    : await getCrmUserCampaignRestriction(user.tenantId, user.sub);

  const access = resolveCrmCampaignAccess(!!campaign, campaignId, restriction, user.role);
  if (access === "not_found") {
    reply.code(404).send({ error: "not_found" });
    return false;
  }
  if (access === "forbidden") {
    reply.code(403).send({ error: "forbidden", detail: "Campaign not assigned to this user." });
    return false;
  }

  return true;
}
