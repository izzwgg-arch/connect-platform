import { db } from "@connect/db";
import { normalizeUsCanadaToE164 } from "@connect/shared";
import { isAdminRole } from "./guard";
import { userCanAccessCrmContact } from "./crmContactAccess";

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
  // ⛔ ContactPhone.numberNormalized is stored WITH the leading "+" in
  // production (verified live 2026-08-23: every sampled row reads
  // "+1XXXXXXXXXX"), so digit-only keys never hit the exact indexed branch
  // and every lookup silently fell through to the un-indexed endsWith scan.
  // Adding the +-forms makes the fast `in` match work for both shapes.
  if (e164Result.ok && e164) keys.add(e164);
  for (const k of [...keys]) {
    if (/^1\d{10}$/.test(k)) keys.add("+" + k);
  }
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

/**
 * The viewer's real identity, as read from the `User` row — never from the
 * request body.
 */
export type TrustedViewerIdentity = {
  tenantId: string;
  role: string;
  status: string;
};

export type TrustedViewerDecision = {
  /** false → answer with no match at all; never leak a field. */
  ok: boolean;
  /** The role the CRM access checks may use. Undefined when `ok` is false. */
  role?: string;
  reason?:
    | "user_not_found"
    | "user_disabled"
    | "tenant_mismatch";
};

/**
 * ⛔ THE RULE: the caller's ROLE is never taken from the request body.
 *
 * `POST /internal/telephony/inbound-crm-match` is an internal door — it carries
 * a shared secret, not a user session — so the body used to hand us both the
 * `tenantId` to search and the `viewer.role` to authorize with. Both
 * `userHasCrmAccess` and `userCanAccessCrmContact` open with
 * `if (isAdminRole(role)) return true`, so a body of
 * `{"viewer":{"role":"SUPER_ADMIN"}}` short-circuited every CRM access check
 * for every tenant. Anything holding the secret was a CRM contact oracle.
 *
 * This decides the role from the User row instead, and pins an admin's
 * bypass to their OWN tenant:
 *
 *  - the user must exist and must not be DISABLED (matches the login gate at
 *    `server.ts:5734` — anything stricter could refuse a legitimate live
 *    WebSocket viewer);
 *  - SUPER_ADMIN keeps cross-tenant reach on purpose: the platform admin's
 *    telephony feed carries other tenants' calls, so scoping them to their own
 *    tenant would silently drop enrichment they legitimately see today;
 *  - every other role (including TENANT_ADMIN and ADMIN) may only be used
 *    against the tenant that user belongs to. An admin of tenant A asking
 *    about tenant B gets nothing.
 *
 * Ordinary users were already safe — `crmUserAccess.findUnique({ tenantId_userId })`
 * is tenant-scoped — so the admin bypass was the whole hole.
 *
 * Pure on purpose, so the decision is testable without a database.
 */
export function decideTrustedViewerRole(
  requestedTenantId: string,
  identity: TrustedViewerIdentity | null,
): TrustedViewerDecision {
  if (!identity) return { ok: false, reason: "user_not_found" };
  if (identity.status === "DISABLED") return { ok: false, reason: "user_disabled" };
  if (identity.role !== "SUPER_ADMIN" && identity.tenantId !== requestedTenantId) {
    return { ok: false, reason: "tenant_mismatch" };
  }
  return { ok: true, role: identity.role };
}

/**
 * Resolve CRM caller display fields for one viewer on an inbound/return call.
 * Returns null when CRM is off, no match, or viewer lacks access (no field leakage).
 *
 * ⛔ `input.viewer.role` is DELIBERATELY IGNORED — see `decideTrustedViewerRole`.
 */
export async function resolveInboundCrmCallerForViewer(
  input: InboundCrmMatchRequest,
): Promise<CrmInboundCallFields | null> {
  const { tenantId, phone, viewer } = input;
  if (!tenantId || !phone?.trim() || !viewer.userId) return null;

  const identity = await db.user.findUnique({
    where: { id: viewer.userId },
    select: { tenantId: true, role: true, status: true },
  });
  const decision = decideTrustedViewerRole(
    tenantId,
    identity
      ? {
          tenantId: String(identity.tenantId),
          role: String(identity.role),
          status: String(identity.status),
        }
      : null,
  );
  if (!decision.ok) return null;
  const trustedRole = decision.role;

  const settings = await db.crmTenantSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  });
  if (!settings?.enabled) return null;

  const base = await matchTenantContactByPhone(tenantId, phone);
  if (!base) return null;

  if (!(await userHasCrmAccess(tenantId, viewer.userId, trustedRole))) return null;

  const allowed = await userCanAccessCrmContact(
    tenantId,
    viewer.userId,
    trustedRole,
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
