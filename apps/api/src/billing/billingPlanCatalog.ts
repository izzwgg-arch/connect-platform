/**
 * SUPER_ADMIN billing catalog helpers: BillingPlan slug validation,
 * usage aggregation for platform routes, and audit logging onto BillingEventLog
 * via a sentinel tenant row (schema requires tenantId — see logBillingCatalogEvent).
 */

import { z } from "zod";
import { logBillingEvent } from "./invoiceEngine";

/** ~$250k/unit — sanity ceiling for recurring line-unit prices only. */
export const BILLING_PLAN_PRICE_MAX_CENTS = 25_000_000;

/** Lowercase alphanumeric, hyphens and underscores inside; ends must be alphanumeric. Min length 2. */
const BILLING_PLAN_CODE_REGEX = /^(?:[a-z0-9]{2}|[a-z0-9][a-z0-9_-]*[a-z0-9])$/;

export const billingPlanCodeSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(BILLING_PLAN_CODE_REGEX, "billing_plan_code_invalid_slug");

const priceField = () =>
  z.number().int().min(0, "billing_plan_price_invalid").max(BILLING_PLAN_PRICE_MAX_CENTS, "billing_plan_price_too_large");

export const billingPlanCreateBodySchema = z.object({
  code: billingPlanCodeSlugSchema,
  name: z.string().min(1).max(200),
  extensionPriceCents: priceField(),
  additionalPhoneNumberPriceCents: priceField(),
  smsPriceCents: priceField(),
  firstPhoneNumberFree: z.boolean(),
  active: z.boolean().optional().default(true),
});

export type BillingPlanCreateBody = z.infer<typeof billingPlanCreateBodySchema>;

export const billingPlanPatchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    extensionPriceCents: priceField().optional(),
    additionalPhoneNumberPriceCents: priceField().optional(),
    smsPriceCents: priceField().optional(),
    firstPhoneNumberFree: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type BillingPlanPatchBody = z.infer<typeof billingPlanPatchBodySchema>;

export const billingPlanCloneBodySchema = z
  .object({
    code: billingPlanCodeSlugSchema,
    name: z.string().min(1).max(200),
  })
  .strict();

export type BillingPlanTenantPreviewRow = { id: string; name: string };

export type BillingPlanUsageCounts = {
  currentTenantCount: number;
  scheduledTenantCount: number;
};

/** Catalog billing plans live with tenantId=null (tenant-private rows ignored by platform APIs). */
export const CATALOG_BILLING_PLAN_FILTER = { tenantId: null } as const;

/** Prisma `where` for platform GET /billing-plans list. */
export function catalogBillingPlansListWhere(includeInactive: boolean): Record<string, unknown> {
  return {
    ...CATALOG_BILLING_PLAN_FILTER,
    ...(includeInactive ? {} : { active: true }),
  };
}

const PREVIEW_LIMIT = 25;

type AnyDb = {
  tenantBillingSettings: {
    groupBy: (args: unknown) => Promise<Array<{ billingPlanId?: string | null; nextBillingPlanId?: string | null; _count?: { _all: number } }>>;
    findMany: (args: unknown) => Promise<Array<{ tenant: { id: string; name: string } | null }>>;
  };
  billingPlan: { findUnique: (args: unknown) => unknown };
  tenant: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
};

export async function aggregateBillingPlanUsageCounts(db: AnyDb, planIds: string[]): Promise<Map<string, BillingPlanUsageCounts>> {
  const empty = (): BillingPlanUsageCounts => ({ currentTenantCount: 0, scheduledTenantCount: 0 });
  const merged = new Map<string, BillingPlanUsageCounts>();
  for (const id of planIds) merged.set(id, empty());
  if (planIds.length === 0) return merged;

  const [currentGroups, scheduledGroups] = await Promise.all([
    (db as AnyDb).tenantBillingSettings.groupBy({
      by: ["billingPlanId"],
      where: { billingPlanId: { in: planIds } },
      _count: { _all: true },
    }) as Promise<Array<{ billingPlanId: string | null; _count: { _all: number } }>>,
    (db as AnyDb).tenantBillingSettings.groupBy({
      by: ["nextBillingPlanId"],
      where: { nextBillingPlanId: { in: planIds } },
      _count: { _all: true },
    }) as Promise<Array<{ nextBillingPlanId: string | null; _count: { _all: number } }>>,
  ]);

  for (const g of currentGroups) {
    const id = g.billingPlanId;
    if (!id) continue;
    const prev = merged.get(id) ?? empty();
    merged.set(id, { ...prev, currentTenantCount: g._count?._all ?? 0 });
  }
  for (const g of scheduledGroups) {
    const id = g.nextBillingPlanId;
    if (!id) continue;
    const prev = merged.get(id) ?? empty();
    merged.set(id, { ...prev, scheduledTenantCount: g._count?._all ?? 0 });
  }
  return merged;
}

export function attachUsageCountsToPlans<T extends { id: string }>(
  plans: T[],
  usage: Map<string, BillingPlanUsageCounts>,
): Array<T & BillingPlanUsageCounts> {
  const empty = (): BillingPlanUsageCounts => ({ currentTenantCount: 0, scheduledTenantCount: 0 });
  return plans.map((p) => ({ ...p, ...(usage.get(p.id) ?? empty()) }));
}

export async function billingPlanTenantPreviews(db: AnyDb, planId: string): Promise<{
  currentTenantsPreview: BillingPlanTenantPreviewRow[];
  scheduledTenantsPreview: BillingPlanTenantPreviewRow[];
}> {
  const [currentRows, scheduledRows] = await Promise.all([
    (db as AnyDb).tenantBillingSettings.findMany({
      where: { billingPlanId: planId },
      take: PREVIEW_LIMIT,
      orderBy: { tenantId: "asc" },
      select: { tenant: { select: { id: true, name: true } } },
    }) as Promise<Array<{ tenant: { id: string; name: string } | null }>>,
    (db as AnyDb).tenantBillingSettings.findMany({
      where: { nextBillingPlanId: planId },
      take: PREVIEW_LIMIT,
      orderBy: { tenantId: "asc" },
      select: { tenant: { select: { id: true, name: true } } },
    }) as Promise<Array<{ tenant: { id: string; name: string } | null }>>,
  ]);
  return {
    currentTenantsPreview: currentRows.map((r) => r.tenant).filter(Boolean) as BillingPlanTenantPreviewRow[],
    scheduledTenantsPreview: scheduledRows.map((r) => r.tenant).filter(Boolean) as BillingPlanTenantPreviewRow[],
  };
}

export function deactivateBillingPlanBlockedReason(counts: BillingPlanUsageCounts): string | null {
  if (counts.scheduledTenantCount > 0) return "billing_plan_deactivate_blocked_scheduled";
  if (counts.currentTenantCount > 0) return "billing_plan_deactivate_blocked_current";
  return null;
}

/** BillingEventLog rows require FK tenantId; platform catalog writes attach to smallest-id tenant row with metadata.catalogScope tagging. */
export async function logBillingCatalogEvent(db: AnyDb, input: {
  operatorId: string;
  type: "billing_plan.created" | "billing_plan.updated" | "billing_plan.deactivated" | "billing_plan.cloned";
  metadata: Record<string, unknown>;
}): Promise<void> {
  const probe = await (db as AnyDb).tenant.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  if (!probe) return;
  await logBillingEvent({
    tenantId: probe.id,
    type: input.type,
    message: "Platform billing catalog.",
    metadata: {
      catalogScope: "billing_plan_catalog",
      operatorId: input.operatorId,
      ...input.metadata,
    },
  }).catch(() => undefined);
}

export function prismaUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Shared guard for scheduling a plan onto a tenant (lookup must include `active`). */
export function assertBillingPlanScheduleEligibility<T extends { active: boolean }>(
  plan: T | null,
): { ok: true; plan: T } | { ok: false; error: "billing_plan_not_found" | "billing_plan_inactive" } {
  if (!plan) return { ok: false, error: "billing_plan_not_found" };
  if (!plan.active) return { ok: false, error: "billing_plan_inactive" };
  return { ok: true, plan };
}
