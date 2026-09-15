/**
 * LoopCom Mobile routes.
 *
 * Two surfaces, two gates:
 *  - `/mobile-service/*` — tenant self-service. Auth rides the platform JWT
 *    preHandler; every query is scoped to `req.user.tenantId` (never a
 *    tenant id from the body), and the prefix carries the
 *    `can_view_workspace_mobile` rule in PORTAL_API_PERMISSION_RULES.
 *  - `/admin/mobile-service/*` — the provider console, requireOwner
 *    (SUPER_ADMIN) on every route + the `can_manage_global_settings` prefix
 *    rule, exactly like the Telnyx bench.
 *
 * ⛔ The path is /mobile-service, NOT /mobile — /mobile/* and /admin/mobile/*
 * already belong to the phone-app device routes in server.ts, and a prefix
 * rule on them would have gated existing endpoints (traced 2026-09-15).
 *
 * Money rules: the ONLY routes that can cost money are the owner-gated
 * provisioning routes, each demands `confirm: true`, states what it buys, is
 * audited, and is NEVER retried. Tenant routes can never spend anything.
 * Secrets: eSIM activation codes are returned only to the owning tenant (or
 * the owner), never logged, and the Telnyx API key never leaves the server.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { TelnyxError } from "../telnyx/telnyxClient";
import {
  getSimDeviceDetails,
  listMobilePhoneNumbers,
  listSimCardOrders,
  listSimCards,
} from "./telnyxWirelessClient";
import { getMobileCapabilityReport, clearCapabilityCache } from "./mobileCapabilities";
import {
  provisionEsimForLine,
  readActivationCode,
  resumeLine,
  suspendLine,
} from "./mobileService";
import { runMobileStateReconcileCycle, runMobileUsageSyncCycle } from "./mobileSyncJobs";
import { buildMobileBillingLineItems, computeUsageTotals, type MobilePlanShape } from "./mobilePlanMath";
import { writeMobileAuditSync } from "./mobileAudit";
import { memberMay } from "./mobileProductRoutes";
import { planChangedEmail, queueMobileEmail, resolveMobileRecipients, welcomeEmail } from "./mobileEmails";

export interface MobileRouteDeps {
  app: any;
  db: any;
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
}

/** Platform-level (no-tenant) console audit, same ledger as the Telnyx bench. */
export async function recordMobileEvent(db: any, event: string, payload: Record<string, unknown>, actor = "owner"): Promise<void> {
  const body = { actor, event: `mobile.${event}`, ts: new Date().toISOString(), payload };
  try {
    await db.agentAuditLog.create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload as any,
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    });
  } catch {
    /* the record must never fail the action it records */
  }
}

function sendFailure(reply: any, err: unknown, fallback: string): void {
  if (err instanceof TelnyxError) {
    reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({ error: err.code, message: err.userMessage });
    return;
  }
  reply.code(500).send({ error: "internal", message: fallback });
}

const PLAN_PUBLIC_SELECT = {
  id: true, name: true, description: true, active: true, monthlyPriceCents: true,
  activationFeeCents: true, simFeeCents: true, esimFeeCents: true, includedDataMb: true,
  includedVoiceMinutes: true, includedSms: true, dataOverageBehavior: true,
  dataOverageCentsPerGb: true, roamingEnabled: true, sortOrder: true,
} as const;

const planBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullish(),
  active: z.boolean().optional(),
  monthlyPriceCents: z.number().int().min(0),
  activationFeeCents: z.number().int().min(0).optional(),
  simFeeCents: z.number().int().min(0).optional(),
  esimFeeCents: z.number().int().min(0).optional(),
  includedDataMb: z.number().int().min(0).nullish(),
  includedVoiceMinutes: z.number().int().min(0).nullish(),
  includedSms: z.number().int().min(0).nullish(),
  dataOverageBehavior: z.enum(["block", "charge"]).optional(),
  dataOverageCentsPerGb: z.number().int().min(0).optional(),
  roamingEnabled: z.boolean().optional(),
  telnyxCostCentsEstimate: z.number().int().min(0).optional(),
  sortOrder: z.number().int().optional(),
});

function lineSummary(line: any): any {
  return {
    id: line.id,
    tenantId: line.tenantId,
    label: line.label,
    status: line.status,
    phoneNumber: line.phoneNumber,
    plan: line.plan ? { id: line.plan.id, name: line.plan.name, monthlyPriceCents: line.plan.monthlyPriceCents, includedDataMb: line.plan.includedDataMb } : null,
    sim: line.sim ? {
      id: line.sim.id,
      type: line.sim.type,
      status: line.sim.status,
      iccid: line.sim.iccid,
      esimInstallationStatus: line.sim.esimInstallationStatus,
      voiceEnabled: line.sim.voiceEnabled,
      hasActivationCode: Boolean(line.sim.activationCodeEnc),
      lastSyncAt: line.sim.lastSyncAt,
    } : null,
    activatedAt: line.activatedAt,
    suspendedAt: line.suspendedAt,
    suspendReason: line.suspendReason,
    needsReconcile: line.needsReconcile,
    reconcileReason: line.reconcileReason,
    createdAt: line.createdAt,
  };
}

function cycleStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function registerLoopcomMobileRoutes(deps: MobileRouteDeps): void {
  const { app, db, requireOwner } = deps;

  const tenantUser = (req: any, reply: any): { sub: string; tenantId: string } | null => {
    const u = req.user as { sub?: string; tenantId?: string } | undefined;
    if (!u?.tenantId || !u?.sub) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return { sub: u.sub, tenantId: u.tenantId };
  };

  const requireCreds = async (reply: any) => {
    const creds = await resolveTelnyxCredentials(db);
    if (!creds) {
      reply.code(409).send({ error: "not_configured", message: "LoopCom Mobile is not connected to the carrier yet." });
      return null;
    }
    return creds;
  };

  // ── Tenant self-service ────────────────────────────────────────────────────

  app.get("/mobile-service/overview", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const [lines, usage] = await Promise.all([
      db.mobileLine.findMany({ where: { tenantId: u.tenantId }, include: { plan: true, sim: true }, orderBy: { createdAt: "asc" } }),
      db.mobileUsageRecord.findMany({
        where: { tenantId: u.tenantId, recordedAt: { gte: cycleStart() } },
        select: { kind: true, quantity: true, lineId: true },
      }),
    ]);
    const totals = computeUsageTotals(usage);
    const byLine: Record<string, { dataMb: number }> = {};
    for (const r of usage) {
      if (!r.lineId || r.kind !== "data") continue;
      byLine[r.lineId] = { dataMb: (byLine[r.lineId]?.dataMb ?? 0) + Number(r.quantity || 0) };
    }
    return reply.send({
      lines: lines.map(lineSummary),
      cycle: { start: cycleStart().toISOString(), totals, byLine },
    });
  });

  app.get("/mobile-service/plans", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    // Customer-facing: never expose telnyxCostCentsEstimate (the margin).
    const plans = await db.mobilePlan.findMany({ where: { active: true }, select: PLAN_PUBLIC_SELECT, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    return reply.send({ plans });
  });

  app.get("/mobile-service/lines/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const line = await db.mobileLine.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId }, include: { plan: true, sim: true } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    const usage = await db.mobileUsageRecord.findMany({
      where: { lineId: line.id, recordedAt: { gte: cycleStart() } },
      orderBy: { recordedAt: "desc" },
      take: 200,
      select: { recordedAt: true, kind: true, quantity: true },
    });
    return reply.send({ line: lineSummary(line), usage, totals: computeUsageTotals(usage) });
  });

  /** The eSIM install screen: QR contents + instructions. Owner-of-line only; the read is audited. */
  app.get("/mobile-service/lines/:id/esim", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const line = await db.mobileLine.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId }, include: { sim: true } });
    if (!line?.sim) return reply.code(404).send({ error: "no_sim" });
    if (line.sim.type !== "esim") return reply.code(409).send({ error: "not_an_esim" });
    const code = await readActivationCode(db, line.sim.id);
    if (!code) return reply.code(409).send({ error: "no_activation_code", message: "This eSIM has no retrievable activation code (it may already be installed)." });
    await writeMobileAuditSync({
      tenantId: u.tenantId,
      action: "mobile.esim.code_viewed",
      entityType: "MobileSim",
      entityId: line.sim.id,
      actorUserId: u.sub,
    });
    return reply.send({
      activationCode: code,
      installationStatus: line.sim.esimInstallationStatus,
      instructions: [
        "On the phone: Settings > Cellular (or Mobile Network) > Add eSIM.",
        "Scan this QR code, or choose 'Enter details manually' and paste the activation code.",
        "Keep Wi-Fi on during installation; the line activates within a few minutes of install.",
      ],
    });
  });

  const suspendBody = z.object({ reason: z.string().min(1).max(300) });
  app.post("/mobile-service/lines/:id/suspend", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = suspendBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (!(await memberMay(db, req.user, "memberCanPause"))) {
      return reply.code(403).send({ error: "member_not_allowed", message: "Pausing lines is limited to managers on this account." });
    }
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const out = await suspendLine(db, creds, { lineId: String(req.params.id), tenantId: u.tenantId, reason: body.data.reason, actorUserId: u.sub });
      if (!out.ok) return reply.code(out.error === "line_not_found" ? 404 : 409).send({ error: out.error });
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't suspend the line.");
    }
  });

  app.post("/mobile-service/lines/:id/resume", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const out = await resumeLine(db, creds, { lineId: String(req.params.id), tenantId: u.tenantId, actorUserId: u.sub });
      if (!out.ok) return reply.code(out.error === "line_not_found" ? 404 : 409).send({ error: out.error });
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't resume the line.");
    }
  });

  app.post("/mobile-service/lines/:id/report-lost", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!(await memberMay(db, req.user, "memberCanReportLost"))) {
      return reply.code(403).send({ error: "member_not_allowed", message: "Reporting a device lost is limited to managers on this account." });
    }
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const out = await suspendLine(db, creds, {
        lineId: String(req.params.id), tenantId: u.tenantId, lost: true,
        reason: String((req.body as any)?.reason ?? "reported lost or stolen").slice(0, 300),
        actorUserId: u.sub,
      });
      if (!out.ok) return reply.code(out.error === "line_not_found" ? 404 : 409).send({ error: out.error });
      return reply.send({ ok: true, message: "Service is suspended and the number is preserved. Support will arrange a replacement eSIM/SIM." });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't report the line lost.");
    }
  });

  const portBody = z.object({
    phoneNumber: z.string().regex(/^\+?1?\d{10}$/, "Enter a 10-digit US/Canada mobile number."),
  });
  /** DRAFT only — nothing is filed with the carrier from this route, ever. */
  app.post("/mobile-service/port-requests", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = portBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (!(await memberMay(db, req.user, "memberCanPort"))) {
      return reply.code(403).send({ error: "member_not_allowed", message: "Starting a number transfer is limited to managers on this account." });
    }
    const digits = body.data.phoneNumber.replace(/\D/g, "").slice(-10);
    const row = await db.mobilePortRequest.create({
      data: { tenantId: u.tenantId, phoneNumber: `+1${digits}`, status: "draft", createdByUserId: u.sub },
    });
    await writeMobileAuditSync({ tenantId: u.tenantId, action: "mobile.port.draft_created", entityType: "MobilePortRequest", entityId: row.id, actorUserId: u.sub });
    return reply.send({ id: row.id, status: row.status, message: "Port request saved as a draft. LoopCom will confirm the details (account number + transfer PIN from your current carrier) before anything is filed." });
  });

  app.get("/mobile-service/port-requests", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const rows = await db.mobilePortRequest.findMany({ where: { tenantId: u.tenantId }, orderBy: { createdAt: "desc" }, take: 50 });
    return reply.send({ portRequests: rows.map((r: any) => ({ id: r.id, phoneNumber: r.phoneNumber, status: r.status, carrier: r.carrier, focDate: r.focDate, createdAt: r.createdAt })) });
  });

  // ── Admin console (owner only) ─────────────────────────────────────────────

  app.get("/admin/mobile-service/status", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await resolveTelnyxCredentials(db);
    const [report, lineCount, simCount, planCount, pendingEvents] = await Promise.all([
      getMobileCapabilityReport(creds),
      db.mobileLine.count(),
      db.mobileSim.count(),
      db.mobilePlan.count(),
      db.mobileWebhookEvent.count({ where: { status: { in: ["received", "failed"] } } }),
    ]);
    return reply.send({ report, counts: { lines: lineCount, sims: simCount, plans: planCount, pendingWebhookEvents: pendingEvents } });
  });

  app.post("/admin/mobile-service/capabilities/refresh", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    clearCapabilityCache();
    const creds = await resolveTelnyxCredentials(db);
    const report = await getMobileCapabilityReport(creds, { force: true });
    return reply.send({ report });
  });

  app.get("/admin/mobile-service/plans", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const plans = await db.mobilePlan.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    return reply.send({ plans });
  });

  app.post("/admin/mobile-service/plans", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = planBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const plan = await db.mobilePlan.create({ data: body.data as any });
    await recordMobileEvent(db, "plan_created", { planId: plan.id, name: plan.name }, `user:${user.sub}`);
    return reply.send({ plan });
  });

  app.patch("/admin/mobile-service/plans/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = planBody.partial().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    try {
      const plan = await db.mobilePlan.update({ where: { id: String(req.params.id) }, data: body.data as any });
      await recordMobileEvent(db, "plan_updated", { planId: plan.id, fields: Object.keys(body.data) }, `user:${user.sub}`);
      return reply.send({ plan });
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  app.get("/admin/mobile-service/lines", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const q = String((req.query as any)?.q ?? "").trim();
    const where: any = q
      ? {
          OR: [
            { phoneNumber: { contains: q } },
            { label: { contains: q, mode: "insensitive" } },
            { sim: { iccid: { contains: q } } },
            { sim: { telnyxSimId: { contains: q } } },
            { tenant: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {};
    const lines = await db.mobileLine.findMany({ where, include: { plan: true, sim: true, tenant: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
    return reply.send({ lines: lines.map((l: any) => ({ ...lineSummary(l), tenantName: l.tenant?.name ?? null })) });
  });

  const createLineBody = z.object({
    tenantId: z.string().min(1),
    label: z.string().min(1).max(80),
    planId: z.string().min(1).nullish(),
  });
  app.post("/admin/mobile-service/lines", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = createLineBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const tenant = await db.tenant.findUnique({ where: { id: body.data.tenantId }, select: { id: true, name: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });
    if (body.data.planId) {
      const plan = await db.mobilePlan.findUnique({ where: { id: body.data.planId } });
      if (!plan) return reply.code(404).send({ error: "plan_not_found" });
    }
    const line = await db.mobileLine.create({
      data: { tenantId: tenant.id, label: body.data.label, planId: body.data.planId ?? null, status: "draft", createdByUserId: user.sub },
      include: { plan: true, sim: true },
    });
    await writeMobileAuditSync({ tenantId: tenant.id, action: "mobile.line.created", entityType: "MobileLine", entityId: line.id, actorUserId: user.sub, metadata: { label: line.label } });
    // Welcome email — ONCE per tenant, at their first-ever line. The
    // once-guard is the send's own audit row (mobile.email.welcome), so a
    // second line can never re-welcome; a first line with no reachable
    // recipient audits "welcome_skipped" and the next line retries.
    try {
      const [lineCount, alreadyWelcomed] = await Promise.all([
        db.mobileLine.count({ where: { tenantId: tenant.id } }),
        db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "mobile.email.welcome" }, select: { id: true } }),
      ]);
      if (lineCount === 1 && !alreadyWelcomed) {
        const to = await resolveMobileRecipients(db, tenant.id, null);
        if (to.length) {
          await queueMobileEmail(db, {
            tenantId: tenant.id, kind: "welcome",
            email: welcomeEmail({ tenantName: tenant.name, firstLineLabel: line.label }),
            to, entityType: "MobileLine", entityId: line.id,
          });
        }
      }
    } catch {
      /* the welcome must never fail line creation */
    }
    return reply.send({ line: lineSummary(line) });
  });

  /**
   * ⛔ REAL MONEY: buys ONE eSIM on the platform's Telnyx account (Telnyx
   * bills per eSIM + monthly SIM fee). Demands confirm:true. Never retried —
   * a timeout answers "unknown"; the reconcile pass recovers any orphan.
   */
  const provisionBody = z.object({ confirm: z.literal(true), whitelabel: z.boolean().optional() });
  app.post("/admin/mobile-service/lines/:id/provision-esim", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = provisionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "confirm_required", message: "This purchases an eSIM on the Telnyx account. Send confirm:true to proceed." });
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const out = await provisionEsimForLine(db, creds, { lineId: String(req.params.id), actorUserId: user.sub, whitelabel: body.data.whitelabel !== false });
      await recordMobileEvent(db, out.ok ? "esim_provisioned" : "esim_provision_failed", { lineId: String(req.params.id), result: out }, `user:${user.sub}`);
      if (!out.ok) return reply.code(409).send({ error: out.error });
      return reply.send({ ok: true, simRowId: out.simRowId });
    } catch (err) {
      await recordMobileEvent(db, "esim_provision_failed", { lineId: String(req.params.id), error: err instanceof TelnyxError ? err.code : "unknown" }, `user:${user.sub}`);
      if (err instanceof TelnyxError && err.code === "timeout") {
        return reply.code(504).send({ error: "unknown_outcome", message: "Telnyx didn't answer. The eSIM MAY have been purchased — run reconcile before trying again; do not re-click." });
      }
      return sendFailure(reply, err, "Couldn't provision the eSIM.");
    }
  });

  const adminSuspendBody = z.object({ reason: z.string().min(1).max(300), lost: z.boolean().optional() });
  app.post("/admin/mobile-service/lines/:id/suspend", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = adminSuspendBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const out = await suspendLine(db, creds, { lineId: String(req.params.id), reason: body.data.reason, lost: body.data.lost, actorUserId: user.sub });
      if (!out.ok) return reply.code(out.error === "line_not_found" ? 404 : 409).send({ error: out.error });
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't suspend the line.");
    }
  });

  app.post("/admin/mobile-service/lines/:id/resume", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const out = await resumeLine(db, creds, { lineId: String(req.params.id), actorUserId: user.sub });
      if (!out.ok) return reply.code(out.error === "line_not_found" ? 404 : 409).send({ error: out.error });
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't resume the line.");
    }
  });

  const terminateBody = z.object({ confirm: z.literal(true), reason: z.string().min(1).max(300) });
  app.post("/admin/mobile-service/lines/:id/terminate", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = terminateBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "confirm_required", message: "Termination ends service on this line. Send confirm:true with a reason." });
    const creds = await requireCreds(reply);
    if (!creds) return;
    const line = await db.mobileLine.findUnique({ where: { id: String(req.params.id) }, include: { sim: true } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    try {
      if (line.sim?.telnyxSimId && line.sim.status === "enabled") {
        const { disableSim } = await import("./telnyxWirelessClient");
        await disableSim(creds, line.sim.telnyxSimId);
      }
      await db.mobileLine.update({ where: { id: line.id }, data: { status: "terminated", terminatedAt: new Date(), suspendReason: body.data.reason } });
      await writeMobileAuditSync({ tenantId: line.tenantId, action: "mobile.line.terminate", entityType: "MobileLine", entityId: line.id, actorUserId: user.sub, metadata: { reason: body.data.reason } });
      return reply.send({ ok: true, note: "The SIM was disabled and the line marked terminated. The Telnyx SIM record was NOT deleted (deleting is unrecoverable — do it from the Telnyx portal when certain)." });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't terminate the line.");
    }
  });

  const changePlanBody = z.object({ planId: z.string().min(1) });
  app.post("/admin/mobile-service/lines/:id/change-plan", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = changePlanBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const plan = await db.mobilePlan.findUnique({ where: { id: body.data.planId } });
    if (!plan) return reply.code(404).send({ error: "plan_not_found" });
    try {
      const line = await db.mobileLine.update({ where: { id: String(req.params.id) }, data: { planId: plan.id }, include: { plan: true, sim: true, subscriber: true } });
      await writeMobileAuditSync({ tenantId: line.tenantId, action: "mobile.line.plan_changed", entityType: "MobileLine", entityId: line.id, actorUserId: user.sub, metadata: { planId: plan.id, planName: plan.name } });
      const to = await resolveMobileRecipients(db, line.tenantId, line.subscriber?.notifyEmail ? line.subscriber?.email : null);
      if (to.length) {
        await queueMobileEmail(db, { tenantId: line.tenantId, kind: "plan_changed", email: planChangedEmail({ lineLabel: line.label, phoneNumber: line.phoneNumber, planName: plan.name, monthlyPriceCents: plan.monthlyPriceCents }), to, entityType: "MobileLine", entityId: line.id });
      }
      return reply.send({ line: lineSummary(line) });
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  app.get("/admin/mobile-service/sims", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const sims = await db.mobileSim.findMany({ include: { line: { select: { id: true, label: true, tenantId: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
    return reply.send({
      sims: sims.map((s: any) => ({
        id: s.id, telnyxSimId: s.telnyxSimId, iccid: s.iccid, type: s.type, status: s.status,
        esimInstallationStatus: s.esimInstallationStatus, voiceEnabled: s.voiceEnabled,
        msisdn: s.msisdn, tenantId: s.tenantId, line: s.line, lastSyncAt: s.lastSyncAt,
        hasActivationCode: Boolean(s.activationCodeEnc),
      })),
    });
  });

  app.post("/admin/mobile-service/reconcile", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    try {
      const out = await runMobileStateReconcileCycle(db);
      await recordMobileEvent(db, "reconcile_run", out as any, `user:${user.sub}`);
      return reply.send(out);
    } catch (err) {
      return sendFailure(reply, err, "Reconcile failed.");
    }
  });

  app.post("/admin/mobile-service/usage-sync", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    try {
      const out = await runMobileUsageSyncCycle(db);
      return reply.send(out);
    } catch (err) {
      return sendFailure(reply, err, "Usage sync failed.");
    }
  });

  app.get("/admin/mobile-service/webhook-events", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const rows = await db.mobileWebhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 100 });
    return reply.send({ events: rows.map((r: any) => ({ id: r.id, eventType: r.eventType, status: r.status, error: r.error, telnyxSimId: r.telnyxSimId, receivedAt: r.receivedAt, processedAt: r.processedAt })) });
  });

  /** Read-only "Run Mobile Diagnostics" for one line. */
  app.get("/admin/mobile-service/diagnostics/:lineId", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const line = await db.mobileLine.findUnique({ where: { id: String(req.params.lineId) }, include: { plan: true, sim: true, tenant: { select: { id: true, name: true } } } });
    if (!line) return reply.code(404).send({ error: "not_found" });
    const creds = await resolveTelnyxCredentials(db);
    const report: any = {
      line: lineSummary(line),
      tenant: line.tenant,
      provider: null as any,
      device: null as any,
      lastUsage: null as any,
      lastWebhook: null as any,
      findings: [] as string[],
    };
    if (line.sim?.telnyxSimId && creds) {
      try {
        const sims = await listSimCards(creds, { pageSize: 250 });
        report.provider = sims.find((s) => s.id === line.sim.telnyxSimId) ?? null;
        if (!report.provider) report.findings.push("The SIM exists locally but Telnyx no longer lists it — it may have been deleted on the provider side.");
        else if (report.provider.status !== line.sim.status) report.findings.push(`Provider status (${report.provider.status}) differs from the local mirror (${line.sim.status}) — run reconcile.`);
      } catch (err: any) {
        report.findings.push(`Couldn't read the provider SIM state: ${err instanceof TelnyxError ? err.userMessage : "error"}`);
      }
      try {
        report.device = await getSimDeviceDetails(creds, line.sim.telnyxSimId);
      } catch {
        report.device = null;
      }
    }
    report.lastUsage = await db.mobileUsageRecord.findFirst({ where: { lineId: line.id }, orderBy: { recordedAt: "desc" }, select: { recordedAt: true, kind: true, quantity: true } });
    report.lastWebhook = line.sim?.telnyxSimId
      ? await db.mobileWebhookEvent.findFirst({ where: { telnyxSimId: line.sim.telnyxSimId }, orderBy: { receivedAt: "desc" }, select: { eventType: true, status: true, receivedAt: true } })
      : null;
    if (!line.sim) report.findings.push("The line has no SIM attached.");
    if (line.status === "pending_activation" && line.sim?.esimInstallationStatus === "released") report.findings.push("The eSIM is purchased but not yet installed on a device — the customer needs the QR screen.");
    if (line.needsReconcile) report.findings.push(`Line is flagged for reconciliation: ${line.reconcileReason ?? "no reason recorded"}.`);
    if (report.findings.length === 0) report.findings.push("No problems found.");
    return reply.send(report);
  });

  /** Read-only billing recount preview for one tenant + the current month. */
  app.get("/admin/mobile-service/billing-preview/:tenantId", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const tenantId = String(req.params.tenantId);
    const start = cycleStart();
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const lines = await db.mobileLine.findMany({ where: { tenantId }, include: { plan: true } });
    const inputs = [] as any[];
    for (const line of lines) {
      const usage = await db.mobileUsageRecord.aggregate({ _sum: { quantity: true }, where: { lineId: line.id, kind: "data", recordedAt: { gte: start, lt: end } } });
      inputs.push({
        lineId: line.id,
        label: line.label,
        status: line.status,
        plan: line.plan as MobilePlanShape | null,
        activatedAt: line.activatedAt,
        terminatedAt: line.terminatedAt,
        usedDataMb: Number(usage?._sum?.quantity ?? 0),
      });
    }
    const items = buildMobileBillingLineItems(inputs, { start, end });
    const totalCents = items.reduce((s, i) => s + i.amountCents, 0);
    return reply.send({ period: { start, end }, items, totalCents, note: "Recount preview only — not wired into live invoices yet." });
  });

  /** Provider-side listings for the console (read-only). */
  app.get("/admin/mobile-service/provider/sim-orders", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ orders: await listSimCardOrders(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list SIM orders.");
    }
  });

  app.get("/admin/mobile-service/provider/mobile-numbers", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const numbers = await listMobilePhoneNumbers(creds);
      return reply.send({ numbers: numbers.map((n) => ({ id: n.id, phoneNumber: n.phoneNumber, simCardId: n.simCardId, status: n.status, mobileVoiceEnabled: n.mobileVoiceEnabled })) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list mobile phone numbers.");
    }
  });
}
