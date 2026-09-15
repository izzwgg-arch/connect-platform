/**
 * LoopCom Mobile — plan, usage and billing arithmetic. Pure functions only:
 * no db, no fetch, no Date.now() — everything takes its inputs, so every
 * money-shaped decision here is unit-testable.
 *
 * Billing integration contract (the billingReconcile.ts rule): invoices
 * RECOUNT quantities live at invoice time — nothing here writes charge rows
 * when a line is provisioned. `buildMobileBillingLineItems` is the recount:
 * the invoice engine (or a person on the console) calls it with the tenant's
 * lines + the period's stored usage and gets the line items for that cycle.
 * ⛔ It is NOT yet wired into buildBillingInvoicePreview — that touches the
 * live money path and happens with the first real customer line, after the
 * blast-radius trace (see the handoff).
 */

export interface MobilePlanShape {
  id: string;
  name: string;
  monthlyPriceCents: number;
  activationFeeCents: number;
  simFeeCents: number;
  esimFeeCents: number;
  includedDataMb: number | null;
  includedVoiceMinutes: number | null;
  includedSms: number | null;
  dataOverageBehavior: string; // "block" | "charge"
  dataOverageCentsPerGb: number;
}

export interface UsageTotals {
  dataMb: number;
  voiceSeconds: number;
  smsCount: number;
}

export function computeUsageTotals(records: Array<{ kind: string; quantity: number }>): UsageTotals {
  const t: UsageTotals = { dataMb: 0, voiceSeconds: 0, smsCount: 0 };
  for (const r of records) {
    const q = Number(r.quantity);
    if (!Number.isFinite(q) || q < 0) continue;
    if (r.kind === "data") t.dataMb += q;
    else if (r.kind === "voice") t.voiceSeconds += q;
    else if (r.kind === "sms") t.smsCount += q;
  }
  t.dataMb = Math.round(t.dataMb * 100) / 100;
  return t;
}

/** Overage owed for one line's cycle usage under its plan. "block" plans owe nothing by definition. */
export function computeDataOverageCents(plan: MobilePlanShape, usedDataMb: number): { overageMb: number; overageCents: number } {
  const included = plan.includedDataMb ?? 0;
  const overageMb = Math.max(0, usedDataMb - included);
  if (plan.dataOverageBehavior !== "charge" || plan.dataOverageCentsPerGb <= 0 || overageMb <= 0) {
    return { overageMb, overageCents: 0 };
  }
  // Charged per GB, prorated by MB, rounded up to the cent — never bill a
  // fraction the customer can't see.
  const overageCents = Math.ceil((overageMb / 1024) * plan.dataOverageCentsPerGb);
  return { overageMb, overageCents };
}

/** Straight-line projection of cycle-end data use, for "projected overage" alerts. */
export function projectCycleDataMb(usedMb: number, cycleStart: Date, cycleEnd: Date, now: Date): number {
  const total = cycleEnd.getTime() - cycleStart.getTime();
  const elapsed = Math.min(Math.max(now.getTime() - cycleStart.getTime(), 0), total);
  if (total <= 0 || elapsed <= 0) return usedMb;
  return Math.round((usedMb * total) / elapsed);
}

/**
 * Anomaly check for one line: yesterday-vs-baseline spike detection. Returns
 * flags, never actions — automatic suspension is a separate, opt-in decision
 * (and never fires off a single anomaly, per the product rules).
 */
export function detectUsageSpike(input: {
  todayMb: number;
  trailingDailyAvgMb: number; // over the prior N days
  minAbsoluteMb?: number; // ignore spikes below this floor (default 1024 MB)
  ratio?: number; // spike = today > ratio * trailing avg (default 3)
}): { spike: boolean; reason: string | null } {
  const floor = input.minAbsoluteMb ?? 1024;
  const ratio = input.ratio ?? 3;
  if (input.todayMb < floor) return { spike: false, reason: null };
  if (input.trailingDailyAvgMb <= 0) {
    return { spike: true, reason: `used ${Math.round(input.todayMb)} MB today with no prior usage history` };
  }
  if (input.todayMb > input.trailingDailyAvgMb * ratio) {
    return { spike: true, reason: `used ${Math.round(input.todayMb)} MB today vs a ${Math.round(input.trailingDailyAvgMb)} MB/day average` };
  }
  return { spike: false, reason: null };
}

// ── Billing line items (the recount) ─────────────────────────────────────────

export interface MobileBillingLineInput {
  lineId: string;
  label: string;
  status: string;
  plan: MobilePlanShape | null;
  activatedAt: Date | null;
  terminatedAt: Date | null;
  usedDataMb: number;
}

export interface MobileBillingLineItem {
  /// Maps onto BillingInvoiceLineItem: type CUSTOM, description, quantity, unitPriceCents, amountCents.
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  lineId: string;
  kind: "plan" | "activation" | "data_overage";
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

/**
 * The recount for one tenant + one billing period. Rules:
 *  - a line bills its plan price when ACTIVE or SUSPENDED during the period
 *    (suspension preserves the number — the seat is still held). "lost" is a
 *    suspended flavor and bills the same. draft/pending/terminated-before-
 *    period bill nothing.
 *  - a line activated mid-period is prorated by day, rounded to the cent.
 *  - activation fee bills once: only when activatedAt falls inside the period.
 *  - data overage bills only on "charge" plans.
 * Deterministic and idempotent: same inputs, same items — a billing job that
 * runs twice produces the same recount, so nothing double-bills.
 */
export function buildMobileBillingLineItems(
  lines: MobileBillingLineInput[],
  period: { start: Date; end: Date },
): MobileBillingLineItem[] {
  const items: MobileBillingLineItem[] = [];
  const periodDays = Math.max(1, daysBetween(period.start, period.end));

  for (const line of lines) {
    if (!line.plan) continue;
    const billableStatus = line.status === "active" || line.status === "suspended" || line.status === "lost";
    const endedBeforePeriod = line.terminatedAt != null && line.terminatedAt <= period.start;
    if (!billableStatus || endedBeforePeriod) continue;
    if (!line.activatedAt || line.activatedAt >= period.end) continue;

    const effectiveStart = line.activatedAt > period.start ? line.activatedAt : period.start;
    const effectiveEnd = line.terminatedAt && line.terminatedAt < period.end ? line.terminatedAt : period.end;
    const activeDays = Math.min(periodDays, Math.max(1, daysBetween(effectiveStart, effectiveEnd)));
    const prorated = activeDays >= periodDays;
    const amountCents = prorated
      ? line.plan.monthlyPriceCents
      : Math.round((line.plan.monthlyPriceCents * activeDays) / periodDays);

    items.push({
      description: prorated
        ? `Mobile line ${line.label} — ${line.plan.name}`
        : `Mobile line ${line.label} — ${line.plan.name} (${activeDays}/${periodDays} days)`,
      quantity: 1,
      unitPriceCents: amountCents,
      amountCents,
      lineId: line.lineId,
      kind: "plan",
    });

    if (line.activatedAt >= period.start && line.activatedAt < period.end && line.plan.activationFeeCents > 0) {
      items.push({
        description: `Mobile line ${line.label} — activation`,
        quantity: 1,
        unitPriceCents: line.plan.activationFeeCents,
        amountCents: line.plan.activationFeeCents,
        lineId: line.lineId,
        kind: "activation",
      });
    }

    const { overageMb, overageCents } = computeDataOverageCents(line.plan, line.usedDataMb);
    if (overageCents > 0) {
      items.push({
        description: `Mobile line ${line.label} — data overage (${Math.round(overageMb)} MB)`,
        quantity: 1,
        unitPriceCents: overageCents,
        amountCents: overageCents,
        lineId: line.lineId,
        kind: "data_overage",
      });
    }
  }
  return items;
}
