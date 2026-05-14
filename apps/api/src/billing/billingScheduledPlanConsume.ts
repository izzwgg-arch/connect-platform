import { db } from "@connect/db";
import { logBillingEvent } from "./invoiceEngine";

export type ConsumeScheduledPlanChangeOutcome =
  | { status: "applied"; planId: string; planName: string }
  | { status: "skipped"; reason: string }
  | { status: "no_schedule" }
  | { status: "before_effective" };

/**
 * After a monthly invoice exists for `periodStart`, persists a scheduled plan change:
 * moves `nextBillingPlan` to current, copies plan prices onto the tenant settings row,
 * and clears the schedule fields. Idempotent — safe to call on every billing run.
 *
 * Does not change charge behavior; call after invoice create/find, before autopay.
 */
export async function consumeScheduledPlanChange(input: {
  tenantId: string;
  periodStart: Date;
  invoiceId?: string | null;
  runId?: string | null;
}): Promise<ConsumeScheduledPlanChangeOutcome> {
  const settings = await (db as any).tenantBillingSettings.findUnique({
    where: { tenantId: input.tenantId },
    select: {
      billingPlanId: true,
      nextBillingPlanId: true,
      nextBillingPlanEffectiveAt: true,
    },
  });

  if (!settings?.nextBillingPlanId || !settings.nextBillingPlanEffectiveAt) {
    return { status: "no_schedule" };
  }

  const effectiveAt = settings.nextBillingPlanEffectiveAt as Date;
  if (input.periodStart.getTime() < effectiveAt.getTime()) {
    return { status: "before_effective" };
  }

  const plan = await (db as any).billingPlan.findUnique({
    where: { id: settings.nextBillingPlanId },
  });

  if (!plan) {
    await logBillingEvent({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId ?? null,
      runId: input.runId ?? null,
      type: "billing_plan.change_skipped",
      message: "Scheduled plan not found (may have been deleted); schedule left unchanged.",
      metadata: { reason: "plan_not_found", nextBillingPlanId: settings.nextBillingPlanId },
    }).catch(() => undefined);
    return { status: "skipped", reason: "plan_not_found" };
  }

  if (!plan.active) {
    await logBillingEvent({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId ?? null,
      runId: input.runId ?? null,
      type: "billing_plan.change_skipped",
      message: "Scheduled billing plan is inactive; schedule left unchanged.",
      metadata: {
        reason: "inactive_plan",
        nextBillingPlanId: plan.id,
        planCode: plan.code,
      },
    }).catch(() => undefined);
    return { status: "skipped", reason: "inactive_plan" };
  }

  const updated = await (db as any).tenantBillingSettings.updateMany({
    where: {
      tenantId: input.tenantId,
      nextBillingPlanId: settings.nextBillingPlanId,
      nextBillingPlanEffectiveAt: effectiveAt,
    },
    data: {
      billingPlanId: plan.id,
      extensionPriceCents: plan.extensionPriceCents,
      additionalPhoneNumberPriceCents: plan.additionalPhoneNumberPriceCents,
      smsPriceCents: plan.smsPriceCents,
      firstPhoneNumberFree: plan.firstPhoneNumberFree,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
    },
  });

  if (!updated.count) {
    return { status: "skipped", reason: "concurrent_or_already_applied" };
  }

  await logBillingEvent({
    tenantId: input.tenantId,
    invoiceId: input.invoiceId ?? null,
    runId: input.runId ?? null,
    type: "billing_plan.change_applied",
    metadata: {
      previousBillingPlanId: settings.billingPlanId ?? null,
      newBillingPlanId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      effectiveAt: effectiveAt.toISOString(),
    },
  }).catch(() => undefined);

  return { status: "applied", planId: plan.id, planName: plan.name };
}
