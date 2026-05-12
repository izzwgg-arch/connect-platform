import { db } from "@connect/db";

/** Hard cap 10; default 3 — set `BILLING_DUNNING_MAX_ATTEMPTS` (1–10). */
export function billingDunningMaxAttempts(): number {
  const n = Number(process.env.BILLING_DUNNING_MAX_ATTEMPTS || 3);
  if (!Number.isFinite(n)) return 3;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

/** Hours until next autopay retry after a failure; default 72. */
export function billingDunningRetryDelayMs(): number {
  const h = Number(process.env.BILLING_DUNNING_RETRY_DELAY_HOURS || 72);
  if (!Number.isFinite(h) || h < 1) return 72 * 3600000;
  return Math.min(24 * 14, Math.max(1, h)) * 3600000;
}

export type DunningSlice = {
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
};

function asRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

export function readDunningSlice(metadata: unknown): DunningSlice {
  const root = asRecord(metadata);
  const d = asRecord(root.dunning);
  const attempts = Math.max(0, Number(d.attempts || 0) || 0);
  const maxAttempts = Math.max(1, Number(d.maxAttempts || billingDunningMaxAttempts()) || billingDunningMaxAttempts());
  const nextRetryAt = d.nextRetryAt != null ? String(d.nextRetryAt) : null;
  return { attempts, maxAttempts, nextRetryAt };
}

/** Pure merge for unit tests — increments attempts, sets nextRetryAt or exhausted. */
export function mergeDunningAfterFailure(prevMetadata: unknown): {
  metadata: Record<string, unknown>;
  exhausted: boolean;
  attempts: number;
  nextRetryAt: Date | null;
} {
  const root = { ...asRecord(prevMetadata) };
  const prev = readDunningSlice(root);
  const max = billingDunningMaxAttempts();
  const attempts = prev.attempts + 1;
  const exhausted = attempts >= max;
  const nextRetryAt = exhausted ? null : new Date(Date.now() + billingDunningRetryDelayMs());
  root.dunning = {
    attempts,
    maxAttempts: max,
    nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
    lastFailureAt: new Date().toISOString(),
  };
  return { metadata: root, exhausted, attempts, nextRetryAt };
}

export function clearDunningSlice(metadata: unknown): Record<string, unknown> {
  const root = { ...asRecord(metadata) };
  if (root.dunning) delete root.dunning;
  return root;
}

export async function applyDunningAfterAutopayFailure(params: { invoiceId: string; tenantId: string; runId: string | null }) {
  const invoice = await (db as any).billingInvoice.findUnique({ where: { id: params.invoiceId } });
  if (!invoice) return;
  const { metadata, exhausted, attempts, nextRetryAt } = mergeDunningAfterFailure(invoice.metadata);
  await (db as any).billingInvoice.update({ where: { id: params.invoiceId }, data: { metadata } });
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      runId: params.runId ?? null,
      type: exhausted ? "dunning_exhausted" : "dunning_scheduled",
      message: exhausted ? `Max autopay retries (${attempts}) reached` : `Autopay retry scheduled`,
      metadata: { attempts, maxAttempts: billingDunningMaxAttempts(), nextRetryAt: nextRetryAt?.toISOString() || null },
    },
  });
}

/** Invoices with balance due, eligible default card, and nextRetryAt passed (JS filter). */
export async function listInvoicesEligibleForDunningRetry(take = 50): Promise<any[]> {
  const rows = await (db as any).billingInvoice.findMany({
    where: {
      balanceDueCents: { gt: 0 },
      status: { in: ["OPEN", "FAILED"] },
    },
    include: { tenant: { include: { billingSettings: true } } },
    orderBy: { updatedAt: "asc" },
    take: take * 3,
  });
  const now = Date.now();
  const max = billingDunningMaxAttempts();
  return rows.filter((inv: any) => {
    const d = readDunningSlice(inv.metadata);
    if (d.attempts <= 0 || d.attempts >= max) return false;
    if (!d.nextRetryAt) return false;
    const t = Date.parse(d.nextRetryAt);
    if (!Number.isFinite(t) || t > now) return false;
    const pm = inv.tenant?.billingSettings?.defaultPaymentMethodId;
    return !!pm;
  }).slice(0, take);
}
