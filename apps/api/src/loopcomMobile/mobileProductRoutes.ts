/**
 * LoopCom Mobile — PRODUCT routes (2026-09-16, the approved full build).
 *
 * This file carries the full product area's API on top of the foundation in
 * mobileRoutes.ts (which keeps the original lifecycle/console routes; nothing
 * there moved). Same gates, same discipline:
 *
 *  - Tenant surface on `/mobile-service/*`, tenant ALWAYS from the JWT.
 *    ⛔ One key per page: each page's resource prefix carries that page's own
 *    permission in PORTAL_API_PERMISSION_RULES (dashboard rides the base
 *    `/mobile-service` rule), so a custom role granting one page opens
 *    exactly that page's data and nothing else.
 *  - Owner console on `/admin/mobile-service/*`, requireOwner on every route.
 *  - Money: NOTHING here spends money. Invoice generation writes LoopCom's
 *    OWN LM- ledger (MobileInvoice) — it never touches the Voice billing
 *    engine, and it is idempotent by @@unique(tenantId, periodStart).
 *  - Carrier submission of ports stays ABSENT on purpose: the admin PATCH
 *    mirrors what the owner did at the carrier and notifies the customer; no
 *    route files anything with Telnyx.
 *  - Member gating: what a plain USER jwt may do is governed by the tenant's
 *    MobileTenantSettings switches (manager/admin roles always may).
 */

import { z } from "zod";
import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { TelnyxError } from "../telnyx/telnyxClient";
import { getAccountBalance } from "./telnyxWirelessClient";
import { getMobileCapabilityReport } from "./mobileCapabilities";
import { readActivationCode } from "./mobileService";
import {
  buildMobileBillingLineItems,
  computeDataOverageCents,
  computeUsageTotals,
  projectCycleDataMb,
  type MobileBillingLineInput,
  type MobilePlanShape,
} from "./mobilePlanMath";
import { writeMobileAuditSync } from "./mobileAudit";
import {
  mobileInvoiceEmail,
  planChangedEmail,
  portStatusEmail,
  queueMobileEmail,
  resolveMobileRecipients,
} from "./mobileEmails";

export interface MobileProductRouteDeps {
  app: any;
  db: any;
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
}

// ── Small shared helpers ─────────────────────────────────────────────────────

function cycleStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
function cycleEnd(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

function subscriberSummary(s: any): any {
  return s
    ? { id: s.id, firstName: s.firstName, lastName: s.lastName, name: `${s.firstName} ${s.lastName}`.trim(), email: s.email, role: s.role, notifyEmail: s.notifyEmail }
    : null;
}

function planShape(plan: any): MobilePlanShape | null {
  return plan
    ? {
        id: plan.id, name: plan.name, monthlyPriceCents: plan.monthlyPriceCents,
        activationFeeCents: plan.activationFeeCents, simFeeCents: plan.simFeeCents, esimFeeCents: plan.esimFeeCents,
        includedDataMb: plan.includedDataMb, includedVoiceMinutes: plan.includedVoiceMinutes, includedSms: plan.includedSms,
        dataOverageBehavior: plan.dataOverageBehavior, dataOverageCentsPerGb: plan.dataOverageCentsPerGb,
      }
    : null;
}

/** Estimated cycle charges for one line: recount over just this line. */
function lineCycleEstimateCents(line: any, usedDataMb: number, period: { start: Date; end: Date }): number {
  const input: MobileBillingLineInput = {
    lineId: line.id, label: line.label, status: line.status, plan: planShape(line.plan),
    activatedAt: line.activatedAt, terminatedAt: line.terminatedAt, usedDataMb,
  };
  return buildMobileBillingLineItems([input], period).reduce((s, i) => s + i.amountCents, 0);
}

async function tenantCycleRecount(db: any, tenantId: string, period: { start: Date; end: Date }) {
  const lines = await db.mobileLine.findMany({ where: { tenantId }, include: { plan: true } });
  const inputs: MobileBillingLineInput[] = [];
  for (const line of lines) {
    const usage = await db.mobileUsageRecord.aggregate({
      _sum: { quantity: true },
      where: { lineId: line.id, kind: "data", recordedAt: { gte: period.start, lt: period.end } },
    });
    inputs.push({
      lineId: line.id, label: line.phoneNumber ?? line.label, status: line.status,
      plan: planShape(line.plan), activatedAt: line.activatedAt, terminatedAt: line.terminatedAt,
      usedDataMb: Number(usage?._sum?.quantity ?? 0),
    });
  }
  const items = buildMobileBillingLineItems(inputs, period);
  return { items, totalCents: items.reduce((s, i) => s + i.amountCents, 0), lineCount: inputs.filter((i) => i.plan && (i.status === "active" || i.status === "suspended" || i.status === "lost")).length };
}

const DEFAULT_TENANT_SETTINGS = {
  usageWarnPct: 90, billingEmails: [] as string[],
  notifyUsage: true, notifyPorts: true, notifyInvoices: true, notifyNewDevice: false,
  memberCanPause: true, memberCanChangePlan: false, memberCanReportLost: true, memberCanPort: false,
};

export async function getTenantMobileSettings(db: any, tenantId: string): Promise<typeof DEFAULT_TENANT_SETTINGS> {
  const row = await db.mobileTenantSettings.findUnique({ where: { tenantId } }).catch(() => null);
  if (!row) return { ...DEFAULT_TENANT_SETTINGS };
  return {
    usageWarnPct: row.usageWarnPct, billingEmails: Array.isArray(row.billingEmails) ? row.billingEmails : [],
    notifyUsage: row.notifyUsage, notifyPorts: row.notifyPorts, notifyInvoices: row.notifyInvoices, notifyNewDevice: row.notifyNewDevice,
    memberCanPause: row.memberCanPause, memberCanChangePlan: row.memberCanChangePlan,
    memberCanReportLost: row.memberCanReportLost, memberCanPort: row.memberCanPort,
  };
}

/** A plain USER jwt is a "member"; TENANT_ADMIN and up always may. */
export async function memberMay(db: any, user: { tenantId: string; role?: string }, flag: "memberCanPause" | "memberCanChangePlan" | "memberCanReportLost" | "memberCanPort"): Promise<boolean> {
  if (String(user.role || "").toUpperCase() !== "USER") return true;
  const s = await getTenantMobileSettings(db, user.tenantId);
  return Boolean(s[flag]);
}

const DEFAULT_PLATFORM_SETTINGS = {
  id: "default", defaultPlanId: null as string | null, spnName: "LoopCom",
  balanceFloorCents: 5000, anomalyMultiplier: 3, simReorderFloor: 20, staleEsimNudgeDays: 7,
  selfServeLines: false, topUpsEnabled: false, invoicePrefix: "LM-",
  maxLinesPerTenant: 50, maxEsimReplacementsPer30: 3, codeReadAlertPerHour: 5, deadLetterAlert: true,
};

export async function getPlatformMobileSettings(db: any): Promise<typeof DEFAULT_PLATFORM_SETTINGS> {
  const row = await db.mobilePlatformSettings.findUnique({ where: { id: "default" } }).catch(() => null);
  return row ? { ...DEFAULT_PLATFORM_SETTINGS, ...row } : { ...DEFAULT_PLATFORM_SETTINGS };
}

/** JS day-bucket rollup — usage volumes are small enough per tenant/cycle. */
function rollupDaily(records: Array<{ recordedAt: Date; kind: string; quantity: number }>): Array<{ day: string; dataMb: number; voiceSeconds: number; smsCount: number }> {
  const byDay = new Map<string, { dataMb: number; voiceSeconds: number; smsCount: number }>();
  for (const r of records) {
    const day = r.recordedAt.toISOString().slice(0, 10);
    const slot = byDay.get(day) ?? { dataMb: 0, voiceSeconds: 0, smsCount: 0 };
    const q = Number(r.quantity || 0);
    if (r.kind === "data") slot.dataMb += q;
    else if (r.kind === "voice") slot.voiceSeconds += q;
    else if (r.kind === "sms") slot.smsCount += q;
    byDay.set(day, slot);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => ({ day, dataMb: Math.round(v.dataMb * 100) / 100, voiceSeconds: v.voiceSeconds, smsCount: v.smsCount }));
}

async function encryptSecretValue(value: string): Promise<string | null> {
  try {
    const sec = await import("@connect/security");
    if (!sec.hasCredentialsMasterKey()) return null;
    return sec.encryptJson({ v: value });
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerMobileProductRoutes(deps: MobileProductRouteDeps): void {
  const { app, db, requireOwner } = deps;

  const tenantUser = (req: any, reply: any): { sub: string; tenantId: string; role: string } | null => {
    const u = req.user as { sub?: string; tenantId?: string; role?: string } | undefined;
    if (!u?.tenantId || !u?.sub) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return { sub: u.sub, tenantId: u.tenantId, role: String(u.role || "USER") };
  };

  // ══════════════════════════ TENANT: DASHBOARD ═════════════════════════════

  app.get("/mobile-service/dashboard", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const start = cycleStart();
    const end = cycleEnd();
    const [lines, usage, ports, activity, settings] = await Promise.all([
      db.mobileLine.findMany({ where: { tenantId: u.tenantId }, include: { plan: true, sim: true, subscriber: true }, orderBy: { createdAt: "asc" } }),
      db.mobileUsageRecord.findMany({ where: { tenantId: u.tenantId, recordedAt: { gte: start } }, select: { kind: true, quantity: true, lineId: true } }),
      db.mobilePortRequest.findMany({ where: { tenantId: u.tenantId, status: { notIn: ["completed", "cancelled"] } }, orderBy: { createdAt: "desc" }, take: 20 }),
      db.auditLog.findMany({ where: { tenantId: u.tenantId, action: { startsWith: "mobile." } }, orderBy: { createdAt: "desc" }, take: 12, select: { action: true, entityType: true, entityId: true, createdAt: true, metadata: true } }),
      getTenantMobileSettings(db, u.tenantId),
    ]);

    const totals = computeUsageTotals(usage);
    const byLine: Record<string, { dataMb: number }> = {};
    for (const r of usage) {
      if (!r.lineId || r.kind !== "data") continue;
      byLine[r.lineId] = { dataMb: (byLine[r.lineId]?.dataMb ?? 0) + Number(r.quantity || 0) };
    }

    const counts = { active: 0, pending: 0, suspended: 0, draft: 0, terminated: 0 };
    for (const l of lines) {
      if (l.status === "active") counts.active += 1;
      else if (l.status === "pending_activation") counts.pending += 1;
      else if (l.status === "suspended" || l.status === "lost") counts.suspended += 1;
      else if (l.status === "draft") counts.draft += 1;
      else if (l.status === "terminated") counts.terminated += 1;
    }

    const pooledIncludedMb = lines.reduce((s: number, l: any) => s + (l.status !== "terminated" ? (l.plan?.includedDataMb ?? 0) : 0), 0);

    // Attention items — computed, never stored, so they can't go stale.
    const attention: any[] = [];
    for (const l of lines) {
      const used = byLine[l.id]?.dataMb ?? 0;
      const included = l.plan?.includedDataMb ?? null;
      if (l.status === "active" && included && included > 0) {
        const pct = Math.round((used / included) * 100);
        if (pct >= settings.usageWarnPct) {
          const over = computeDataOverageCents(planShape(l.plan)!, projectCycleDataMb(used, start, end, new Date()));
          attention.push({
            kind: "usage", severity: pct >= 100 ? "danger" : "warning", lineId: l.id,
            title: `${l.phoneNumber ?? l.label} is at ${Math.min(pct, 999)}% of its data allowance`,
            detail: l.plan?.dataOverageBehavior === "charge"
              ? `Projected overage ≈ $${(over.overageCents / 100).toFixed(2)} at cycle close`
              : "Data slows for the rest of the cycle once the allowance is used",
            action: "change_plan",
          });
        }
      }
      if (l.status === "pending_activation" && l.sim?.createdAt) {
        const ageDays = Math.floor((Date.now() - new Date(l.sim.createdAt).getTime()) / 86_400_000);
        if (ageDays >= 3) {
          attention.push({
            kind: "esim_uninstalled", severity: "info", lineId: l.id,
            title: `${l.subscriber ? `${l.subscriber.firstName}'s` : "An"} eSIM hasn't been installed yet`,
            detail: `Issued ${ageDays} days ago — open the install screen on the new phone`,
            action: "install_esim",
          });
        }
      }
    }
    for (const p of ports) {
      if (p.status === "action_required" || p.status === "rejected") {
        attention.push({
          kind: "port", severity: p.status === "rejected" ? "danger" : "warning", portRequestId: p.id,
          title: `Transfer of ${p.phoneNumber} needs your attention`,
          detail: p.status === "rejected" ? "The old carrier rejected the request — a detail needs fixing" : "The carrier needs more information to move the number",
          action: "open_porting",
        });
      }
    }

    const estimate = await tenantCycleRecount(db, u.tenantId, { start, end });

    return reply.send({
      cycle: { start: start.toISOString(), end: end.toISOString(), totals, byLine, pooledIncludedMb },
      counts,
      lines: lines.map((l: any) => ({
        id: l.id, label: l.label, status: l.status, phoneNumber: l.phoneNumber,
        plan: l.plan ? { id: l.plan.id, name: l.plan.name, monthlyPriceCents: l.plan.monthlyPriceCents, includedDataMb: l.plan.includedDataMb } : null,
        sim: l.sim ? { type: l.sim.type, esimInstallationStatus: l.sim.esimInstallationStatus, hasActivationCode: Boolean(l.sim.activationCodeEnc) } : null,
        subscriber: subscriberSummary(l.subscriber),
        dataUsedMb: byLine[l.id]?.dataMb ?? 0,
      })),
      attention,
      activity,
      nextInvoice: { totalCents: estimate.totalCents, lineCount: estimate.lineCount, billsAt: end.toISOString(), items: estimate.items.slice(0, 12) },
      settings: { usageWarnPct: settings.usageWarnPct },
    });
  });

  // ══════════════════════════ TENANT: SUBSCRIBERS ═══════════════════════════

  app.get("/mobile-service/subscribers", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const subs = await db.mobileSubscriber.findMany({
      where: { tenantId: u.tenantId },
      include: { lines: { include: { plan: true, sim: true } } },
      orderBy: [{ createdAt: "asc" }],
    });
    return reply.send({
      subscribers: subs.map((s: any) => ({
        ...subscriberSummary(s),
        createdAt: s.createdAt,
        lines: s.lines.map((l: any) => ({
          id: l.id, phoneNumber: l.phoneNumber, label: l.label, status: l.status,
          plan: l.plan ? { id: l.plan.id, name: l.plan.name } : null,
          simType: l.sim?.type ?? null,
          e911Status: l.e911Status,
        })),
      })),
    });
  });

  const subscriberBody = z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    email: z.string().trim().email().max(160).nullish(),
    role: z.enum(["member", "manager"]).optional(),
    notifyEmail: z.boolean().optional(),
  });

  app.post("/mobile-service/subscribers", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = subscriberBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const row = await db.mobileSubscriber.create({
      data: { tenantId: u.tenantId, firstName: body.data.firstName, lastName: body.data.lastName, email: body.data.email ?? null, role: body.data.role ?? "member", notifyEmail: body.data.notifyEmail ?? true },
    });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.subscriber.created", entityType: "MobileSubscriber", entityId: row.id, actorUserId: u.sub, metadata: { name: `${row.firstName} ${row.lastName}` } });
    return reply.send({ subscriber: subscriberSummary(row) });
  });

  app.patch("/mobile-service/subscribers/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = subscriberBody.partial().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const existing = await db.mobileSubscriber.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const row = await db.mobileSubscriber.update({ where: { id: existing.id }, data: body.data as any });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.subscriber.updated", entityType: "MobileSubscriber", entityId: row.id, actorUserId: u.sub, metadata: { fields: Object.keys(body.data) } });
    return reply.send({ subscriber: subscriberSummary(row) });
  });

  const assignBody = z.object({ lineId: z.string().min(1) });
  app.post("/mobile-service/subscribers/:id/assign-line", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = assignBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [sub, line] = await Promise.all([
      db.mobileSubscriber.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } }),
      db.mobileLine.findFirst({ where: { id: body.data.lineId, tenantId: u.tenantId } }),
    ]);
    if (!sub || !line) return reply.code(404).send({ error: "not_found" });
    await db.mobileLine.update({ where: { id: line.id }, data: { subscriberId: sub.id } });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.subscriber.line_assigned", entityType: "MobileLine", entityId: line.id, actorUserId: u.sub, metadata: { subscriberId: sub.id } });
    return reply.send({ ok: true });
  });

  app.post("/mobile-service/subscribers/:id/unassign-line", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = assignBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const line = await db.mobileLine.findFirst({ where: { id: body.data.lineId, tenantId: u.tenantId, subscriberId: String(req.params.id) } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    await db.mobileLine.update({ where: { id: line.id }, data: { subscriberId: null } });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.subscriber.line_unassigned", entityType: "MobileLine", entityId: line.id, actorUserId: u.sub });
    return reply.send({ ok: true });
  });

  // ══════════════════════════ TENANT: LINES ═════════════════════════════════

  app.get("/mobile-service/lines", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const start = cycleStart();
    const end = cycleEnd();
    const [lines, usage, plans, settings] = await Promise.all([
      db.mobileLine.findMany({ where: { tenantId: u.tenantId }, include: { plan: true, sim: true, subscriber: true }, orderBy: { createdAt: "asc" } }),
      db.mobileUsageRecord.findMany({ where: { tenantId: u.tenantId, recordedAt: { gte: start } }, select: { kind: true, quantity: true, lineId: true } }),
      db.mobilePlan.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      getTenantMobileSettings(db, u.tenantId),
    ]);
    const creds = await resolveTelnyxCredentials(db);
    const capability = await getMobileCapabilityReport(creds).catch(() => null);
    const byLine: Record<string, number> = {};
    for (const r of usage) {
      if (r.lineId && r.kind === "data") byLine[r.lineId] = (byLine[r.lineId] ?? 0) + Number(r.quantity || 0);
    }
    return reply.send({
      capability: capability ? { data: true, voice: "beta", sms: "blocked" } : null,
      memberActions: {
        pause: u.role !== "USER" || settings.memberCanPause,
        changePlan: u.role !== "USER" || settings.memberCanChangePlan,
        reportLost: u.role !== "USER" || settings.memberCanReportLost,
      },
      plans: plans.map((p: any) => ({ id: p.id, name: p.name, monthlyPriceCents: p.monthlyPriceCents, includedDataMb: p.includedDataMb })),
      lines: lines.map((l: any) => {
        const used = byLine[l.id] ?? 0;
        return {
          id: l.id, label: l.label, status: l.status, phoneNumber: l.phoneNumber,
          plan: l.plan ? { id: l.plan.id, name: l.plan.name, monthlyPriceCents: l.plan.monthlyPriceCents, includedDataMb: l.plan.includedDataMb, dataOverageBehavior: l.plan.dataOverageBehavior } : null,
          sim: l.sim ? { id: l.sim.id, type: l.sim.type, iccidLast4: l.sim.iccid ? String(l.sim.iccid).slice(-4) : null, esimInstallationStatus: l.sim.esimInstallationStatus, hasActivationCode: Boolean(l.sim.activationCodeEnc) } : null,
          subscriber: subscriberSummary(l.subscriber),
          suspendReason: l.suspendReason,
          activatedAt: l.activatedAt,
          e911Status: l.e911Status,
          portIn: false,
          dataUsedMb: Math.round(used * 100) / 100,
          estimateCents: lineCycleEstimateCents(l, used, { start, end }),
        };
      }),
    });
  });

  /** Tenant-visible activity/audit slice for one line. */
  app.get("/mobile-service/lines/:id/activity", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const line = await db.mobileLine.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId }, select: { id: true } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    const rows = await db.auditLog.findMany({
      where: { tenantId: u.tenantId, entityId: line.id, action: { startsWith: "mobile." } },
      orderBy: { createdAt: "desc" }, take: 40,
      select: { action: true, createdAt: true, metadata: true, actorUser: { select: { email: true, name: true } } },
    });
    return reply.send({ activity: rows });
  });

  const e911Body = z.object({
    line1: z.string().trim().min(3).max(120),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(2).max(2),
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/),
  });
  app.put("/mobile-service/lines/:id/e911", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = e911Body.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const line = await db.mobileLine.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    await db.mobileLine.update({ where: { id: line.id }, data: { e911Address: body.data as any, e911Status: "on_file" } });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.line.e911_saved", entityType: "MobileLine", entityId: line.id, actorUserId: u.sub, metadata: { city: body.data.city, state: body.data.state } });
    return reply.send({ ok: true, e911Status: "on_file", note: "Address saved. Carrier-side registration follows automatically once the line has its number — mobile E911 rules differ from fixed lines." });
  });

  /** Customer change-plan: free, effective now, invoice prorates by day. */
  const changePlanBody = z.object({ planId: z.string().min(1) });
  app.post("/mobile-service/lines/:id/change-plan", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!(await memberMay(db, u, "memberCanChangePlan"))) {
      return reply.code(403).send({ error: "member_not_allowed", message: "Plan changes are limited to managers on this account. Ask a manager, or change this under Mobile Settings." });
    }
    const body = changePlanBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [line, plan] = await Promise.all([
      db.mobileLine.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId }, include: { subscriber: true } }),
      db.mobilePlan.findFirst({ where: { id: body.data.planId, active: true } }),
    ]);
    if (!line) return reply.code(404).send({ error: "not_found" });
    if (!plan) return reply.code(404).send({ error: "plan_not_found" });
    if (line.status === "terminated") return reply.code(409).send({ error: "line_terminated" });
    await db.mobileLine.update({ where: { id: line.id }, data: { planId: plan.id } });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.line.plan_changed", entityType: "MobileLine", entityId: line.id, actorUserId: u.sub, metadata: { planId: plan.id, planName: plan.name } });
    const to = await resolveMobileRecipients(db, u.tenantId, line.subscriber?.notifyEmail ? line.subscriber?.email : null);
    if (to.length) {
      await queueMobileEmail(db, { tenantId: u.tenantId, kind: "plan_changed", email: planChangedEmail({ lineLabel: line.label, phoneNumber: line.phoneNumber, planName: plan.name, monthlyPriceCents: plan.monthlyPriceCents }), to, entityType: "MobileLine", entityId: line.id });
    }
    return reply.send({ ok: true, plan: { id: plan.id, name: plan.name, monthlyPriceCents: plan.monthlyPriceCents } });
  });

  // ══════════════════════════ TENANT: USAGE ═════════════════════════════════

  app.get("/mobile-service/usage", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const start = cycleStart();
    const end = cycleEnd();
    const [records, lines] = await Promise.all([
      db.mobileUsageRecord.findMany({
        where: { tenantId: u.tenantId, recordedAt: { gte: start, lt: end } },
        select: { recordedAt: true, kind: true, quantity: true, lineId: true },
        orderBy: { recordedAt: "asc" }, take: 20000,
      }),
      db.mobileLine.findMany({ where: { tenantId: u.tenantId }, include: { plan: true, subscriber: true } }),
    ]);
    const totals = computeUsageTotals(records);
    const daily = rollupDaily(records);
    const byLine = new Map<string, { dataMb: number; voiceSeconds: number; smsCount: number }>();
    for (const r of records) {
      if (!r.lineId) continue;
      const slot = byLine.get(r.lineId) ?? { dataMb: 0, voiceSeconds: 0, smsCount: 0 };
      const q = Number(r.quantity || 0);
      if (r.kind === "data") slot.dataMb += q;
      else if (r.kind === "voice") slot.voiceSeconds += q;
      else if (r.kind === "sms") slot.smsCount += q;
      byLine.set(r.lineId, slot);
    }
    const now = new Date();
    const perLine = lines
      .filter((l: any) => l.status !== "terminated")
      .map((l: any) => {
        const use = byLine.get(l.id) ?? { dataMb: 0, voiceSeconds: 0, smsCount: 0 };
        const included = l.plan?.includedDataMb ?? null;
        const projectedMb = projectCycleDataMb(use.dataMb, start, end, now);
        const shape = planShape(l.plan);
        const overage = shape ? computeDataOverageCents(shape, projectedMb) : { overageMb: 0, overageCents: 0 };
        return {
          lineId: l.id, phoneNumber: l.phoneNumber, label: l.label,
          subscriber: l.subscriber ? `${l.subscriber.firstName} ${l.subscriber.lastName}`.trim() : null,
          planName: l.plan?.name ?? null, includedDataMb: included,
          dataMb: Math.round(use.dataMb * 100) / 100, voiceSeconds: use.voiceSeconds, smsCount: use.smsCount,
          projectedDataMb: projectedMb,
          projectedOverageCents: overage.overageCents,
          risk: included && included > 0 ? (use.dataMb / included >= 1 ? "over" : projectedMb / included >= 1 ? "will_overage" : "on_track") : "on_track",
        };
      })
      .sort((a: any, b: any) => (b.includedDataMb ? b.dataMb / b.includedDataMb : 0) - (a.includedDataMb ? a.dataMb / a.includedDataMb : 0));

    // Past cycles: 6 months of aggregates.
    const pastCycles: any[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const s = new Date(start.getFullYear(), start.getMonth() - i, 1);
      const e = new Date(start.getFullYear(), start.getMonth() - i + 1, 1);
      const [agg, inv] = await Promise.all([
        db.mobileUsageRecord.groupBy({ by: ["kind"], _sum: { quantity: true }, where: { tenantId: u.tenantId, recordedAt: { gte: s, lt: e } } }).catch(() => []),
        db.mobileInvoice.findFirst({ where: { tenantId: u.tenantId, periodStart: s }, select: { id: true, number: true, totalCents: true } }).catch(() => null),
      ]);
      const get = (kind: string) => Number((agg as any[]).find((a) => a.kind === kind)?._sum?.quantity ?? 0);
      if (get("data") || get("voice") || get("sms") || inv) {
        pastCycles.push({ start: s.toISOString(), end: e.toISOString(), dataMb: get("data"), voiceSeconds: get("voice"), smsCount: get("sms"), invoice: inv });
      }
    }

    return reply.send({ cycle: { start: start.toISOString(), end: end.toISOString() }, totals, daily, perLine, pastCycles });
  });

  // ══════════════════════════ TENANT: BILLING ═══════════════════════════════

  app.get("/mobile-service/billing", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const start = cycleStart();
    const end = cycleEnd();
    const [estimate, invoices, settings] = await Promise.all([
      tenantCycleRecount(db, u.tenantId, { start, end }),
      db.mobileInvoice.findMany({ where: { tenantId: u.tenantId }, orderBy: { issuedAt: "desc" }, take: 24, select: { id: true, number: true, periodStart: true, periodEnd: true, status: true, totalCents: true, issuedAt: true, paidAt: true } }),
      getTenantMobileSettings(db, u.tenantId),
    ]);
    const balanceCents = invoices.filter((i: any) => i.status === "open").reduce((s: number, i: any) => s + i.totalCents, 0);
    return reply.send({
      balanceCents,
      nextInvoice: { totalCents: estimate.totalCents, lineCount: estimate.lineCount, billsAt: end.toISOString(), items: estimate.items },
      invoices,
      billingEmails: settings.billingEmails,
    });
  });

  app.get("/mobile-service/billing/invoices/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const inv = await db.mobileInvoice.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!inv) return reply.code(404).send({ error: "not_found" });
    const tenant = await db.tenant.findUnique({ where: { id: u.tenantId }, select: { name: true } });
    return reply.send({ invoice: inv, tenantName: tenant?.name ?? null });
  });

  // ══════════════════════════ TENANT: PORTING ═══════════════════════════════

  app.get("/mobile-service/port-requests/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const row = await db.mobilePortRequest.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    const d = (row.detail ?? {}) as any;
    return reply.send({
      portRequest: {
        id: row.id, phoneNumber: row.phoneNumber, status: row.status, carrier: row.carrier, focDate: row.focDate,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
        holderName: d.holderName ?? null, serviceAddress: d.serviceAddress ?? null,
        accountNumberLast4: d.accountNumberLast4 ?? null, pinOnFile: Boolean(d.transferPinEnc),
      },
    });
  });

  /** Carrier details for a DRAFT/action_required port. The PIN is stored
   *  encrypted (same envelope as eSIM codes) and never returned. */
  const portDetailBody = z.object({
    carrier: z.string().trim().min(1).max(80).optional(),
    holderName: z.string().trim().min(1).max(120).optional(),
    serviceAddress: z.string().trim().min(3).max(240).optional(),
    accountNumber: z.string().trim().min(1).max(60).optional(),
    transferPin: z.string().trim().min(2).max(30).optional(),
  });
  app.patch("/mobile-service/port-requests/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = portDetailBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const row = await db.mobilePortRequest.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!["draft", "action_required", "rejected"].includes(row.status)) {
      return reply.code(409).send({ error: "not_editable", message: "This transfer is already with the carrier — contact support to change its details." });
    }
    const detail = { ...((row.detail ?? {}) as any) };
    if (body.data.holderName !== undefined) detail.holderName = body.data.holderName;
    if (body.data.serviceAddress !== undefined) detail.serviceAddress = body.data.serviceAddress;
    if (body.data.accountNumber !== undefined) detail.accountNumberLast4 = body.data.accountNumber.slice(-4);
    if (body.data.transferPin !== undefined) {
      const enc = await encryptSecretValue(body.data.transferPin);
      if (!enc) return reply.code(503).send({ error: "encryption_unavailable", message: "Couldn't store the PIN securely — try again shortly." });
      detail.transferPinEnc = enc;
    }
    const updated = await db.mobilePortRequest.update({
      where: { id: row.id },
      data: { carrier: body.data.carrier ?? row.carrier, detail: detail as any },
    });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.port.details_updated", entityType: "MobilePortRequest", entityId: row.id, actorUserId: u.sub, metadata: { fields: Object.keys(body.data), pinProvided: body.data.transferPin !== undefined } });
    return reply.send({ ok: true, status: updated.status, pinOnFile: Boolean(detail.transferPinEnc) });
  });

  // ══════════════════════════ TENANT: DEVICES ═══════════════════════════════

  app.get("/mobile-service/devices", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const sims = await db.mobileSim.findMany({
      where: { tenantId: u.tenantId },
      include: { line: { include: { subscriber: true, plan: true } } },
      orderBy: { createdAt: "desc" },
    });
    return reply.send({
      devices: sims.map((s: any) => ({
        simId: s.id, type: s.type, status: s.status,
        iccidLast4: s.iccid ? String(s.iccid).slice(-4) : null,
        esimInstallationStatus: s.esimInstallationStatus,
        hasActivationCode: Boolean(s.activationCodeEnc),
        lastSyncAt: s.lastSyncAt,
        issuedAt: s.createdAt,
        line: s.line ? {
          id: s.line.id, phoneNumber: s.line.phoneNumber, label: s.line.label, status: s.line.status,
          subscriber: subscriberSummary(s.line.subscriber), planName: s.line.plan?.name ?? null,
        } : null,
      })),
    });
  });

  /** eSIM install screen via the Devices page's own key (mirror of the lines route; the read is audited the same). */
  app.get("/mobile-service/devices/:lineId/esim", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const line = await db.mobileLine.findFirst({ where: { id: String(req.params.lineId), tenantId: u.tenantId }, include: { sim: true } });
    if (!line?.sim) return reply.code(404).send({ error: "no_sim" });
    if (line.sim.type !== "esim") return reply.code(409).send({ error: "not_an_esim" });
    const code = await readActivationCode(db, line.sim.id);
    if (!code) return reply.code(409).send({ error: "no_activation_code", message: "This eSIM has no retrievable activation code (it may already be installed)." });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.esim.code_viewed", entityType: "MobileSim", entityId: line.sim.id, actorUserId: u.sub });
    return reply.send({
      activationCode: code,
      installationStatus: line.sim.esimInstallationStatus,
      lineStatus: line.status,
      instructions: [
        "On the phone: Settings > Cellular (or Mobile Network) > Add eSIM.",
        "Scan this QR code, or choose 'Enter details manually' and paste the activation code.",
        "Keep Wi-Fi on during installation; the line activates within a few minutes of install.",
      ],
    });
  });

  // ══════════════════════════ TENANT: SUPPORT ═══════════════════════════════

  /** Customer-safe diagnostics: local truth only, plain-English findings, no raw provider payloads. */
  app.get("/mobile-service/support/diagnostics/:lineId", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const line = await db.mobileLine.findFirst({ where: { id: String(req.params.lineId), tenantId: u.tenantId }, include: { plan: true, sim: true } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    const [lastUsage, lastEvent] = await Promise.all([
      db.mobileUsageRecord.findFirst({ where: { lineId: line.id }, orderBy: { recordedAt: "desc" }, select: { recordedAt: true, kind: true, quantity: true } }),
      line.sim?.telnyxSimId
        ? db.mobileWebhookEvent.findFirst({ where: { telnyxSimId: line.sim.telnyxSimId }, orderBy: { receivedAt: "desc" }, select: { eventType: true, receivedAt: true } })
        : Promise.resolve(null),
    ]);
    const checks: Array<{ check: string; result: "pass" | "warn" | "fail" | "skip"; detail: string }> = [];
    checks.push({ check: "Line state", result: line.status === "active" ? "pass" : line.status === "terminated" ? "fail" : "warn", detail: `The line is ${line.status.replace(/_/g, " ")}.` });
    if (!line.sim) checks.push({ check: "SIM", result: "fail", detail: "No SIM is attached to this line yet." });
    else {
      checks.push({ check: "SIM", result: line.sim.status === "enabled" ? "pass" : "warn", detail: `${line.sim.type === "esim" ? "eSIM" : "Physical SIM"} · carrier state ${line.sim.status ?? "unknown"}.` });
      if (line.sim.type === "esim") {
        checks.push({
          check: "eSIM install",
          result: line.sim.esimInstallationStatus === "released" ? "warn" : "pass",
          detail: line.sim.esimInstallationStatus === "released" ? "The eSIM is issued but hasn't been added to a phone yet." : `Install status: ${line.sim.esimInstallationStatus ?? "installed"}.`,
        });
      }
    }
    checks.push(lastUsage
      ? { check: "Recent activity", result: "pass", detail: `Last ${lastUsage.kind} usage recorded ${new Date(lastUsage.recordedAt).toLocaleString("en-US")}.` }
      : { check: "Recent activity", result: line.status === "active" ? "warn" : "skip", detail: "No usage recorded yet." });
    const nextStep =
      line.status === "pending_activation" && line.sim?.esimInstallationStatus === "released"
        ? { action: "install_esim", text: "Everything is ready — the eSIM just hasn't been installed. Open the install screen and scan the QR on the new phone." }
        : line.status === "suspended" || line.status === "lost"
          ? { action: "resume", text: "The line is suspended. Resume it from the Lines page, or contact support if you didn't expect this." }
          : null;
    return reply.send({ line: { id: line.id, phoneNumber: line.phoneNumber, label: line.label, status: line.status }, checks, nextStep, lastEvent });
  });

  // ══════════════════════════ TENANT: SETTINGS ══════════════════════════════

  app.get("/mobile-service/settings", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const [settings, lines] = await Promise.all([
      getTenantMobileSettings(db, u.tenantId),
      db.mobileLine.findMany({ where: { tenantId: u.tenantId, status: { not: "terminated" } }, select: { id: true, phoneNumber: true, label: true, e911Status: true, e911Address: true }, orderBy: { createdAt: "asc" } }),
    ]);
    return reply.send({ settings, e911: lines });
  });

  const settingsBody = z.object({
    usageWarnPct: z.number().int().min(50).max(100).optional(),
    billingEmails: z.array(z.string().trim().email().max(160)).max(6).optional(),
    notifyUsage: z.boolean().optional(),
    notifyPorts: z.boolean().optional(),
    notifyInvoices: z.boolean().optional(),
    notifyNewDevice: z.boolean().optional(),
    memberCanPause: z.boolean().optional(),
    memberCanChangePlan: z.boolean().optional(),
    memberCanReportLost: z.boolean().optional(),
    memberCanPort: z.boolean().optional(),
  });
  app.put("/mobile-service/settings", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (u.role === "USER") return reply.code(403).send({ error: "member_not_allowed", message: "Only managers can change mobile settings." });
    const body = settingsBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const data: any = { ...body.data };
    if (data.billingEmails) data.billingEmails = data.billingEmails as any;
    const row = await db.mobileTenantSettings.upsert({
      where: { tenantId: u.tenantId },
      update: data,
      create: { tenantId: u.tenantId, ...data },
    });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.settings.updated", entityType: "MobileTenantSettings", entityId: row.id, actorUserId: u.sub, metadata: { fields: Object.keys(body.data) } });
    return reply.send({ ok: true, settings: await getTenantMobileSettings(db, u.tenantId) });
  });

  // ═══════════════════════════ ADMIN CONSOLE ════════════════════════════════

  app.get("/admin/mobile-service/overview", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const start = cycleStart();
    const end = cycleEnd();
    const [lines, sims, portsOpen, deadLetters, staleEvents, usageAgg, costAgg, platform] = await Promise.all([
      db.mobileLine.findMany({ include: { plan: true } }),
      db.mobileSim.groupBy({ by: ["type"], _count: { _all: true } }).catch(() => []),
      db.mobilePortRequest.count({ where: { status: { notIn: ["completed", "cancelled", "draft"] } } }),
      db.mobileWebhookEvent.count({ where: { status: "dead_letter" } }),
      db.mobileWebhookEvent.count({ where: { status: "failed" } }),
      db.mobileUsageRecord.aggregate({ _sum: { quantity: true }, where: { kind: "data", recordedAt: { gte: start } } }),
      db.mobileUsageRecord.aggregate({ _sum: { costCents: true }, where: { recordedAt: { gte: start } } }),
      getPlatformMobileSettings(db),
    ]);
    const counts = { total: lines.length, active: 0, pending: 0, suspended: 0, draft: 0, terminated: 0, needsReconcile: 0 };
    for (const l of lines) {
      if (l.status === "active") counts.active += 1;
      else if (l.status === "pending_activation") counts.pending += 1;
      else if (l.status === "suspended" || l.status === "lost") counts.suspended += 1;
      else if (l.status === "draft") counts.draft += 1;
      else if (l.status === "terminated") counts.terminated += 1;
      if (l.needsReconcile) counts.needsReconcile += 1;
    }
    const simMix = { esim: 0, physical: 0 };
    for (const g of sims as any[]) {
      if (g.type === "esim") simMix.esim = g._count._all;
      else if (g.type === "physical") simMix.physical = g._count._all;
    }
    // Revenue estimate = the recount over every tenant with lines; cost
    // estimate = plan cost estimates prorated + metered usage cost.
    const tenantIds = [...new Set(lines.map((l: any) => l.tenantId))] as string[];
    let revenueCents = 0;
    let planCostCents = 0;
    for (const tid of tenantIds) {
      const rc = await tenantCycleRecount(db, tid, { start, end });
      revenueCents += rc.totalCents;
    }
    for (const l of lines) {
      if ((l.status === "active" || l.status === "suspended" || l.status === "lost") && l.plan) planCostCents += l.plan.telnyxCostCentsEstimate ?? 0;
    }
    const meteredCostCents = Number(costAgg?._sum?.costCents ?? 0);
    const costCents = planCostCents + meteredCostCents;

    const creds = await resolveTelnyxCredentials(db);
    let balance: { balanceCents: number | null; currency: string | null } | null = null;
    if (creds) balance = await getAccountBalance(creds).catch(() => null);

    const subscribers = await db.mobileSubscriber.count();
    const actionItems: any[] = [];
    if (balance?.balanceCents != null && balance.balanceCents < platform.balanceFloorCents) {
      actionItems.push({ severity: "danger", title: `Telnyx balance $${(balance.balanceCents / 100).toFixed(2)} is below the $${(platform.balanceFloorCents / 100).toFixed(0)} floor`, detail: "eSIM purchases will start failing — top up or enable auto-recharge", go: "carrier" });
    }
    if (counts.needsReconcile > 0) actionItems.push({ severity: "warning", title: `${counts.needsReconcile} line(s) need reconcile`, detail: "Carrier state unconfirmed — run reconcile or open diagnostics", go: "diagnostics" });
    if (deadLetters > 0) actionItems.push({ severity: "danger", title: `${deadLetters} webhook event(s) dead-lettered`, detail: "State converges via sweeps; re-fold when the cause is fixed", go: "webhooks" });
    if (staleEvents > 0) actionItems.push({ severity: "warning", title: `${staleEvents} webhook event(s) failed`, detail: "Will retry fold; inspect if they persist", go: "webhooks" });
    const rejectedPorts = await db.mobilePortRequest.count({ where: { status: { in: ["rejected", "action_required"] } } });
    if (rejectedPorts > 0) actionItems.push({ severity: "warning", title: `${rejectedPorts} port(s) rejected or blocked`, detail: "A detail needs fixing before refile", go: "porting" });

    return reply.send({
      subscribers, counts, simMix, portsOpen,
      fleetDataMbMtd: Number(usageAgg?._sum?.quantity ?? 0),
      money: { revenueCents, costCents, planCostCents, meteredCostCents, marginPct: revenueCents > 0 ? Math.round(((revenueCents - costCents) / revenueCents) * 1000) / 10 : null },
      balance, platform: { balanceFloorCents: platform.balanceFloorCents },
      actionItems,
    });
  });

  app.get("/admin/mobile-service/tenants", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const start = cycleStart();
    const end = cycleEnd();
    const lines = await db.mobileLine.findMany({ include: { plan: true, tenant: { select: { id: true, name: true } } } });
    const byTenant = new Map<string, { tenantId: string; name: string; lines: number; active: number; costCents: number }>();
    for (const l of lines) {
      const slot = byTenant.get(l.tenantId) ?? { tenantId: l.tenantId, name: l.tenant?.name ?? l.tenantId, lines: 0, active: 0, costCents: 0 };
      slot.lines += 1;
      if (l.status === "active") slot.active += 1;
      if ((l.status === "active" || l.status === "suspended" || l.status === "lost") && l.plan) slot.costCents += l.plan.telnyxCostCentsEstimate ?? 0;
      byTenant.set(l.tenantId, slot);
    }
    const rows: any[] = [];
    for (const slot of byTenant.values()) {
      const [rc, usage, subs] = await Promise.all([
        tenantCycleRecount(db, slot.tenantId, { start, end }),
        db.mobileUsageRecord.aggregate({ _sum: { quantity: true }, where: { tenantId: slot.tenantId, kind: "data", recordedAt: { gte: start } } }),
        db.mobileSubscriber.count({ where: { tenantId: slot.tenantId } }),
      ]);
      rows.push({
        ...slot, subscribers: subs,
        billCents: rc.totalCents,
        dataMbMtd: Number(usage?._sum?.quantity ?? 0),
        marginPct: rc.totalCents > 0 ? Math.round(((rc.totalCents - slot.costCents) / rc.totalCents) * 1000) / 10 : null,
      });
    }
    rows.sort((a, b) => b.billCents - a.billCents);
    return reply.send({ tenants: rows });
  });

  app.get("/admin/mobile-service/platform-settings", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    return reply.send({ settings: await getPlatformMobileSettings(db) });
  });

  const platformSettingsBody = z.object({
    defaultPlanId: z.string().min(1).nullish(),
    spnName: z.string().trim().min(1).max(30).optional(),
    balanceFloorCents: z.number().int().min(0).max(1_000_000).optional(),
    anomalyMultiplier: z.number().min(1.5).max(20).optional(),
    simReorderFloor: z.number().int().min(0).max(10_000).optional(),
    staleEsimNudgeDays: z.number().int().min(1).max(90).optional(),
    selfServeLines: z.boolean().optional(),
    topUpsEnabled: z.boolean().optional(),
    invoicePrefix: z.string().trim().min(1).max(8).optional(),
    maxLinesPerTenant: z.number().int().min(1).max(10_000).optional(),
    maxEsimReplacementsPer30: z.number().int().min(1).max(100).optional(),
    codeReadAlertPerHour: z.number().int().min(1).max(1000).optional(),
    deadLetterAlert: z.boolean().optional(),
  });
  app.put("/admin/mobile-service/platform-settings", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = platformSettingsBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const row = await db.mobilePlatformSettings.upsert({
      where: { id: "default" },
      update: body.data as any,
      create: { id: "default", ...(body.data as any) },
    });
    await writeMobileAuditSync({ tenantId: (await db.tenant.findFirst({ select: { id: true } }))?.id ?? "platform", action: "mobile.platform_settings.updated", entityType: "MobilePlatformSettings", entityId: "default", actorUserId: user.sub, metadata: { fields: Object.keys(body.data) } }).catch(() => undefined);
    return reply.send({ ok: true, settings: { ...DEFAULT_PLATFORM_SETTINGS, ...row } });
  });

  app.get("/admin/mobile-service/inventory", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const [sims, orders, platform] = await Promise.all([
      db.mobileSim.findMany({ include: { line: { select: { id: true, label: true, phoneNumber: true, tenantId: true, tenant: { select: { name: true } } } } }, orderBy: { createdAt: "desc" }, take: 500 }),
      db.mobileSimOrder.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      getPlatformMobileSettings(db),
    ]);
    const physical = sims.filter((s: any) => s.type === "physical");
    const esims = sims.filter((s: any) => s.type === "esim");
    const staleCutoff = Date.now() - platform.staleEsimNudgeDays * 86_400_000;
    const staleEsims = esims.filter((s: any) => s.esimInstallationStatus === "released" && s.line && new Date(s.createdAt).getTime() < staleCutoff);
    return reply.send({
      physical: {
        inStock: physical.filter((s: any) => !s.line).length,
        assigned: physical.filter((s: any) => Boolean(s.line)).length,
        reorderFloor: platform.simReorderFloor,
      },
      esim: {
        issued: esims.length,
        installed: esims.filter((s: any) => s.esimInstallationStatus && s.esimInstallationStatus !== "released").length,
        pending: esims.filter((s: any) => s.esimInstallationStatus === "released").length,
      },
      staleEsims: staleEsims.map((s: any) => ({
        simId: s.id, issuedAt: s.createdAt, iccidLast4: s.iccid ? String(s.iccid).slice(-4) : null,
        line: s.line ? { id: s.line.id, label: s.line.label, phoneNumber: s.line.phoneNumber, tenantName: s.line.tenant?.name ?? null } : null,
        ageDays: Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 86_400_000),
      })),
      orders: orders.map((o: any) => ({ id: o.id, telnyxOrderId: o.telnyxOrderId, quantity: o.quantity, status: o.status, costAmount: o.costAmount, costCurrency: o.costCurrency, trackingUrl: o.trackingUrl, createdAt: o.createdAt })),
    });
  });

  app.get("/admin/mobile-service/port-requests", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const rows = await db.mobilePortRequest.findMany({
      include: { tenant: { select: { id: true, name: true } }, line: { select: { id: true, label: true } } },
      orderBy: { createdAt: "desc" }, take: 200,
    });
    return reply.send({
      portRequests: rows.map((r: any) => {
        const d = (r.detail ?? {}) as any;
        return {
          id: r.id, phoneNumber: r.phoneNumber, status: r.status, carrier: r.carrier, focDate: r.focDate,
          tenant: r.tenant, line: r.line, createdAt: r.createdAt, updatedAt: r.updatedAt,
          telnyxPortingOrderId: r.telnyxPortingOrderId,
          holderName: d.holderName ?? null, accountNumberLast4: d.accountNumberLast4 ?? null,
          pinOnFile: Boolean(d.transferPinEnc), notes: Array.isArray(d.notes) ? d.notes : [],
        };
      }),
    });
  });

  /** Mirror what the owner did at the carrier + notify the customer. ⛔ This
   *  route files NOTHING with Telnyx — submission is a human act, recorded here. */
  const adminPortPatch = z.object({
    status: z.enum(["draft", "submitted", "pending", "foc", "action_required", "completed", "rejected", "cancelled"]).optional(),
    carrier: z.string().trim().max(80).nullish(),
    focDate: z.string().datetime().nullish(),
    telnyxPortingOrderId: z.string().trim().max(80).nullish(),
    note: z.string().trim().min(1).max(500).optional(),
    lineId: z.string().min(1).nullish(),
  });
  app.patch("/admin/mobile-service/port-requests/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = adminPortPatch.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const row = await db.mobilePortRequest.findUnique({ where: { id: String(req.params.id) } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (body.data.lineId) {
      const line = await db.mobileLine.findFirst({ where: { id: body.data.lineId, tenantId: row.tenantId } });
      if (!line) return reply.code(404).send({ error: "line_not_found" });
    }
    const detail = { ...((row.detail ?? {}) as any) };
    if (body.data.note) {
      detail.notes = [...(Array.isArray(detail.notes) ? detail.notes : []), { at: new Date().toISOString(), by: user.email ?? user.sub, text: body.data.note }].slice(-30);
    }
    const statusChanged = body.data.status !== undefined && body.data.status !== row.status;
    const updated = await db.mobilePortRequest.update({
      where: { id: row.id },
      data: {
        status: body.data.status ?? row.status,
        carrier: body.data.carrier === undefined ? row.carrier : body.data.carrier,
        focDate: body.data.focDate === undefined ? row.focDate : body.data.focDate ? new Date(body.data.focDate) : null,
        telnyxPortingOrderId: body.data.telnyxPortingOrderId === undefined ? row.telnyxPortingOrderId : body.data.telnyxPortingOrderId,
        lineId: body.data.lineId === undefined ? row.lineId : body.data.lineId,
        detail: detail as any,
      },
    });
    await writeMobileAuditSync({ tenantId: row.tenantId, action: statusChanged ? `mobile.port.status_${updated.status}` : "mobile.port.admin_updated", entityType: "MobilePortRequest", entityId: row.id, actorUserId: user.sub, metadata: { status: updated.status, noteAdded: Boolean(body.data.note) } });
    if (statusChanged) {
      const settings = await getTenantMobileSettings(db, row.tenantId);
      if (settings.notifyPorts) {
        const to = await resolveMobileRecipients(db, row.tenantId, null);
        if (to.length) {
          await queueMobileEmail(db, {
            tenantId: row.tenantId, kind: "port_status",
            email: portStatusEmail({ phoneNumber: updated.phoneNumber, status: updated.status, focDate: updated.focDate, carrier: updated.carrier }),
            to, entityType: "MobilePortRequest", entityId: row.id,
          });
        }
      }
    }
    return reply.send({ ok: true, status: updated.status });
  });

  // ── Admin: LM- invoice ledger ──────────────────────────────────────────────

  async function nextInvoiceNumber(prefix: string): Promise<string> {
    const year = new Date().getFullYear();
    const count = await db.mobileInvoice.count();
    for (let i = 0; i < 25; i += 1) {
      const candidate = `${prefix}${year}-${String(count + 1 + i).padStart(4, "0")}`;
      const exists = await db.mobileInvoice.findUnique({ where: { number: candidate }, select: { id: true } });
      if (!exists) return candidate;
    }
    return `${prefix}${year}-${Date.now()}`;
  }

  /** Generate LM- invoices for the PREVIOUS month (a closed period only —
   *  never the running cycle). Idempotent: a tenant+period that already has a
   *  row is skipped, so running twice cannot double-bill. */
  const generateBody = z.object({ confirm: z.literal(true), tenantId: z.string().min(1).optional() });
  app.post("/admin/mobile-service/invoices/generate", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = generateBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "confirm_required", message: "Invoice generation writes the LM- ledger and emails customers. Send confirm:true." });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const platform = await getPlatformMobileSettings(db);
    const where: any = body.data.tenantId ? { tenantId: body.data.tenantId } : {};
    const tenantIds = [...new Set((await db.mobileLine.findMany({ where, select: { tenantId: true } })).map((l: any) => l.tenantId))] as string[];
    const results: any[] = [];
    for (const tid of tenantIds) {
      const existing = await db.mobileInvoice.findUnique({ where: { tenantId_periodStart: { tenantId: tid, periodStart: start } } }).catch(() => null);
      if (existing) {
        results.push({ tenantId: tid, skipped: true, reason: "already_generated", number: existing.number });
        continue;
      }
      const rc = await tenantCycleRecount(db, tid, { start, end });
      if (rc.items.length === 0) {
        results.push({ tenantId: tid, skipped: true, reason: "nothing_billable" });
        continue;
      }
      const number = await nextInvoiceNumber(platform.invoicePrefix);
      let inv: any;
      try {
        inv = await db.mobileInvoice.create({
          data: { tenantId: tid, number, periodStart: start, periodEnd: end, status: "open", totalCents: rc.totalCents, items: rc.items as any },
        });
      } catch (err: any) {
        results.push({ tenantId: tid, skipped: true, reason: `create_failed:${String(err?.code ?? err?.message ?? err).slice(0, 60)}` });
        continue;
      }
      await writeMobileAuditSync({ tenantId: tid, action: "mobile.invoice.generated", entityType: "MobileInvoice", entityId: inv.id, actorUserId: user.sub, metadata: { number, totalCents: rc.totalCents } });
      const settings = await getTenantMobileSettings(db, tid);
      let emailed = 0;
      if (settings.notifyInvoices) {
        const to = await resolveMobileRecipients(db, tid, null);
        if (to.length) {
          emailed = await queueMobileEmail(db, {
            tenantId: tid, kind: "invoice",
            email: mobileInvoiceEmail({ number, totalCents: rc.totalCents, periodStart: start, periodEnd: end, lineCount: rc.lineCount }),
            to, entityType: "MobileInvoice", entityId: inv.id,
          });
        }
      }
      results.push({ tenantId: tid, number, totalCents: rc.totalCents, emailed });
    }
    return reply.send({ period: { start, end }, results });
  });

  app.get("/admin/mobile-service/invoices", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const rows = await db.mobileInvoice.findMany({ include: { tenant: { select: { id: true, name: true } } }, orderBy: { issuedAt: "desc" }, take: 200 });
    return reply.send({ invoices: rows.map((r: any) => ({ id: r.id, number: r.number, tenant: r.tenant, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status, totalCents: r.totalCents, issuedAt: r.issuedAt, paidAt: r.paidAt })) });
  });

  const invoiceStatusBody = z.object({ status: z.enum(["open", "paid", "void"]) });
  app.patch("/admin/mobile-service/invoices/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = invoiceStatusBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const inv = await db.mobileInvoice.findUnique({ where: { id: String(req.params.id) } });
    if (!inv) return reply.code(404).send({ error: "not_found" });
    const updated = await db.mobileInvoice.update({
      where: { id: inv.id },
      data: { status: body.data.status, paidAt: body.data.status === "paid" ? new Date() : body.data.status === "open" ? null : inv.paidAt },
    });
    await writeMobileAuditSync({ tenantId: inv.tenantId, action: `mobile.invoice.${body.data.status}`, entityType: "MobileInvoice", entityId: inv.id, actorUserId: user.sub, metadata: { number: inv.number } });
    return reply.send({ ok: true, status: updated.status });
  });

  // ── Admin: usage analytics / webhooks / compliance / audit ────────────────

  app.get("/admin/mobile-service/usage-analytics", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const start = cycleStart();
    const records = await db.mobileUsageRecord.findMany({
      where: { recordedAt: { gte: start } },
      select: { recordedAt: true, kind: true, quantity: true, tenantId: true, lineId: true },
      orderBy: { recordedAt: "asc" }, take: 50000,
    });
    const daily = rollupDaily(records);
    const byTenant = new Map<string, number>();
    for (const r of records) {
      if (r.kind === "data" && r.tenantId) byTenant.set(r.tenantId, (byTenant.get(r.tenantId) ?? 0) + Number(r.quantity || 0));
    }
    const tenants = await db.tenant.findMany({ where: { id: { in: [...byTenant.keys()] } }, select: { id: true, name: true } });
    const names = new Map(tenants.map((t: any) => [t.id, t.name]));
    // Overage risk: from the per-tenant recount's data
    const activeLines = await db.mobileLine.findMany({ where: { status: "active" }, include: { plan: true, tenant: { select: { name: true } } } });
    const now = new Date();
    const end = cycleEnd();
    const byLine = new Map<string, number>();
    for (const r of records) if (r.kind === "data" && r.lineId) byLine.set(r.lineId, (byLine.get(r.lineId) ?? 0) + Number(r.quantity || 0));
    const risk = activeLines
      .map((l: any) => {
        const used = byLine.get(l.id) ?? 0;
        const included = l.plan?.includedDataMb ?? null;
        if (!included || included <= 0) return null;
        const projected = projectCycleDataMb(used, start, end, now);
        if (projected <= included) return null;
        const shape = planShape(l.plan)!;
        const over = computeDataOverageCents(shape, projected);
        return { lineId: l.id, phoneNumber: l.phoneNumber, label: l.label, tenantName: l.tenant?.name ?? null, usedMb: Math.round(used), includedMb: included, projectedMb: projected, projectedOverageCents: over.overageCents, behavior: l.plan.dataOverageBehavior };
      })
      .filter(Boolean);
    return reply.send({
      cycle: { start: start.toISOString() },
      daily,
      byTenant: [...byTenant.entries()].map(([tenantId, dataMb]) => ({ tenantId, name: names.get(tenantId) ?? tenantId, dataMb: Math.round(dataMb) })).sort((a, b) => b.dataMb - a.dataMb),
      overageRisk: risk,
    });
  });

  app.get("/admin/mobile-service/webhook-events/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const row = await db.mobileWebhookEvent.findUnique({ where: { id: String(req.params.id) } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.send({ event: row });
  });

  app.get("/admin/mobile-service/compliance", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const lines = await db.mobileLine.findMany({ where: { status: { not: "terminated" } }, select: { id: true, tenantId: true, e911Status: true, createdAt: true, tenant: { select: { name: true } } } });
    const byTenant = new Map<string, { tenantId: string; name: string; lines: number; missing: number; oldest: Date | null }>();
    for (const l of lines) {
      const slot = byTenant.get(l.tenantId) ?? { tenantId: l.tenantId, name: (l as any).tenant?.name ?? l.tenantId, lines: 0, missing: 0, oldest: null };
      slot.lines += 1;
      if (l.e911Status !== "on_file") {
        slot.missing += 1;
        if (!slot.oldest || l.createdAt < slot.oldest) slot.oldest = l.createdAt;
      }
      byTenant.set(l.tenantId, slot);
    }
    const secretReads = await db.auditLog.findMany({
      where: { action: "mobile.esim.code_viewed" },
      orderBy: { createdAt: "desc" }, take: 40,
      select: { tenantId: true, entityId: true, createdAt: true, actorUser: { select: { email: true } }, tenant: { select: { name: true } } },
    });
    const audit = await db.auditLog.findMany({
      where: { action: { startsWith: "mobile." } },
      orderBy: { createdAt: "desc" }, take: 60,
      select: { action: true, entityType: true, entityId: true, createdAt: true, tenant: { select: { name: true } }, actorUser: { select: { email: true } } },
    });
    return reply.send({
      e911: {
        totalLines: lines.length,
        covered: lines.filter((l: any) => l.e911Status === "on_file").length,
        byTenant: [...byTenant.values()].filter((t) => t.missing > 0).sort((a, b) => b.missing - a.missing),
      },
      secretReads,
      audit,
    });
  });

  app.get("/admin/mobile-service/audit", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const rows = await db.auditLog.findMany({
      where: { action: { startsWith: "mobile." } },
      orderBy: { createdAt: "desc" }, take: 200,
      select: { action: true, entityType: true, entityId: true, createdAt: true, metadata: true, tenant: { select: { name: true } }, actorUser: { select: { email: true } } },
    });
    return reply.send({ audit: rows });
  });
}
