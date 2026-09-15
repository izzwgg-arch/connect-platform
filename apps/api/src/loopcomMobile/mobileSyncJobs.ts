/**
 * LoopCom Mobile — background cycles. Registered in server.ts beside the
 * other sweeps (registerShutdownTimer + a primed boot run, the house
 * pattern), env-tunable, and every cycle is idempotent: usage rows dedupe on
 * (kind, providerRecordId), SIM mirroring is an upsert, reconciliation only
 * clears flags when the provider state matches.
 *
 * Nothing here runs at all until Telnyx credentials exist AND at least one
 * mobile row exists — a platform with zero mobile lines pays one cheap DB
 * count per cycle and nothing else (no Telnyx traffic, no noise).
 */

import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { listSimUsageRecords } from "./telnyxWirelessClient";
import { reconcileSimsWithTelnyx } from "./mobileService";
import { detectUsageSpike } from "./mobilePlanMath";
import { writeMobileAudit } from "./mobileAudit";

const DAY_MS = 86_400_000;

async function hasMobileFootprint(db: any): Promise<boolean> {
  const [lines, sims] = await Promise.all([db.mobileLine.count(), db.mobileSim.count()]);
  return lines > 0 || sims > 0;
}

/** Pull SIM usage detail records into MobileUsageRecord (dedup by provider record id). */
export async function runMobileUsageSyncCycle(db: any): Promise<{ ingested: number; skipped: boolean }> {
  if (!(await hasMobileFootprint(db))) return { ingested: 0, skipped: true };
  const creds = await resolveTelnyxCredentials(db);
  if (!creds) return { ingested: 0, skipped: true };

  // Look back 48h; dedupe makes overlap free.
  const since = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const records = await listSimUsageRecords(creds, { pageSize: 50, startedAtGte: since });
  let ingested = 0;
  for (const rec of records) {
    if (!rec.id || rec.dataMb == null) continue;
    const sim = rec.simCardId ? await db.mobileSim.findUnique({ where: { telnyxSimId: rec.simCardId }, include: { line: true } }) : null;
    try {
      await db.mobileUsageRecord.create({
        data: {
          tenantId: sim?.tenantId ?? null,
          lineId: sim?.line?.id ?? null,
          simId: sim?.id ?? null,
          telnyxSimId: rec.simCardId,
          recordedAt: rec.recordedAt ? new Date(rec.recordedAt) : new Date(),
          kind: "data",
          quantity: rec.dataMb,
          costCents: rec.cost ? Math.round(Number(rec.cost) * 100) || 0 : 0,
          source: "detail_record",
          providerRecordId: rec.id,
          raw: rec.raw ?? undefined,
        },
      });
      ingested += 1;
    } catch (err: any) {
      // P2002 = already ingested (the dedupe doing its job). Anything else is
      // worth a log line but must not stop the sweep.
      if (err?.code !== "P2002") {
        console.error("mobile usage ingest failed", String(err?.message || err).slice(0, 160));
      }
    }
  }
  return { ingested, skipped: false };
}

/** SIM/line state reconciliation against Telnyx (imports unknown SIMs, confirms optimistic states). */
export async function runMobileStateReconcileCycle(db: any): Promise<{ skipped: boolean }> {
  if (!(await hasMobileFootprint(db))) {
    // A brand-new platform still needs the FIRST import path: a SIM bought in
    // the Telnyx portal directly would never appear otherwise. Cheap probe
    // only when credentials exist.
    const creds = await resolveTelnyxCredentials(db);
    if (!creds) return { skipped: true };
    await reconcileSimsWithTelnyx(db, creds).catch((err) =>
      console.error("mobile reconcile (bootstrap) failed", String(err?.message || err).slice(0, 160)));
    return { skipped: false };
  }
  const creds = await resolveTelnyxCredentials(db);
  if (!creds) return { skipped: true };
  await reconcileSimsWithTelnyx(db, creds);
  return { skipped: false };
}

/**
 * Anomaly sweep: flags data-usage spikes per line into the audit log (and the
 * line's reconcileReason as a visible note). ⛔ Detection only — it NEVER
 * suspends anything by itself; automatic suspension is a policy decision
 * that stays with a person until the owner asks for it.
 */
export async function runMobileAnomalySweep(db: any): Promise<{ flagged: number }> {
  if (!(await hasMobileFootprint(db))) return { flagged: 0 };
  const now = Date.now();
  const dayStart = new Date(now - DAY_MS);
  const baselineStart = new Date(now - 8 * DAY_MS);
  const lines = await db.mobileLine.findMany({ where: { status: "active" }, include: { plan: true } });
  let flagged = 0;

  for (const line of lines) {
    const [today, baseline] = await Promise.all([
      db.mobileUsageRecord.aggregate({ _sum: { quantity: true }, where: { lineId: line.id, kind: "data", recordedAt: { gte: dayStart } } }),
      db.mobileUsageRecord.aggregate({ _sum: { quantity: true }, where: { lineId: line.id, kind: "data", recordedAt: { gte: baselineStart, lt: dayStart } } }),
    ]);
    const todayMb = Number(today?._sum?.quantity ?? 0);
    const trailingAvg = Number(baseline?._sum?.quantity ?? 0) / 7;
    const { spike, reason } = detectUsageSpike({ todayMb, trailingDailyAvgMb: trailingAvg });
    if (!spike || !reason) continue;
    flagged += 1;
    writeMobileAudit({
      tenantId: line.tenantId,
      action: "mobile.usage.spike",
      entityType: "MobileLine",
      entityId: line.id,
      metadata: { reason, todayMb: Math.round(todayMb), trailingAvgMb: Math.round(trailingAvg) },
    });
    await db.mobileLine.update({
      where: { id: line.id },
      data: { reconcileReason: `usage spike: ${reason}`.slice(0, 300) },
    }).catch(() => undefined);
  }
  return { flagged };
}
