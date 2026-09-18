/**
 * Office-only routes for "What this customer cost us". Every handler is gated
 * on SUPER_ADMIN exactly like the rest of /admin/billing — the customer's own
 * /billing routes never import this module.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { buildCostBreakdown } from "./costBreakdown";
import { DEFAULT_RATES, loadRates, saveTypedRate } from "./carrierRates";
import { cursorId, runVoipmsCostSync, voipmsApiForAccount } from "./voipmsFeed";
import { VOIPMS_PRIMARY_ACCOUNT_ID } from "../../voipMsAccounts";

type GateFn = (req: any, reply: any) => Promise<any>;

function parseDay(s: unknown): Date | null {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Cycle invoices only: not manual (NULL-safe), not void, a real service period. */
function isCycleInvoice(inv: any): boolean {
  if (!inv) return false;
  if (inv.source === "MANUAL") return false;
  if (inv.status === "VOID") return false;
  const days = (new Date(inv.periodEnd).getTime() - new Date(inv.periodStart).getTime()) / 86_400_000;
  return days >= 20;
}

function withMargin(revenueCents: number, totalCost: number) {
  const costCents = Math.round(totalCost * 100);
  const marginCents = revenueCents - costCents;
  return {
    revenueCents,
    costCents,
    marginCents,
    marginPct: revenueCents > 0 ? Math.round((marginCents / revenueCents) * 1000) / 10 : null,
  };
}

export function registerCustomerCostRoutes(app: FastifyInstance, requirePlatformBilling: GateFn, log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void }) {
  const d = db as any;

  app.get("/admin/billing/cost/invoices/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const inv = await d.billingInvoice.findUnique({
      where: { id },
      select: { id: true, invoiceNumber: true, tenantId: true, status: true, source: true, totalCents: true, periodStart: true, periodEnd: true, tenant: { select: { name: true } } },
    });
    if (!inv) return reply.code(404).send({ error: "invoice_not_found" });
    const periodStart = new Date(inv.periodStart);
    const periodEnd = new Date(inv.periodEnd);
    const rates = await loadRates(d, periodEnd);
    const breakdown = await buildCostBreakdown(d, { tenantId: inv.tenantId, periodStart, periodEnd, rates });
    return {
      invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, tenantId: inv.tenantId, tenantName: inv.tenant?.name || null, status: inv.status, totalCents: inv.totalCents, periodStart: inv.periodStart, periodEnd: inv.periodEnd, isCycle: isCycleInvoice(inv) },
      breakdown,
      ...withMargin(Number(inv.totalCents) || 0, breakdown.totalCost),
    };
  });

  app.get("/admin/billing/cost/tenants/:tenantId", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const q = req.query as { from?: string; to?: string; invoiceId?: string };
    const tenant = await d.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });
    let periodStart = parseDay(q.from);
    let periodEnd = parseDay(q.to);
    let revenueCents: number | null = null;
    let invoice: any = null;
    if (q.invoiceId) {
      invoice = await d.billingInvoice.findFirst({ where: { id: q.invoiceId, tenantId }, select: { id: true, invoiceNumber: true, totalCents: true, periodStart: true, periodEnd: true, status: true, source: true } });
      if (invoice) {
        periodStart = new Date(invoice.periodStart);
        periodEnd = new Date(invoice.periodEnd);
        revenueCents = Number(invoice.totalCents) || 0;
      }
    }
    if (!periodStart || !periodEnd) {
      periodEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
      periodStart = new Date(periodEnd.getTime() - 30 * 86_400_000);
    }
    if (periodEnd.getTime() - periodStart.getTime() > 400 * 86_400_000) return reply.code(400).send({ error: "period_too_long" });
    const rates = await loadRates(d, periodEnd);
    const breakdown = await buildCostBreakdown(d, { tenantId, periodStart, periodEnd, rates });
    return {
      tenant,
      invoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, totalCents: invoice.totalCents, status: invoice.status } : null,
      breakdown,
      ...(revenueCents === null ? {} : withMargin(revenueCents, breakdown.totalCost)),
    };
  });

  app.get("/admin/billing/cost/tenants/:tenantId/months", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const q = req.query as { limit?: string };
    const limit = Math.min(12, Math.max(1, Number.parseInt(String(q.limit || "6"), 10) || 6));
    const invoices: any[] = await d.billingInvoice.findMany({
      where: { tenantId, AND: [{ OR: [{ source: null }, { source: { not: "MANUAL" } }] }, { status: { not: "VOID" } }] },
      orderBy: { periodStart: "desc" },
      take: 40,
      select: { id: true, invoiceNumber: true, status: true, source: true, totalCents: true, periodStart: true, periodEnd: true, paidAt: true },
    });
    const cycles = invoices.filter(isCycleInvoice).slice(0, limit);
    const now = new Date();
    const months: any[] = [];
    for (const inv of cycles) {
      const periodStart = new Date(inv.periodStart);
      const periodEnd = new Date(inv.periodEnd);
      if (periodStart > now) {
        months.push({ invoice: inv, state: "future", breakdownTotal: 0, ...withMargin(Number(inv.totalCents) || 0, 0), feedComplete: false });
        continue;
      }
      const rates = await loadRates(d, periodEnd);
      const b = await buildCostBreakdown(d, { tenantId, periodStart, periodEnd, rates, now });
      months.push({
        invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status, totalCents: inv.totalCents, periodStart: inv.periodStart, periodEnd: inv.periodEnd, paidAt: inv.paidAt },
        state: b.periodClosed ? "closed" : "running",
        feedComplete: b.feed.complete,
        tiles: b.tiles,
        ...withMargin(Number(inv.totalCents) || 0, b.totalCost),
      });
    }
    return { tenantId, months };
  });

  app.get("/admin/billing/cost/rates", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const rates = await loadRates(d, new Date());
    const history: any[] = await d.carrierRate.findMany({ orderBy: [{ effectiveFrom: "desc" }], take: 100, select: { key: true, rate: true, effectiveFrom: true, source: true, note: true, createdAt: true } });
    return {
      rates: DEFAULT_RATES.map((def) => {
        const r = rates.get(def.key)!;
        return { ...r, rate: Number(r.rate), defaultRate: def.rate, effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString() : null };
      }),
      history: history.map((h) => ({ ...h, rate: Number(h.rate) })),
    };
  });

  const putRate = z.object({ key: z.string().min(1).max(80), rate: z.number().min(0).max(1000), note: z.string().max(300).optional().nullable() });
  app.put("/admin/billing/cost/rates", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const body = putRate.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
    try {
      const row = await saveTypedRate(d, { key: body.data.key, rate: body.data.rate, note: body.data.note ?? null, userId: (u as any).id ?? (u as any).userId ?? null });
      log.info({ key: row.key, rate: row.rate }, "[CARRIER_COST] rate typed");
      return { ok: true, rate: { ...row, effectiveFrom: row.effectiveFrom?.toISOString() ?? null } };
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg === "unknown_rate_key" || msg === "invalid_rate") return reply.code(400).send({ error: msg });
      throw e;
    }
  });

  app.get("/admin/billing/cost/sync", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const cursor = await d.carrierSyncCursor.findUnique({ where: { id: cursorId(VOIPMS_PRIMARY_ACCOUNT_ID) } });
    const earliest = await d.carrierUsageRecord.findFirst({ where: { carrier: "VOIPMS" }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } });
    const latest = await d.carrierUsageRecord.findFirst({ where: { carrier: "VOIPMS" }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } });
    const total = await d.carrierUsageRecord.count({ where: { carrier: "VOIPMS" } });
    return { cursor, earliest: earliest?.occurredAt ?? null, latest: latest?.occurredAt ?? null, records: total };
  });

  const syncBody = z.object({ from: z.string(), to: z.string(), accountId: z.string().optional() });
  app.post("/admin/billing/cost/sync", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const body = syncBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const from = parseDay(body.data.from);
    const to = parseDay(body.data.to);
    if (!from || !to || to < from) return reply.code(400).send({ error: "invalid_range" });
    if ((to.getTime() - from.getTime()) / 86_400_000 > 62) return reply.code(400).send({ error: "range_too_long", max_days: 62 });
    const accountId = body.data.accountId || VOIPMS_PRIMARY_ACCOUNT_ID;
    const result = await runVoipmsCostSync(d, voipmsApiForAccount(accountId), {
      accountId,
      from,
      to,
      pauseMs: 250,
      log: (m) => log.info({}, m),
    });
    return result;
  });
}
