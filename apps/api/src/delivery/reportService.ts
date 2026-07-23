// Delivery reporting service (Phase 11). Cheap aggregates via count/groupBy (no per-row loops
// beyond a bounded duration sample). Feeds the pure buildReportSummary.

import { db } from "@connect/db";
import { buildReportSummary, type RawReport, type EtaSample } from "./reportAggregation";

const FAILURE_STATUSES = ["DELIVERY_FAILED", "CUSTOMER_UNAVAILABLE", "ADDRESS_ISSUE", "REFUSED"];
const DURATION_SAMPLE = 100;

export async function buildTenantReport(tenantId: string, sinceDays = 7) {
  const since = new Date(Date.now() - Math.max(1, sinceDays) * 86_400_000);
  const evWhere = { tenantId, createdAt: { gte: since } };

  const [ordersReceived, delivered, failed, exGroup] = await Promise.all([
    db.deliveryOrder.count({ where: { tenantId, createdAt: { gte: since } } }),
    db.deliveryStatusEvent.count({ where: { ...evWhere, toStatus: "DELIVERED" } }),
    db.deliveryStatusEvent.count({ where: { ...evWhere, toStatus: { in: FAILURE_STATUSES } } }),
    db.deliveryException.groupBy({ by: ["reasonCode"], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } }),
  ]);

  const failedReasonCounts: Record<string, number> = {};
  let exceptionCount = 0;
  for (const g of exGroup as any[]) {
    failedReasonCounts[g.reasonCode] = g._count._all;
    exceptionCount += g._count._all;
  }

  // Bounded duration sample: pair DELIVERED with OUT_FOR_DELIVERY per order.
  const deliveredEvents = await db.deliveryStatusEvent.findMany({
    where: { ...evWhere, toStatus: "DELIVERED" },
    orderBy: { createdAt: "desc" },
    take: DURATION_SAMPLE,
    select: { orderId: true, createdAt: true },
  });
  const orderIds = deliveredEvents.map((e) => e.orderId);
  const departEvents = orderIds.length
    ? await db.deliveryStatusEvent.findMany({
        where: { tenantId, orderId: { in: orderIds }, toStatus: "OUT_FOR_DELIVERY" },
        select: { orderId: true, createdAt: true },
      })
    : [];
  const departByOrder = new Map(departEvents.map((e) => [e.orderId, e.createdAt.getTime()]));
  const deliveryDurationsSec: number[] = [];
  for (const d of deliveredEvents) {
    const depart = departByOrder.get(d.orderId);
    if (depart != null) deliveryDurationsSec.push(Math.max(0, (d.createdAt.getTime() - depart) / 1000));
  }

  const etaSamples: EtaSample[] = []; // ETA-vs-actual correlation deferred (flagged approximate)

  const raw: RawReport = {
    ordersReceived,
    delivered,
    failed,
    firstAttemptDelivered: Math.max(0, delivered - exceptionCount), // approximate
    deliveryDurationsSec,
    etaSamples,
    failedReasonCounts,
  };
  return { sinceDays, ...buildReportSummary(raw) };
}
