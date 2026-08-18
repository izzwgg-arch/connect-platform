/**
 * Boot wiring for the overdue-account service interruption: the daily sweep
 * timer and the admin routes. Everything server.ts needs, behind two calls.
 *
 * ⛔ THE SWEEP IS INERT UNTIL `SERVICE_INTERRUPTION_CUTOVER_AT` IS SET — see
 * serviceInterruptionJob.ts. Deploying this with the variable unset is the
 * safe state: nothing runs, nothing is cut off.
 *
 * ⛔ Every panel step here goes through the onboarding account pool
 * (`acquireAccount` / `releaseAccount`). Two concurrent panel sessions on one
 * robot account is how the orchestrator's builds used to trample each other.
 */

import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { PanelSession, loadPanelConfig } from "../../onboarding/panelClient";
import { acquireAccount, releaseAccount } from "../../onboarding/setupOrchestrator";
import { rebakeConnectRoutesAfterRegen } from "../../pbx/applyRegenRebake";
import { canAccessPlatformAdminBillingRoutes } from "../billingAuth";
import { runServiceInterruptionSweep, serviceInterruptionCutover } from "./serviceInterruptionJob";
import { buildSweepDeps, type RunnerContext } from "./serviceInterruptionRunner";
import { readServiceInterruption, writeServiceInterruption, clearCountdown } from "./serviceInterruptionSettings";
import {
  SERVICE_INTERRUPTION_AUDIT,
  decideManualForce,
  decideManualRestore,
} from "./serviceInterruptionManualActions";
import { SERVICE_INTERRUPTION_GRACE_DAYS } from "./serviceInterruptionPolicy";
import type { ArsMemberRef } from "./serviceInterruptionPlan";

type Log = { info: (o: any, m: string) => void; warn: (o: any, m: string) => void; error: (o: any, m: string) => void };

/** Writes AstDB keys through the telephony service (server.ts's publishToAstDb). */
export type PublishAstDb = (
  tenantSlug: string,
  keys: Array<{ family: string; key: string; value: string }>,
) => Promise<void>;
/** server.ts's getIvrSlugForTenant — the ONE slug derivation the dialplan uses. */
export type TenantSlugResolver = (tenantId: string) => Promise<string>;
export type BootDeps = { publishAstDb: PublishAstDb; tenantSlug: TenantSlugResolver };

/** Once a day. A mistake here has a day of visibility, not an hour. */
export const SERVICE_INTERRUPTION_SWEEP_INTERVAL_MS = 24 * 3600_000;
/** First run shortly after boot, so a restart never delays a restore by a day. */
export const SERVICE_INTERRUPTION_FIRST_RUN_DELAY_MS = 5 * 60_000;

/** The Connect-mode PBX tenants whose doorways must be re-baked after any regen.
 *  Read live rather than hard-coded — this list changes as numbers move. */
async function connectModeLinks(): Promise<Array<{ tenantId: string; pbxTenantId: string }>> {
  const mappings: any[] = await (db as any).didRouteMapping
    .findMany({ where: { routingMode: "connect" }, select: { tenantId: true } })
    .catch(() => []);
  const tenantIds = [...new Set(mappings.map((m) => String(m.tenantId)).filter(Boolean))];
  if (tenantIds.length === 0) return [];
  const links: any[] = await (db as any).tenantPbxLink.findMany({
    where: { tenantId: { in: tenantIds }, pbxTenantId: { not: null } },
    select: { tenantId: true, pbxTenantId: true },
  });
  return links.map((l) => ({ tenantId: String(l.tenantId), pbxTenantId: String(l.pbxTenantId) }));
}

/** ombutel: the tenant's outbound profiles and their members. */
async function readArsMembersFromOmbutel(pbxTenantId: string): Promise<ArsMemberRef[]> {
  const inst: any = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst?.ombuMysqlUrlEncrypted) throw new Error("no PBX instance / ombuMysqlUrlEncrypted");
  const parsed: any = decryptJson(String(inst.ombuMysqlUrlEncrypted).trim());
  const url = String(parsed.mysqlUrl || parsed.url || "").trim();
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(url);
  try {
    // ⛔ ombu_tenant_settings.outbound_profiles -> ombu_ars.ars_id. NOT
    // ombu_ars.tenant_id, which is 1 for every real row.
    const [prof]: any = await conn.query(
      "SELECT value FROM ombutel.ombu_tenant_settings WHERE tenant_id = ? AND name = 'outbound_profiles'",
      [pbxTenantId],
    );
    const arsIds = String(prof?.[0]?.value ?? "")
      .split(",")
      .map((x: string) => x.trim())
      .filter(Boolean);
    if (arsIds.length === 0) return [];
    const [rows]: any = await conn.query(
      `SELECT ars_id, outbound_route_id, enabled, sort FROM ombutel.ombu_ars_members WHERE ars_id IN (${arsIds.map(() => "?").join(",")})`,
      arsIds,
    );
    return rows.map((r: any) => ({
      arsId: String(r.ars_id),
      outboundRouteId: String(r.outbound_route_id),
      enabled: String(r.enabled) === "yes",
      sort: Number(r.sort ?? 0),
    }));
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Does this tenant have any number on the Connect doorway (where busy is enforced)? */
async function hasConnectModeNumber(tenantId: string): Promise<boolean> {
  const m: any = await (db as any).didRouteMapping
    .findFirst({ where: { tenantId, routingMode: "connect" }, select: { id: true } })
    .catch(() => null);
  return Boolean(m);
}

/** Build the live runner context. */
export function buildRunnerContext(log: Log, boot: BootDeps): RunnerContext & {
  setInterruptedFlag: (tenantId: string, on: boolean) => Promise<void>;
} {
  const cfg = loadPanelConfig(process.env);

  return {
    db,
    log,
    async panel() {
      if (!cfg) throw new Error("panel config missing — cannot reach the PBX");
      const account = await acquireAccount(cfg);
      try {
        const session = await new PanelSession(cfg.baseUrl, account).login();
        return { session, mainTenantPath: cfg.mainTenant, release: () => releaseAccount(account) };
      } catch (e) {
        releaseAccount(account);
        throw e;
      }
    },
    readArsMembers: readArsMembersFromOmbutel,
    async rebakeDoorways() {
      const inst: any = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true } }).catch(() => null);
      for (const l of await connectModeLinks()) {
        await rebakeConnectRoutesAfterRegen(l.tenantId, {
          db,
          log,
          pbxTenantId: l.pbxTenantId,
          pbxInstanceId: inst?.id ?? null,
        }).catch((e: any) => log.warn({ tenantId: l.tenantId, err: e?.message }, "[SERVICE_INTERRUPTION] doorway re-bake failed"));
      }
    },
    /**
     * The inbound half: callers to a Connect-mode number hear BUSY while
     * `connect/t_<slug>/interrupted` is "yes". Read by the doorway at call
     * time, so this needs no regen. ⛔ Only reaches numbers on the Connect
     * doorway; a number still routed by VitalPBX itself does not pass through
     * here and keeps ringing — recorded as an open gap.
     */
    async setInterruptedFlag(tenantId: string, on: boolean) {
      const slug = await boot.tenantSlug(tenantId);
      if (!(await hasConnectModeNumber(tenantId))) {
        // Set anyway (harmless, and correct the moment a number is switched to
        // Connect) — but say so, because callers to a VitalPBX-routed number
        // will still get through.
        log.warn({ tenantId, slug }, "[SERVICE_INTERRUPTION] no Connect-mode number — inbound callers will NOT hear busy");
      }
      await boot.publishAstDb(slug, [{ family: `connect/t_${slug}`, key: "interrupted", value: on ? "yes" : "" }]);
    },
  };
}

/** Wire the daily sweep. Returns the timer so the caller can register it for shutdown. */
export function startServiceInterruptionSweep(log: Log, boot: BootDeps): NodeJS.Timeout {
  const ctx = buildRunnerContext(log, boot);
  const base = buildSweepDeps(ctx);
  // Wrap interrupt/restore so the inbound flag follows the outbound cutoff.
  const deps = {
    ...base,
    async interrupt(p: { tenantId: string; invoiceId: string }) {
      const r = await base.interrupt(p);
      await ctx.setInterruptedFlag(p.tenantId, true).catch((e: any) =>
        log.warn({ tenantId: p.tenantId, err: e?.message }, "[SERVICE_INTERRUPTION] inbound flag set failed"),
      );
      return r;
    },
    async restore(p: { tenantId: string; members: Array<{ arsId: string; outboundRouteId: string }> }) {
      // ⛔ Inbound first: if the outbound restore then fails, at least callers
      // can reach them again.
      await ctx.setInterruptedFlag(p.tenantId, false).catch((e: any) =>
        log.warn({ tenantId: p.tenantId, err: e?.message }, "[SERVICE_INTERRUPTION] inbound flag clear failed"),
      );
      await base.restore(p);
    },
  };

  const run = () => {
    if (!serviceInterruptionCutover()) {
      log.info({}, "[SERVICE_INTERRUPTION] sweep skipped — SERVICE_INTERRUPTION_CUTOVER_AT not set (feature inert)");
      return;
    }
    runServiceInterruptionSweep(deps)
      .then((s) => log.info(s, "[SERVICE_INTERRUPTION] sweep complete"))
      .catch((e) => log.error({ err: e?.message || String(e) }, "[SERVICE_INTERRUPTION] sweep failed"));
  };
  const first = setTimeout(run, SERVICE_INTERRUPTION_FIRST_RUN_DELAY_MS) as unknown as NodeJS.Timeout;
  first.unref?.();
  const timer = setInterval(run, SERVICE_INTERRUPTION_SWEEP_INTERVAL_MS) as unknown as NodeJS.Timeout;
  timer.unref?.();
  log.info(
    { armed: Boolean(serviceInterruptionCutover()), cutoverAt: serviceInterruptionCutover()?.toISOString() ?? null },
    "[SERVICE_INTERRUPTION] sweep scheduled",
  );
  return timer;
}

// ─── Admin routes ────────────────────────────────────────────────────────────

const putSchema = z.object({
  enabled: z.boolean().optional(),
  graceDays: z.number().int().min(1).max(60).nullable().optional(),
});
const forceSchema = z.object({ reason: z.string().min(8).max(500) });

async function audit(tenantId: string, type: string, actor: any, metadata: Record<string, unknown>) {
  await (db as any).billingEventLog
    .create({
      data: {
        tenantId,
        type,
        message: String(actor?.email || actor?.sub || "unknown"),
        metadata: { ...metadata, actorId: actor?.sub ?? null, actorEmail: actor?.email ?? null },
      },
    })
    .catch(() => {});
}

/**
 * SUPER_ADMIN only — a customer's admin must not be able to restore
 * themselves, and must not see the switch at all.
 */
export function registerServiceInterruptionRoutes(app: any, log: Log, boot: BootDeps): void {
  const guard = (req: any, reply: any) => {
    if (!canAccessPlatformAdminBillingRoutes(req.user?.role)) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return req.user;
  };
  const settingsFor = async (tenantId: string) =>
    (db as any).tenantBillingSettings.findUnique({ where: { tenantId }, select: { tenantId: true, metadata: true } });

  app.get("/admin/billing/tenants/:tenantId/service-interruption", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const { tenantId } = req.params as { tenantId: string };
    const row = await settingsFor(tenantId);
    const s = readServiceInterruption(row?.metadata);
    return {
      ...s,
      effectiveGraceDays: s.graceDays ?? SERVICE_INTERRUPTION_GRACE_DAYS,
      interrupted: Boolean(s.interruptedAt) && !s.restoredAt,
      cutoverAt: serviceInterruptionCutover()?.toISOString() ?? null,
      armed: Boolean(serviceInterruptionCutover()),
    };
  });

  app.put("/admin/billing/tenants/:tenantId/service-interruption", async (req: any, reply: any) => {
    const u = guard(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const row = await settingsFor(tenantId);
    if (!row) return reply.code(404).send({ error: "no_billing_settings" });
    const patch: Record<string, unknown> = {};
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.graceDays !== undefined) patch.graceDays = parsed.data.graceDays;
    const metadata = writeServiceInterruption(row.metadata, patch);
    await (db as any).tenantBillingSettings.update({ where: { tenantId }, data: { metadata } });
    await audit(tenantId, SERVICE_INTERRUPTION_AUDIT.switchChanged, u, patch);
    return readServiceInterruption(metadata);
  });

  app.post("/admin/billing/tenants/:tenantId/service-interruption/restore", async (req: any, reply: any) => {
    const u = guard(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const row = await settingsFor(tenantId);
    if (!row) return reply.code(404).send({ error: "no_billing_settings" });
    const d = decideManualRestore(row.metadata);
    if (!d.ok) return reply.code(409).send({ error: "cannot_restore", detail: d.reason });

    const ctx = buildRunnerContext(log, boot);
    const deps = buildSweepDeps(ctx);
    await ctx.setInterruptedFlag(tenantId, false).catch(() => {});
    await deps.restore({ tenantId, members: d.membersToEnable });
    const metadata = clearCountdown(row.metadata, new Date());
    await (db as any).tenantBillingSettings.update({ where: { tenantId }, data: { metadata } });
    await audit(tenantId, SERVICE_INTERRUPTION_AUDIT.restored, u, { members: d.membersToEnable });
    return { ok: true, restored: d.membersToEnable.length };
  });

  app.post("/admin/billing/tenants/:tenantId/service-interruption/interrupt", async (req: any, reply: any) => {
    const u = guard(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const parsed = forceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "reason_required", detail: "a reason of at least 8 characters is required" });
    const row = await settingsFor(tenantId);
    if (!row) return reply.code(404).send({ error: "no_billing_settings" });
    const d = decideManualForce(row.metadata, { reason: parsed.data.reason });
    if (!d.ok) return reply.code(409).send({ error: "cannot_interrupt", detail: d.reason });

    const ctx = buildRunnerContext(log, boot);
    const deps = buildSweepDeps(ctx);
    const disabled = await deps.interrupt({ tenantId, invoiceId: readServiceInterruption(row.metadata).invoiceId ?? "manual" });
    await ctx.setInterruptedFlag(tenantId, true).catch(() => {});
    const metadata = writeServiceInterruption(row.metadata, {
      interruptedAt: new Date().toISOString(),
      restoredAt: null,
      disabledArsMembers: disabled,
    });
    await (db as any).tenantBillingSettings.update({ where: { tenantId }, data: { metadata } });
    await audit(tenantId, SERVICE_INTERRUPTION_AUDIT.forced, u, { reason: parsed.data.reason, members: disabled });
    return { ok: true, disabled: disabled.length };
  });
}
