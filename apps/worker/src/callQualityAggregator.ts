/**
 * 24/7 call-quality aggregation — the "always learning" data layer.
 *
 * Every call (mobile Android today; web/iOS as they adopt the same report
 * shape) submits a CALL_QUALITY_REPORT at hangup with both receive-side and
 * send-side (uplink) stats. This cycle distills those raw reports into
 * CallQualityHourly buckets keyed by the dimensions tuning decisions need:
 * tenant / user / direction / codec / network / relay-vs-direct.
 *
 * Consumers:
 *  - the adaptive-audio layer (chooses e.g. forceTurnRelay per device by
 *    comparing relay vs direct buckets for the same user/network)
 *  - degradation alerts: an hour with sustained bad loss for a tenant is
 *    logged loudly + written as a CALL_QUALITY_DEGRADED audit incident, so
 *    quality regressions surface without anyone complaining first.
 *
 * Runs hourly (re-aggregating a 3h window so late reports and the current
 * partial hour stay accurate — upserts are idempotent).
 */
import { db } from "@connect/db";

const WINDOW_HOURS = 3;
// Alert thresholds: sustained (≥3 calls) average loss in either direction.
const ALERT_MIN_CALLS = 3;
const ALERT_LOSS_PCT = 2.0;

type Bucket = {
  hourStart: Date;
  tenantId: string;
  userId: string;
  direction: string;
  audioCodec: string;
  networkType: string;
  usedRelay: boolean;
  calls: number;
  poorCalls: number;
  rttSum: number;
  rttCount: number;
  rttMax: number;
  jitterSum: number;
  jitterCount: number;
  lossSum: number;
  lossCount: number;
  lossMax: number;
  txLossSum: number;
  txLossCount: number;
  txLossMax: number;
};

let running = false;

export async function runCallQualityAggregateCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);
    const reports = await db.voiceDiagEvent.findMany({
      where: { type: "CALL_QUALITY_REPORT" as any, createdAt: { gte: since } },
      select: { createdAt: true, tenantId: true, userId: true, payload: true },
      take: 5000,
    });

    const buckets = new Map<string, Bucket>();
    for (const r of reports) {
      const p = (r.payload ?? {}) as Record<string, any>;
      const hourStart = new Date(r.createdAt);
      hourStart.setMinutes(0, 0, 0);
      const direction = typeof p.direction === "string" ? p.direction : "unknown";
      const audioCodec = typeof p.audioCodec === "string" ? p.audioCodec : "unknown";
      const networkType = typeof p.networkType === "string" && p.networkType ? p.networkType : "unknown";
      const usedRelay = p.isUsingRelay === true;
      const key = [hourStart.toISOString(), r.tenantId, r.userId, direction, audioCodec, networkType, usedRelay].join("|");
      let b = buckets.get(key);
      if (!b) {
        b = {
          hourStart, tenantId: r.tenantId, userId: r.userId, direction, audioCodec, networkType, usedRelay,
          calls: 0, poorCalls: 0, rttSum: 0, rttCount: 0, rttMax: 0,
          jitterSum: 0, jitterCount: 0, lossSum: 0, lossCount: 0, lossMax: 0,
          txLossSum: 0, txLossCount: 0, txLossMax: 0,
        };
        buckets.set(key, b);
      }
      b.calls += 1;
      if (p.qualityGrade === "poor") b.poorCalls += 1;
      if (typeof p.rttMs === "number") { b.rttSum += p.rttMs; b.rttCount += 1; b.rttMax = Math.max(b.rttMax, p.rttMs); }
      if (typeof p.jitterMs === "number") { b.jitterSum += p.jitterMs; b.jitterCount += 1; }
      const lost = typeof p.packetsLost === "number" ? p.packetsLost : null;
      const recv = typeof p.packetsReceived === "number" ? p.packetsReceived : null;
      if (lost !== null && recv !== null && lost + recv > 0) {
        const pct = (lost / (lost + recv)) * 100;
        b.lossSum += pct; b.lossCount += 1; b.lossMax = Math.max(b.lossMax, pct);
      }
      const txPct = typeof p.txFractionLost === "number"
        ? p.txFractionLost
        : (typeof p.txPacketsLost === "number" && typeof p.packetsSent === "number" && p.packetsSent > 0
            ? (p.txPacketsLost / p.packetsSent) * 100
            : null);
      if (txPct !== null) { b.txLossSum += txPct; b.txLossCount += 1; b.txLossMax = Math.max(b.txLossMax, txPct); }
    }

    let upserted = 0;
    const degraded: Bucket[] = [];
    for (const b of buckets.values()) {
      const data = {
        calls: b.calls,
        poorCalls: b.poorCalls,
        avgRttMs: b.rttCount ? b.rttSum / b.rttCount : null,
        maxRttMs: b.rttCount ? Math.round(b.rttMax) : null,
        avgJitterMs: b.jitterCount ? b.jitterSum / b.jitterCount : null,
        avgLossPct: b.lossCount ? b.lossSum / b.lossCount : null,
        maxLossPct: b.lossCount ? b.lossMax : null,
        avgTxLossPct: b.txLossCount ? b.txLossSum / b.txLossCount : null,
        maxTxLossPct: b.txLossCount ? b.txLossMax : null,
      };
      await (db as any).callQualityHourly.upsert({
        where: {
          hourStart_tenantId_userId_direction_audioCodec_networkType_usedRelay: {
            hourStart: b.hourStart, tenantId: b.tenantId, userId: b.userId,
            direction: b.direction, audioCodec: b.audioCodec,
            networkType: b.networkType, usedRelay: b.usedRelay,
          },
        },
        create: {
          hourStart: b.hourStart, tenantId: b.tenantId, userId: b.userId,
          direction: b.direction, audioCodec: b.audioCodec,
          networkType: b.networkType, usedRelay: b.usedRelay,
          ...data,
        },
        update: data,
      }).catch((e: any) => console.warn("[call-quality] bucket upsert failed:", e?.message));
      upserted += 1;

      const badRx = data.avgLossPct !== null && data.avgLossPct >= ALERT_LOSS_PCT;
      const badTx = data.avgTxLossPct !== null && data.avgTxLossPct >= ALERT_LOSS_PCT;
      if (b.calls >= ALERT_MIN_CALLS && (badRx || badTx)) degraded.push(b);
    }

    console.info(
      `[call-quality] aggregated ${reports.length} report(s) into ${upserted} hourly bucket(s) (window ${WINDOW_HOURS}h)`,
    );

    for (const b of degraded) {
      const avgLoss = b.lossCount ? (b.lossSum / b.lossCount).toFixed(1) : "-";
      const avgTx = b.txLossCount ? (b.txLossSum / b.txLossCount).toFixed(1) : "-";
      console.error(
        `[call-quality] DEGRADED tenant=${b.tenantId} user=${b.userId} hour=${b.hourStart.toISOString()} ` +
          `network=${b.networkType} codec=${b.audioCodec} relay=${b.usedRelay} calls=${b.calls} ` +
          `rxLoss=${avgLoss}% txLoss=${avgTx}%`,
      );
      await db.auditLog.create({
        data: {
          tenantId: b.tenantId,
          action: "CALL_QUALITY_DEGRADED",
          entityType: "CallQualityHourly",
          entityId: `${b.hourStart.toISOString()}|${b.userId}|${b.networkType}|relay=${b.usedRelay}`,
        },
      }).catch(() => undefined);
    }
  } catch (err: any) {
    console.error("[call-quality] aggregate cycle failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}
