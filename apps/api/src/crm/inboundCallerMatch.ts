import { db } from "@connect/db";
import { normalizeUsCanadaToE164 } from "@connect/shared";
import { isAdminRole } from "./guard";
import { getCrmUserCampaignRestriction } from "./userCampaignAccess";

/** Optional CRM fields attached to inbound telephony call payloads (WS / snapshots). */
export type CrmInboundCallFields = {
  crmContactId: string;
  crmContactName: string;
  crmCompanyName?: string;
  crmProfileUrl: string;
  crmMatchSource: "exact" | "secondary" | "fallback_suffix";
};

export type InboundCrmMatchViewer = {
  userId: string;
  role?: string;
};

export type InboundCrmMatchRequest = {
  tenantId: string;
  phone: string;
  viewer: InboundCrmMatchViewer;
};

type TenantContactMatch = {
  contactId: string;
  displayName: string;
  company: string | null;
  matchSource: CrmInboundCallFields["crmMatchSource"];
};

function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Build normalized digit keys for ContactPhone.numberNormalized lookups. */
export function buildPhoneMatchCandidates(raw: string): {
  e164: string | null;
  normalizedKeys: string[];
  safeSuffix10: string | null;
} {
  const e164Result = normalizeUsCanadaToE164(raw);
  const e164 = e164Result.ok ? e164Result.e164 : null;
  const digits = digitsOnly(raw);
  const keys = new Set<string>();
  if (e164Result.ok) keys.add(e164Result.digits);
  if (digits) keys.add(digits);
  if (digits.length === 11 && digits.startsWith("1")) keys.add(digits.slice(1));
  if (digits.length === 10) keys.add("1" + digits);
  const safeSuffix10 =
    digits.length >= 10 ? digits.slice(-10) : null;
  return {
    e164,
    normalizedKeys: [...keys].filter(Boolean),
    safeSuffix10,
  };
}

function profileUrlForContact(contactId: string): string {
  return `/crm/contacts/${contactId}`;
}

/**
 * Tenant-scoped phone → contact match. Never throws.
 * Priority: exact normalized → additional ContactPhone rows (same query) → safe last-10 suffix.
 */
export async function matchTenantContactByPhone(
  tenantId: string,
  phone: string,
): Promise<TenantContactMatch | null> {
  if (!tenantId || !phone?.trim()) return null;

  const { normalizedKeys, safeSuffix10 } = buildPhoneMatchCandidates(phone);
  if (normalizedKeys.length === 0 && !safeSuffix10) return null;

  try {
    if (normalizedKeys.length > 0) {
      const exact = await db.contactPhone.findFirst({
        where: {
          numberNormalized: { in: normalizedKeys },
          contact: {
            tenantId,
            active: true,
            archivedAt: null,
          },
        },
        include: {
          contact: {
            select: {
              id: true,
              displayName: true,
              company: true,
            },
          },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });
      if (exact?.contact) {
        return {
          contactId: exact.contact.id,
          displayName: exact.contact.displayName,
          company: exact.contact.company ?? null,
          matchSource: exact.isPrimary ? "exact" : "secondary",
        };
      }
    }

    if (safeSuffix10 && safeSuffix10.length === 10) {
      const fallback = await db.contactPhone.findFirst({
        where: {
          numberNormalized: { endsWith: safeSuffix10 },
          contact: {
            tenantId,
            active: true,
            archivedAt: null,
          },
        },
        include: {
          contact: {
            select: {
              id: true,
              displayName: true,
              company: true,
            },
          },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });
      if (fallback?.contact) {
        return {
          contactId: fallback.contact.id,
          displayName: fallback.contact.displayName,
          company: fallback.contact.company ?? null,
          matchSource: "fallback_suffix",
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function userHasCrmAccess(
  tenantId: string,
  userId: string,
  role: string | undefined,
): Promise<boolean> {
  if (isAdminRole(role)) return true;
  const access = await db.crmUserAccess.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { enabled: true },
  });
  return !!access?.enabled;
}

async function userCanViewMatchedContact(
  tenantId: string,
  userId: string,
  role: string | undefined,
  contactId: string,
): Promise<boolean> {
  if (!(await userHasCrmAccess(tenantId, userId, role))) return false;
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

  if (meta?.assignedToUserId === userId) return true;
  if (campaignMember) return true;
  return false;
}

/**
 * Resolve CRM caller display fields for one viewer on an inbound/return call.
 * Returns null when CRM is off, no match, or viewer lacks access (no field leakage).
 */
export async function resolveInboundCrmCallerForViewer(
  input: InboundCrmMatchRequest,
): Promise<CrmInboundCallFields | null> {
  const { tenantId, phone, viewer } = input;
  if (!tenantId || !phone?.trim() || !viewer.userId) return null;

  const settings = await db.crmTenantSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  });
  if (!settings?.enabled) return null;

  const base = await matchTenantContactByPhone(tenantId, phone);
  if (!base) return null;

  const allowed = await userCanViewMatchedContact(
    tenantId,
    viewer.userId,
    viewer.role,
    base.contactId,
  );
  if (!allowed) return null;

  const fields: CrmInboundCallFields = {
    crmContactId: base.contactId,
    crmContactName: base.displayName,
    crmProfileUrl: profileUrlForContact(base.contactId),
    crmMatchSource: base.matchSource,
  };
  if (base.company) fields.crmCompanyName = base.company;
  return fields;
}
