// Customer tracking service — resolves a secure token to the privacy-filtered view,
// mints/revokes links, and handles OTP tier-2 verification. Uses the pure cores for all
// privacy/ETA decisions. Public-facing: the customer API returns ONLY buildCustomerView output.

import { db } from "@connect/db";
import { createHash } from "node:crypto";
import { generateToken, hashToken } from "./tokens";
import { buildCustomerView } from "./customerView";
import { checkTokenValidity, resolveTier } from "./trackingTokenPolicy";
import { computeMovement } from "./staleness";
import { computeEta } from "./eta";
import { latestForRun } from "./locationService";
import { getDeliverySettings } from "./settingsService";
import { isTerminalStatus, type DeliveryOrderStatus } from "./status";
import { writeDeliveryAudit } from "./audit";

const AVG_STOP_TRAVEL_SEC = 480; // 8 min/stop heuristic until real routing is wired
const AVG_SERVICE_SEC = 120;

export type TrackingState = "ok" | "invalid" | "expired" | "revoked" | "not_found";

export interface TrackingResult {
  state: TrackingState;
  view?: ReturnType<typeof buildCustomerView>;
  tenantBrand?: { name: string } | null;
}

/** Mint a tracking link for an order (dispatcher). Returns the RAW token (shown once). */
export async function mintTrackingLink(tenantId: string, orderId: string, ttlHours = 72, actorUserId?: string) {
  const order = await db.deliveryOrder.findFirst({ where: { id: orderId, tenantId }, select: { id: true } });
  if (!order) return { ok: false as const, code: "not_found" };
  // Revoke any prior active tokens for this order (one live link at a time).
  await db.trackingToken.updateMany({ where: { tenantId, orderId, revokedAt: null }, data: { revokedAt: new Date() } });
  const raw = generateToken(24);
  await db.trackingToken.create({
    data: { tenantId, orderId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + ttlHours * 3_600_000) },
  });
  writeDeliveryAudit({ tenantId, action: "delivery.tracking_link.minted", entityType: "DeliveryOrder", entityId: orderId, actorUserId: actorUserId ?? null });
  return { ok: true as const, token: raw };
}

export async function revokeTrackingLinks(tenantId: string, orderId: string, actorUserId?: string) {
  await db.trackingToken.updateMany({ where: { tenantId, orderId, revokedAt: null }, data: { revokedAt: new Date() } });
  writeDeliveryAudit({ tenantId, action: "delivery.tracking_link.revoked", entityType: "DeliveryOrder", entityId: orderId, actorUserId: actorUserId ?? null });
  return { ok: true as const };
}

async function stopsAwayFor(tenantId: string, order: { id: string }): Promise<number | null> {
  const stop = await db.deliveryRunStop.findUnique({ where: { orderId: order.id }, select: { runId: true, sequence: true } });
  if (!stop) return null;
  // pending stops ahead of this one on the same run
  const ahead = await db.deliveryRunStop.count({
    where: { runId: stop.runId, sequence: { lt: stop.sequence }, status: { notIn: ["DONE", "FAILED", "SKIPPED"] } },
  });
  return ahead;
}

/** Resolve a raw token to the customer-safe view (or a failure state that leaks nothing). */
export async function resolveTrackingView(rawToken: string, nowMs = Date.now()): Promise<TrackingResult> {
  const tok = await db.trackingToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, tenantId: true, orderId: true, expiresAt: true, revokedAt: true, verifiedAt: true },
  });
  if (!tok) return { state: "invalid" };

  const order = await db.deliveryOrder.findFirst({
    where: { id: tok.orderId, tenantId: tok.tenantId },
    select: {
      id: true, status: true, sourceId: true, updatedAt: true,
      addrLine1: true, addrUnit: true,
    },
  });
  if (!order) return { state: "not_found" };

  const status = order.status as DeliveryOrderStatus;
  const terminal = isTerminalStatus(status);
  const validity = checkTokenValidity(
    { expiresAt: tok.expiresAt?.getTime() ?? null, revokedAt: tok.revokedAt?.getTime() ?? null, orderTerminal: terminal },
    nowMs,
    terminal ? order.updatedAt.getTime() : null,
  );
  if (!validity.valid) return { state: validity.reason === "revoked" ? "revoked" : "expired" };

  const tier = resolveTier({ tokenValid: true, otpVerified: tok.verifiedAt != null });
  const settings = await getDeliverySettings(tok.tenantId);
  const stopsAway = await stopsAwayFor(tok.tenantId, order);

  // latest fix (via the order's run) → movement/isLive
  const runStop = await db.deliveryRunStop.findUnique({ where: { orderId: order.id }, select: { runId: true } });
  const fix = runStop ? await latestForRun(tok.tenantId, runStop.runId) : null;
  const movement = computeMovement({
    lastSampleAtMs: fix ? fix.serverTs.getTime() : null,
    nowMs,
    speedMps: fix?.speed ?? null,
  });

  // Coarse ETA from stops-away heuristic (real routing refines later).
  const legs = Array.from({ length: (stopsAway ?? 0) + 1 }, () => AVG_STOP_TRAVEL_SEC);
  const eta = stopsAway != null
    ? computeEta({ legTravelSeconds: legs, serviceSecondsPerStop: AVG_SERVICE_SEC, stopsAway, ageSec: movement.ageSec ?? 0, isLive: movement.isLive })
    : null;

  const view = buildCustomerView({
    status,
    orderRef: `#${order.sourceId}`,
    mapReveal: (settings as any).mapReveal ?? "PROGRESSIVE",
    exactPinStopsAway: (settings as any).exactPinStopsAway ?? 1,
    stopsAway,
    isLive: movement.isLive,
    movement: movement.status,
    eta,
    nowMs,
    position: movement.isLive && fix ? { lat: fix.lat, lng: fix.lng, heading: fix.heading } : null,
    lastUpdateSec: movement.ageSec,
    verifiedTier: tier,
    deliveryAddress: tier >= 2 ? `${order.addrLine1}${order.addrUnit ? `, ${order.addrUnit}` : ""}` : null,
    proofSummary: null, // proof surfaces in Phase 9
  });

  return { state: "ok", view };
}

/** Verify an OTP to unlock tier-2 detail. Rate-limited by otpAttempts. */
export async function verifyTrackingOtp(rawToken: string, code: string, nowMs = Date.now()) {
  const tok = await db.trackingToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, otpHash: true, otpExpiresAt: true, otpAttempts: true },
  });
  if (!tok) return { ok: false as const, code: "invalid" };
  if (tok.otpAttempts >= 5) return { ok: false as const, code: "too_many_attempts" };
  if (!tok.otpHash || !tok.otpExpiresAt || nowMs >= tok.otpExpiresAt.getTime())
    return { ok: false as const, code: "otp_expired" };
  const match = createHash("sha256").update(String(code).trim()).digest("hex") === tok.otpHash;
  await db.trackingToken.update({
    where: { id: tok.id },
    data: match ? { verifiedAt: new Date() } : { otpAttempts: { increment: 1 } },
  });
  return match ? { ok: true as const } : { ok: false as const, code: "otp_mismatch" };
}
