import { db } from "@connect/db";
import {
  resolveLeadTimezoneFromLocation,
  type LeadTimezoneResolution,
} from "./leadTimezoneResolver";

type AddressLike = {
  city?: string | null;
  state?: string | null;
};

export function pickPrimaryLeadLocation(
  addresses: AddressLike[] | null | undefined,
): { city: string | null; state: string | null } {
  const rows = addresses ?? [];
  const withLocation = rows.find((a) => (a.city ?? "").trim() || (a.state ?? "").trim());
  if (!withLocation) return { city: null, state: null };
  return {
    city: withLocation.city?.trim() || null,
    state: withLocation.state?.trim() || null,
  };
}

export function leadTimezoneFieldsFromResolution(resolution: LeadTimezoneResolution) {
  return {
    timezoneIana: resolution.timezoneIana,
    timezoneLabel: resolution.timezoneLabel,
    timezoneOffsetMinutes: resolution.timezoneOffsetMinutes,
    timezoneResolutionStatus: resolution.timezoneResolutionStatus,
    timezoneResolvedAt: new Date(),
  };
}

/** Persist timezone fields on CrmContactMeta. Creates meta row if missing. Never throws. */
export async function syncLeadTimezoneForContact(
  contactId: string,
  tenantId: string,
  location?: { city?: string | null; state?: string | null },
): Promise<LeadTimezoneResolution> {
  try {
    let city = location?.city ?? null;
    let state = location?.state ?? null;

    if (city == null && state == null) {
      const addresses = await db.contactAddress.findMany({
        where: { contactId },
        select: { city: true, state: true },
        orderBy: { createdAt: "asc" },
      });
      const picked = pickPrimaryLeadLocation(addresses);
      city = picked.city;
      state = picked.state;
    }

    const resolution = resolveLeadTimezoneFromLocation(city, state);
    const fields = leadTimezoneFieldsFromResolution(resolution);

    await db.crmContactMeta.upsert({
      where: { contactId },
      create: {
        contactId,
        tenantId,
        stage: "LEAD",
        ...fields,
      },
      update: fields,
    });

    return resolution;
  } catch {
    const fallback = resolveLeadTimezoneFromLocation(null, null);
    return fallback;
  }
}

export type LeadTimezoneBackfillResult = {
  processed: number;
  updated: number;
  resolved: number;
  needsReview: number;
  missingLocation: number;
  nextCursor: string | null;
  dryRun: boolean;
};

/** Idempotent tenant-scoped backfill for existing CRM leads. */
export async function backfillLeadTimezonesForTenant(
  tenantId: string,
  opts: { dryRun?: boolean; limit?: number; cursor?: string | null } = {},
): Promise<LeadTimezoneBackfillResult> {
  const dryRun = opts.dryRun === true;
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const cursor = opts.cursor ?? null;

  const metas = await db.crmContactMeta.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit,
    select: {
      id: true,
      contactId: true,
      timezoneIana: true,
      timezoneLabel: true,
      timezoneResolutionStatus: true,
      contact: {
        select: {
          addresses: {
            select: { city: true, state: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  let updated = 0;
  let resolved = 0;
  let needsReview = 0;
  let missingLocation = 0;

  for (const meta of metas) {
    const { city, state } = pickPrimaryLeadLocation(meta.contact.addresses);
    const resolution = resolveLeadTimezoneFromLocation(city, state);
    const unchanged =
      meta.timezoneIana === resolution.timezoneIana &&
      meta.timezoneLabel === resolution.timezoneLabel &&
      meta.timezoneResolutionStatus === resolution.timezoneResolutionStatus;

    if (resolution.timezoneResolutionStatus === "RESOLVED") resolved += 1;
    else if (resolution.timezoneResolutionStatus === "NEEDS_REVIEW") needsReview += 1;
    else missingLocation += 1;

    if (!unchanged) {
      updated += 1;
      if (!dryRun) {
        await db.crmContactMeta.update({
          where: { id: meta.id },
          data: leadTimezoneFieldsFromResolution(resolution),
        });
      }
    }
  }

  const nextCursor = metas.length === limit ? metas[metas.length - 1]?.id ?? null : null;

  return {
    processed: metas.length,
    updated,
    resolved,
    needsReview,
    missingLocation,
    nextCursor,
    dryRun,
  };
}
