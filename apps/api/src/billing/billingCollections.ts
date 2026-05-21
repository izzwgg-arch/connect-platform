/**
 * Billing collections controls — Phase 1 (API + Portal only).
 *
 * Phase 1 stores operator decisions in metadata and exposes them via API.
 * Phase 2 (separate task) will make the worker sweep honor these flags.
 *
 * Until Phase 2 deploys:
 *  - Per-invoice pause/do-not-charge flags are stored and visible in UI
 *  - Worker DOES NOT yet check these flags — existing retry logic is unchanged
 *  - Every operator action is logged to BillingEventLog for the audit trail
 *
 * Two metadata slices — no Prisma migration needed:
 *  • TenantBillingSettings.metadata.collections  (per-tenant dunning config)
 *  • BillingInvoice.metadata.collections         (per-invoice controls)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TenantCollectionsConfig = {
  /** null = inherit autoBillingEnabled; Phase 2 worker will read this */
  dunningEnabled: boolean | null;
  /** null = use global env BILLING_DUNNING_MAX_ATTEMPTS (default 3) */
  maxAttempts: number | null;
  /** null = use global env BILLING_DUNNING_RETRY_DELAY_HOURS (default 12) */
  retryDelayHours: number | null;
};

export type InvoiceCollectionsStatus = "NORMAL" | "PAUSED" | "DO_NOT_CHARGE";

export type InvoiceCollectionsSlice = {
  status: InvoiceCollectionsStatus;
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  pauseReason: string | null;
  skipNextRetry: boolean;
  doNotCharge: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type CollectionsInvoiceRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  tenantId: string;
  tenantName: string;
  status: string;
  balanceDueCents: number;
  totalCents: number;
  dueDate: string | null;
  failedAt: string | null;
  dunningAttempts: number;
  dunningMaxAttempts: number;
  nextRetryAt: string | null;
  collections: InvoiceCollectionsSlice;
  lastFailureReason: string | null;
};

export type CollectionsOverview = {
  counts: {
    failed: number;
    retryEligible: number;
    paused: number;
    exhausted: number;
    doNotCharge: number;
  };
  retryEligible: CollectionsInvoiceRow[];
  paused: CollectionsInvoiceRow[];
  exhausted: CollectionsInvoiceRow[];
  previewNote: string;
};

// ── Metadata helpers ──────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Read TenantBillingSettings.metadata.collections slice. */
export function readTenantCollectionsConfig(metadata: unknown): TenantCollectionsConfig {
  const root = asRecord(metadata);
  const c = asRecord(root.collections);
  return {
    dunningEnabled: c.dunningEnabled == null ? null : Boolean(c.dunningEnabled),
    maxAttempts:
      c.maxAttempts != null && Number.isFinite(Number(c.maxAttempts))
        ? Math.min(10, Math.max(1, Math.floor(Number(c.maxAttempts))))
        : null,
    retryDelayHours:
      c.retryDelayHours != null && Number.isFinite(Number(c.retryDelayHours))
        ? Math.min(336, Math.max(1, Math.floor(Number(c.retryDelayHours))))
        : null,
  };
}

/** Merge updated TenantCollectionsConfig into existing metadata (preserves all other keys). */
export function writeTenantCollectionsConfig(
  existingMetadata: unknown,
  update: Partial<TenantCollectionsConfig>,
): Record<string, unknown> {
  const root = { ...asRecord(existingMetadata) };
  const prev = readTenantCollectionsConfig(root);
  const next: Record<string, unknown> = {
    dunningEnabled: "dunningEnabled" in update ? update.dunningEnabled ?? null : prev.dunningEnabled,
    maxAttempts: "maxAttempts" in update ? update.maxAttempts ?? null : prev.maxAttempts,
    retryDelayHours: "retryDelayHours" in update ? update.retryDelayHours ?? null : prev.retryDelayHours,
  };
  root.collections = next;
  return root;
}

/** Read BillingInvoice.metadata.collections slice. */
export function readInvoiceCollectionsSlice(metadata: unknown): InvoiceCollectionsSlice {
  const root = asRecord(metadata);
  const c = asRecord(root.collections);
  const paused = Boolean(c.paused);
  const doNotCharge = Boolean(c.doNotCharge);
  let status: InvoiceCollectionsStatus = "NORMAL";
  if (doNotCharge) status = "DO_NOT_CHARGE";
  else if (paused) status = "PAUSED";
  return {
    status,
    paused,
    pausedAt: c.pausedAt != null ? String(c.pausedAt) : null,
    pausedBy: c.pausedBy != null ? String(c.pausedBy) : null,
    pauseReason: c.pauseReason != null ? String(c.pauseReason) : null,
    skipNextRetry: Boolean(c.skipNextRetry),
    doNotCharge,
    updatedBy: c.updatedBy != null ? String(c.updatedBy) : null,
    updatedAt: c.updatedAt != null ? String(c.updatedAt) : null,
  };
}

/** Merge updated invoice collections controls into existing metadata (preserves dunning + all other keys). */
export function writeInvoiceCollectionsSlice(
  existingMetadata: unknown,
  update: Partial<InvoiceCollectionsSlice> & { pausedBy?: string | null; pauseReason?: string | null },
): Record<string, unknown> {
  const root = { ...asRecord(existingMetadata) };
  const prev = readInvoiceCollectionsSlice(root);
  const now = new Date().toISOString();
  const next: Record<string, unknown> = {
    paused: "paused" in update ? Boolean(update.paused) : prev.paused,
    pausedAt: "paused" in update ? (update.paused ? (prev.pausedAt ?? now) : null) : prev.pausedAt,
    pausedBy: "paused" in update ? (update.paused ? (update.pausedBy ?? prev.pausedBy) : null) : prev.pausedBy,
    pauseReason: "paused" in update ? (update.paused ? (update.pauseReason ?? prev.pauseReason) : null) : prev.pauseReason,
    skipNextRetry: "skipNextRetry" in update ? Boolean(update.skipNextRetry) : prev.skipNextRetry,
    doNotCharge: "doNotCharge" in update ? Boolean(update.doNotCharge) : prev.doNotCharge,
    updatedBy: update.updatedBy ?? prev.updatedBy,
    updatedAt: now,
  };
  root.collections = next;
  return root;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type ConfigValidationResult = { ok: true } | { ok: false; error: string };

export function validateTenantCollectionsConfigUpdate(body: unknown): ConfigValidationResult {
  const b = asRecord(body);
  if ("maxAttempts" in b && b.maxAttempts !== null) {
    const n = Number(b.maxAttempts);
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      return { ok: false, error: "maxAttempts must be between 1 and 10, or null to use the global default." };
    }
  }
  if ("retryDelayHours" in b && b.retryDelayHours !== null) {
    const n = Number(b.retryDelayHours);
    if (!Number.isFinite(n) || n < 1 || n > 336) {
      return { ok: false, error: "retryDelayHours must be between 1 and 336 (14 days), or null to use the global default." };
    }
  }
  if ("dunningEnabled" in b && b.dunningEnabled !== null && typeof b.dunningEnabled !== "boolean") {
    return { ok: false, error: "dunningEnabled must be true, false, or null." };
  }
  return { ok: true };
}

// ── DB helpers (injectable for tests) ────────────────────────────────────────

export type CollectionsDb = {
  billingInvoice: {
    findMany(args: unknown): Promise<unknown[]>;
    findUnique(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
  tenantBillingSettings: {
    findUnique(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
  };
  billingEventLog: {
    create(args: unknown): Promise<unknown>;
  };
};

// ── Collections overview ──────────────────────────────────────────────────────

export type CollectionsQueryScope = { tenantId?: string };

export async function queryCollectionsOverview(
  cdb: CollectionsDb,
  scope: CollectionsQueryScope = {},
): Promise<CollectionsOverview> {
  // Fetch all OPEN/FAILED/OVERDUE invoices with outstanding balance
  const raw = await cdb.billingInvoice.findMany({
    where: {
      balanceDueCents: { gt: 0 },
      status: { in: ["OPEN", "FAILED", "OVERDUE"] },
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    },
    orderBy: [{ failedAt: "desc" }, { dueDate: "asc" }],
    take: 500,
    select: {
      id: true,
      invoiceNumber: true,
      tenantId: true,
      status: true,
      balanceDueCents: true,
      totalCents: true,
      dueDate: true,
      failedAt: true,
      metadata: true,
      tenant: { select: { name: true } },
      transactions: {
        where: { status: { in: ["DECLINED", "ERROR"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { responseMessage: true },
      },
    },
  }) as any[];

  const now = Date.now();

  function toRow(r: any): CollectionsInvoiceRow {
    const d = readDunningSliceFromMeta(r.metadata);
    const c = readInvoiceCollectionsSlice(r.metadata);
    return {
      invoiceId: r.id,
      invoiceNumber: r.invoiceNumber ?? null,
      tenantId: r.tenantId,
      tenantName: r.tenant?.name ?? r.tenantId,
      status: r.status,
      balanceDueCents: r.balanceDueCents,
      totalCents: r.totalCents,
      dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
      failedAt: r.failedAt ? new Date(r.failedAt).toISOString() : null,
      dunningAttempts: d.attempts,
      dunningMaxAttempts: d.maxAttempts,
      nextRetryAt: d.nextRetryAt,
      collections: c,
      lastFailureReason: r.transactions?.[0]?.responseMessage ?? null,
    };
  }

  const rows = raw.map(toRow);

  const retryEligible = rows.filter((r) => {
    const { dunningAttempts, dunningMaxAttempts, nextRetryAt } = r;
    if (dunningAttempts <= 0 || dunningAttempts >= dunningMaxAttempts) return false;
    if (!nextRetryAt) return false;
    const t = Date.parse(nextRetryAt);
    return Number.isFinite(t) && t <= now;
  }).slice(0, 50);

  const paused = rows.filter((r) => r.collections.paused || r.collections.doNotCharge).slice(0, 50);
  const exhausted = rows.filter((r) => {
    const { dunningAttempts, dunningMaxAttempts, nextRetryAt } = r;
    return dunningAttempts >= dunningMaxAttempts && !nextRetryAt && dunningAttempts > 0;
  }).slice(0, 50);

  return {
    counts: {
      failed: rows.length,
      retryEligible: retryEligible.length,
      paused: rows.filter((r) => r.collections.paused).length,
      exhausted: exhausted.length,
      doNotCharge: rows.filter((r) => r.collections.doNotCharge).length,
    },
    retryEligible,
    paused,
    exhausted,
    previewNote:
      "⚠ Phase 1: Controls are stored and visible. Worker enforcement of pause/do-not-charge flags requires Phase 2 deployment.",
  };
}

/** Preview which invoices would be picked up by the next dunning sweep. */
export async function queryPreviewRetries(
  cdb: CollectionsDb,
  scope: CollectionsQueryScope = {},
): Promise<{ rows: CollectionsInvoiceRow[]; note: string }> {
  const raw = await cdb.billingInvoice.findMany({
    where: {
      balanceDueCents: { gt: 0 },
      status: { in: ["OPEN", "FAILED"] },
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    },
    include: { tenant: { include: { billingSettings: true } } },
    orderBy: { updatedAt: "asc" },
    take: 150,
    select: {
      id: true,
      invoiceNumber: true,
      tenantId: true,
      status: true,
      balanceDueCents: true,
      totalCents: true,
      dueDate: true,
      failedAt: true,
      metadata: true,
      tenant: {
        select: {
          name: true,
          billingSettings: { select: { defaultPaymentMethodId: true } },
        },
      },
    },
  }) as any[];

  const now = Date.now();
  const rows: CollectionsInvoiceRow[] = [];

  for (const r of raw) {
    const d = readDunningSliceFromMeta(r.metadata);
    const c = readInvoiceCollectionsSlice(r.metadata);
    if (d.attempts <= 0 || d.attempts >= d.maxAttempts) continue;
    if (!d.nextRetryAt) continue;
    const t = Date.parse(d.nextRetryAt);
    if (!Number.isFinite(t) || t > now) continue;
    if (!r.tenant?.billingSettings?.defaultPaymentMethodId) continue;
    rows.push({
      invoiceId: r.id,
      invoiceNumber: r.invoiceNumber ?? null,
      tenantId: r.tenantId,
      tenantName: r.tenant?.name ?? r.tenantId,
      status: r.status,
      balanceDueCents: r.balanceDueCents,
      totalCents: r.totalCents,
      dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
      failedAt: r.failedAt ? new Date(r.failedAt).toISOString() : null,
      dunningAttempts: d.attempts,
      dunningMaxAttempts: d.maxAttempts,
      nextRetryAt: d.nextRetryAt,
      collections: c,
      lastFailureReason: null,
    });
    if (rows.length >= 50) break;
  }

  return {
    rows,
    note:
      "This is a preview of the next dunning sweep. Pause/do-not-charge flags are shown but NOT yet enforced by the worker (Phase 1). Phase 2 worker deployment will honor these flags.",
  };
}

// ── Dunning slice reader (local copy to avoid circular import with billingDunning.ts) ─

function readDunningSliceFromMeta(metadata: unknown): { attempts: number; maxAttempts: number; nextRetryAt: string | null } {
  const root = asRecord(metadata);
  const d = asRecord(root.dunning);
  const attempts = Math.max(0, Number(d.attempts || 0) || 0);
  const maxAttempts = Math.max(1, Number(d.maxAttempts || 3) || 3);
  const nextRetryAt = d.nextRetryAt != null ? String(d.nextRetryAt) : null;
  return { attempts, maxAttempts, nextRetryAt };
}

// ── Per-invoice action helpers ────────────────────────────────────────────────

export type CollectionsActionResult =
  | { ok: true; collections: InvoiceCollectionsSlice }
  | { ok: false; error: string; code?: string };

async function loadInvoice(cdb: CollectionsDb, invoiceId: string): Promise<any | null> {
  return cdb.billingInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, tenantId: true, status: true, metadata: true, invoiceNumber: true },
  });
}

async function writeAndLog(
  cdb: CollectionsDb,
  params: {
    invoiceId: string;
    tenantId: string;
    newMetadata: Record<string, unknown>;
    action: string;
    operatorId: string;
    reason?: string | null;
    prevState: InvoiceCollectionsSlice;
    nextState: InvoiceCollectionsSlice;
  },
): Promise<void> {
  await cdb.billingInvoice.update({
    where: { id: params.invoiceId },
    data: { metadata: params.newMetadata },
  });
  await cdb.billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: "collections_action",
      message: `${params.action} by ${params.operatorId}`,
      metadata: {
        action: params.action,
        operatorId: params.operatorId,
        reason: params.reason ?? null,
        prevState: params.prevState,
        nextState: params.nextState,
      },
    },
  });
}

export async function pauseInvoiceCollections(
  cdb: CollectionsDb,
  invoiceId: string,
  operatorId: string,
  reason?: string | null,
): Promise<CollectionsActionResult> {
  const inv = await loadInvoice(cdb, invoiceId);
  if (!inv) return { ok: false, error: "Invoice not found.", code: "invoice_not_found" };
  if (["PAID", "VOID"].includes(inv.status)) {
    return { ok: false, error: `Cannot pause collections on a ${inv.status} invoice.`, code: "invalid_status" };
  }
  const prev = readInvoiceCollectionsSlice(inv.metadata);
  if (prev.paused) return { ok: false, error: "Invoice collections are already paused.", code: "already_paused" };
  const newMeta = writeInvoiceCollectionsSlice(inv.metadata, {
    paused: true,
    pausedBy: operatorId,
    pauseReason: reason ?? null,
    updatedBy: operatorId,
  });
  const next = readInvoiceCollectionsSlice(newMeta);
  await writeAndLog(cdb, { invoiceId, tenantId: inv.tenantId, newMetadata: newMeta, action: "pause", operatorId, reason, prevState: prev, nextState: next });
  return { ok: true, collections: next };
}

export async function resumeInvoiceCollections(
  cdb: CollectionsDb,
  invoiceId: string,
  operatorId: string,
): Promise<CollectionsActionResult> {
  const inv = await loadInvoice(cdb, invoiceId);
  if (!inv) return { ok: false, error: "Invoice not found.", code: "invoice_not_found" };
  const prev = readInvoiceCollectionsSlice(inv.metadata);
  if (!prev.paused && !prev.doNotCharge && !prev.skipNextRetry) {
    return { ok: false, error: "Invoice collections are not paused or restricted.", code: "not_paused" };
  }
  const newMeta = writeInvoiceCollectionsSlice(inv.metadata, {
    paused: false,
    skipNextRetry: false,
    doNotCharge: false,
    updatedBy: operatorId,
  });
  const next = readInvoiceCollectionsSlice(newMeta);
  await writeAndLog(cdb, { invoiceId, tenantId: inv.tenantId, newMetadata: newMeta, action: "resume", operatorId, reason: null, prevState: prev, nextState: next });
  return { ok: true, collections: next };
}

export async function skipNextRetry(
  cdb: CollectionsDb,
  invoiceId: string,
  operatorId: string,
): Promise<CollectionsActionResult> {
  const inv = await loadInvoice(cdb, invoiceId);
  if (!inv) return { ok: false, error: "Invoice not found.", code: "invoice_not_found" };
  if (["PAID", "VOID"].includes(inv.status)) {
    return { ok: false, error: `Cannot set skip on a ${inv.status} invoice.`, code: "invalid_status" };
  }
  const prev = readInvoiceCollectionsSlice(inv.metadata);
  const newMeta = writeInvoiceCollectionsSlice(inv.metadata, { skipNextRetry: true, updatedBy: operatorId });
  const next = readInvoiceCollectionsSlice(newMeta);
  await writeAndLog(cdb, { invoiceId, tenantId: inv.tenantId, newMetadata: newMeta, action: "skip_next_retry", operatorId, reason: null, prevState: prev, nextState: next });
  return { ok: true, collections: next };
}

export async function markDoNotCharge(
  cdb: CollectionsDb,
  invoiceId: string,
  operatorId: string,
  reason?: string | null,
): Promise<CollectionsActionResult> {
  const inv = await loadInvoice(cdb, invoiceId);
  if (!inv) return { ok: false, error: "Invoice not found.", code: "invoice_not_found" };
  if (["PAID", "VOID"].includes(inv.status)) {
    return { ok: false, error: `Cannot mark do-not-charge on a ${inv.status} invoice.`, code: "invalid_status" };
  }
  const prev = readInvoiceCollectionsSlice(inv.metadata);
  const newMeta = writeInvoiceCollectionsSlice(inv.metadata, {
    doNotCharge: true,
    paused: false,
    pausedBy: undefined,
    pauseReason: reason ?? null,
    updatedBy: operatorId,
  });
  const next = readInvoiceCollectionsSlice(newMeta);
  await writeAndLog(cdb, { invoiceId, tenantId: inv.tenantId, newMetadata: newMeta, action: "do_not_charge", operatorId, reason, prevState: prev, nextState: next });
  return { ok: true, collections: next };
}
