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

// ── Phase 2: per-invoice and per-tenant collections metadata readers ──────────
// Intentionally inline (no import from billingCollections.ts) to keep this
// module dependency-free and testable without the collections module.

/** Reads invoice-level collections flags from BillingInvoice.metadata.collections. */
function readInvoiceCollectionsLocal(metadata: unknown): {
  paused: boolean;
  doNotCharge: boolean;
  skipNextRetry: boolean;
} {
  const root = asRecord(metadata);
  const c = asRecord(root.collections);
  return {
    paused: Boolean(c.paused),
    doNotCharge: Boolean(c.doNotCharge),
    skipNextRetry: Boolean(c.skipNextRetry),
  };
}

/** Reads per-tenant dunning overrides from TenantBillingSettings.metadata.collections. */
function readTenantDunningOverrideLocal(metadata: unknown): {
  dunningEnabled: boolean | null;
  maxAttempts: number | null;
  retryDelayMs: number | null;
} {
  const root = asRecord(metadata);
  const c = asRecord(root.collections);
  const dunningEnabled = c.dunningEnabled == null ? null : Boolean(c.dunningEnabled);
  const rawMax = c.maxAttempts;
  const maxAttempts =
    rawMax != null && Number.isFinite(Number(rawMax))
      ? Math.min(10, Math.max(1, Math.floor(Number(rawMax))))
      : null;
  const rawHours = c.retryDelayHours;
  const retryDelayMs =
    rawHours != null && Number.isFinite(Number(rawHours))
      ? Math.min(336, Math.max(1, Math.floor(Number(rawHours)))) * 3600_000
      : null;
  return { dunningEnabled, maxAttempts, retryDelayMs };
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

/** Pure merge — increments attempts, sets nextRetryAt or exhausted.
 *  @param overrides  Optional per-tenant maxAttempts / retryDelayMs to use instead of env globals. */
export function mergeDunningAfterFailure(
  prevMetadata: unknown,
  overrides?: { maxAttempts?: number; retryDelayMs?: number },
): {
  metadata: Record<string, unknown>;
  exhausted: boolean;
  attempts: number;
  nextRetryAt: Date | null;
} {
  const root = { ...asRecord(prevMetadata) };
  const prev = readDunningSlice(root);
  const max = overrides?.maxAttempts ?? billingDunningMaxAttempts();
  const delayMs = overrides?.retryDelayMs ?? billingDunningRetryDelayMs();
  const attempts = prev.attempts + 1;
  const exhausted = attempts >= max;
  const nextRetryAt = exhausted ? null : new Date(Date.now() + delayMs);
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

export async function applyDunningAfterAutopayFailure(params: {
  invoiceId: string;
  tenantId: string;
  runId: string | null;
  /** Per-tenant overrides — use values from TenantBillingSettings.metadata.collections when set. */
  overrides?: { maxAttempts?: number; retryDelayMs?: number };
}) {
  const invoice = await (db as any).billingInvoice.findUnique({ where: { id: params.invoiceId } });
  if (!invoice) return;
  const { metadata, exhausted, attempts, nextRetryAt } = mergeDunningAfterFailure(invoice.metadata, params.overrides);
  const effectiveMax = params.overrides?.maxAttempts ?? billingDunningMaxAttempts();
  await (db as any).billingInvoice.update({ where: { id: params.invoiceId }, data: { metadata } });
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      runId: params.runId ?? null,
      type: exhausted ? "dunning_exhausted" : "dunning_scheduled",
      message: exhausted ? `Max autopay retries (${attempts}) reached` : `Autopay retry scheduled`,
      metadata: { attempts, maxAttempts: effectiveMax, nextRetryAt: nextRetryAt?.toISOString() || null },
    },
  });
}

/** Invoices with balance due, eligible default card, and nextRetryAt passed (JS filter).
 *  Kept for backward compatibility and portal preview routes — does NOT apply Phase 2 collections flags. */
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

// ── Phase 2: worker sweep with collections enforcement ────────────────────────

export type SkipReason = "paused" | "do_not_charge" | "tenant_dunning_disabled" | "skip_next_retry";

export type DunningSweepResult = {
  /** Invoices to charge this sweep with per-invoice attempt number and effective dunning params. */
  toCharge: Array<{
    invoice: any;
    /** Deterministic attempt number for idempotency key: dunning.attempts + 1 at time of sweep. */
    attemptNumber: number;
    effectiveMaxAttempts: number;
    effectiveDelayMs: number;
  }>;
  /** Invoices where skipNextRetry=true — caller must clear the flag and skip charging. */
  skipNextRetryInvoices: any[];
  /** Invoices blocked by collections controls (paused / doNotCharge / tenantDisabled). */
  skipped: Array<{ invoice: any; reason: SkipReason }>;
};

/**
 * Phase 2 dunning sweep eligibility.
 * Replaces `listInvoicesEligibleForDunningRetry` in the worker.
 * Applies all Phase 2 collections controls and per-tenant overrides.
 *
 * Injectable `dbOverride` param is provided for unit tests.
 */
export async function runDunningSweepEligibility(take = 50, dbOverride?: any): Promise<DunningSweepResult> {
  const _db = dbOverride ?? db;
  const rows = await (_db as any).billingInvoice.findMany({
    where: {
      balanceDueCents: { gt: 0 },
      status: { in: ["OPEN", "FAILED"] },
    },
    include: { tenant: { include: { billingSettings: true } } },
    orderBy: { updatedAt: "asc" },
    take: take * 4,
  });

  const now = Date.now();
  const globalMax = billingDunningMaxAttempts();
  const globalDelayMs = billingDunningRetryDelayMs();

  const toCharge: DunningSweepResult["toCharge"] = [];
  const skipNextRetryInvoices: any[] = [];
  const skipped: DunningSweepResult["skipped"] = [];

  for (const inv of rows) {
    // ── Step 1: timing / dunning eligibility (must pass before collections checks) ──
    const tenantOverride = readTenantDunningOverrideLocal(inv.tenant?.billingSettings?.metadata);
    const effectiveMaxAttempts = tenantOverride.maxAttempts ?? globalMax;
    const effectiveDelayMs = tenantOverride.retryDelayMs ?? globalDelayMs;

    const d = readDunningSlice(inv.metadata);
    if (d.attempts <= 0 || d.attempts >= effectiveMaxAttempts) continue;
    if (!d.nextRetryAt) continue;
    const t = Date.parse(d.nextRetryAt);
    if (!Number.isFinite(t) || t > now) continue;
    if (!inv.tenant?.billingSettings?.defaultPaymentMethodId) continue;

    // ── Step 2: Phase 2 collections controls ──────────────────────────────────
    // tenant-level: dunningEnabled === false overrides everything
    if (tenantOverride.dunningEnabled === false) {
      skipped.push({ invoice: inv, reason: "tenant_dunning_disabled" });
      continue;
    }

    const col = readInvoiceCollectionsLocal(inv.metadata);

    if (col.doNotCharge) {
      skipped.push({ invoice: inv, reason: "do_not_charge" });
      continue;
    }

    if (col.paused) {
      skipped.push({ invoice: inv, reason: "paused" });
      continue;
    }

    // skipNextRetry: exclude from charging but flag for consumption by caller
    if (col.skipNextRetry) {
      skipNextRetryInvoices.push(inv);
      continue;
    }

    if (toCharge.length < take) {
      toCharge.push({
        invoice: inv,
        attemptNumber: d.attempts + 1,
        effectiveMaxAttempts,
        effectiveDelayMs,
      });
    }
  }

  return { toCharge, skipNextRetryInvoices, skipped };
}

/**
 * Clears the `skipNextRetry` flag on an invoice and writes a `collections_action` audit event.
 * Called by the worker after excluding the invoice from the current sweep.
 *
 * Injectable `dbOverride` param is provided for unit tests.
 */
export async function consumeSkipNextRetryFlag(
  invoiceId: string,
  tenantId: string,
  dbOverride?: any,
): Promise<void> {
  const _db = dbOverride ?? db;
  const inv = await (_db as any).billingInvoice.findUnique({
    where: { id: invoiceId },
    select: { metadata: true },
  });
  if (!inv) return;
  // Preserve all metadata — only clear the skipNextRetry flag inside .collections
  const root = { ...asRecord(inv.metadata) };
  const c = { ...asRecord(root.collections) };
  c.skipNextRetry = false;
  c.updatedAt = new Date().toISOString();
  root.collections = c;
  await (_db as any).billingInvoice.update({ where: { id: invoiceId }, data: { metadata: root } });
  await (_db as any).billingEventLog.create({
    data: {
      tenantId,
      invoiceId,
      type: "collections_action",
      message: "skip_next_retry_consumed by dunning worker",
      metadata: {
        action: "skip_next_retry_consumed",
        operatorId: "worker:dunning",
        prevState: { skipNextRetry: true },
        nextState: { skipNextRetry: false },
      },
    },
  });
}
