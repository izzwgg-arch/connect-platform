// Order domain service — wires the pure state machine + adapter to the database.
// Every write is tenant-scoped and writes a DeliveryStatusEvent + AuditLog.

import { db } from "@connect/db";
import {
  checkTransition,
  isValidStatus,
  type DeliveryOrderStatus,
  type TransitionActor,
} from "./status";
import { writeDeliveryAudit } from "./audit";
import { generateToken, hashToken } from "./tokens";
import type { NormalizedOrderEvent, NormalizedOrderInput } from "./orderSourceAdapter";
import { geocodeOrder } from "./geocodeService";

function toDate(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface TransitionParams {
  tenantId: string;
  orderId: string;
  to: DeliveryOrderStatus;
  actor: TransitionActor;
  actorUserId?: string | null;
  reason?: string | null;
  hasProof?: boolean;
  hasLocation?: boolean;
}

export type TransitionResult =
  | { ok: true; from: DeliveryOrderStatus; to: DeliveryOrderStatus }
  | { ok: false; code: string; reason: string };

/**
 * Apply a status transition. Server-authoritative: validates legality, actor, and
 * precondition presence (reason/proof/location) before writing.
 */
export async function transitionOrder(p: TransitionParams): Promise<TransitionResult> {
  const order = await db.deliveryOrder.findFirst({
    where: { id: p.orderId, tenantId: p.tenantId },
    select: { id: true, status: true },
  });
  if (!order) return { ok: false, code: "not_found", reason: "order not found" };

  const from = order.status as DeliveryOrderStatus;
  const check = checkTransition(from, p.to, p.actor);
  if (!check.ok) return { ok: false, code: check.code ?? "illegal_transition", reason: check.reason ?? "illegal" };

  const meta = check.meta!;
  if (meta.requiresReason && !String(p.reason || "").trim()) {
    return { ok: false, code: "reason_required", reason: `${from} → ${p.to} requires a reason` };
  }
  if (meta.requiresProof && !p.hasProof) {
    return { ok: false, code: "proof_required", reason: `${from} → ${p.to} requires proof of delivery` };
  }
  if (meta.requiresLocation && !p.hasLocation) {
    return { ok: false, code: "location_required", reason: `${from} → ${p.to} requires a location fix` };
  }

  await db.$transaction([
    db.deliveryOrder.update({ where: { id: order.id }, data: { status: p.to } }),
    db.deliveryStatusEvent.create({
      data: {
        tenantId: p.tenantId,
        orderId: order.id,
        fromStatus: from,
        toStatus: p.to,
        actor: p.actor,
        actorUserId: p.actorUserId ?? null,
        reason: p.reason ?? null,
      },
    }),
  ]);

  writeDeliveryAudit({
    tenantId: p.tenantId,
    action: "delivery.order.transition",
    entityType: "DeliveryOrder",
    entityId: order.id,
    actorUserId: p.actorUserId ?? null,
    metadata: { from, to: p.to, actor: p.actor, notifies: Boolean(meta.notifies) },
  });

  return { ok: true, from, to: p.to };
}

export interface IngestResult {
  ok: boolean;
  code?: string;
  orderId?: string;
  created?: boolean;
  labelToken?: string; // returned once, only on creation (raw); hash is persisted
}

/**
 * Ingest a normalized order-source event idempotently. Anchored on
 * (tenantId, sourceId). Never regresses status on update.
 */
export async function ingestOrderEvent(
  tenantId: string,
  event: NormalizedOrderEvent,
): Promise<IngestResult> {
  // Record the raw ingest for observability/replay.
  await db.deliveryOrderSourceEvent
    .create({
      data: { tenantId, type: event.type, sourceId: event.sourceId, payload: (event as any), status: "RECEIVED" },
    })
    .catch(() => undefined);

  if (event.type === "canceled") {
    const existing = await db.deliveryOrder.findUnique({
      where: { tenantId_sourceId: { tenantId, sourceId: event.sourceId } },
      select: { id: true },
    });
    if (!existing) return { ok: false, code: "unknown_order" };
    const r = await transitionOrder({
      tenantId,
      orderId: existing.id,
      to: "CANCELED",
      actor: "system",
      reason: "source_canceled",
    });
    return { ok: r.ok, code: r.ok ? undefined : (r as any).code, orderId: existing.id };
  }

  const input = event.order as NormalizedOrderInput;
  if (!input) return { ok: false, code: "missing_order" };

  const store = await db.deliveryStore.findUnique({
    where: { tenantId_externalRef: { tenantId, externalRef: input.storeExternalRef } },
    select: { id: true },
  });
  if (!store) return { ok: false, code: "unknown_store" };

  const existing = await db.deliveryOrder.findUnique({
    where: { tenantId_sourceId: { tenantId, sourceId: input.sourceId } },
    select: { id: true, status: true },
  });

  if (existing) {
    // Update mutable fields only; never regress status here.
    await db.deliveryOrder.update({
      where: { id: existing.id },
      data: {
        rawSourceStatus: input.rawStatus ?? undefined,
        customerName: input.customerName ?? undefined,
        customerPhone: input.customerPhone ?? undefined,
        addrLine1: input.address.line1,
        addrLine2: input.address.line2 ?? null,
        addrUnit: input.address.unit ?? null,
        addrCity: input.address.city ?? null,
        addrRegion: input.address.region ?? null,
        addrPostal: input.address.postal ?? null,
        instructions: input.address.instructions ?? null,
        lat: input.address.lat ?? undefined,
        lng: input.address.lng ?? undefined,
        geocodedAt: input.address.lat != null && input.address.lng != null ? new Date() : undefined,
        requestedWindowStart: toDate(input.requestedWindowStart),
        requestedWindowEnd: toDate(input.requestedWindowEnd),
      },
    });
    if (event.type === "ready") {
      await transitionOrder({ tenantId, orderId: existing.id, to: "READY", actor: "system" });
    }
    writeDeliveryAudit({
      tenantId,
      action: "delivery.order.updated",
      entityType: "DeliveryOrder",
      entityId: existing.id,
      metadata: { sourceId: input.sourceId, type: event.type },
    });
    return { ok: true, orderId: existing.id, created: false };
  }

  // Create + mint a label identifier atomically.
  const labelToken = generateToken();
  const initialStatus: DeliveryOrderStatus = event.type === "ready" ? "READY" : "RECEIVED";

  const order = await db.deliveryOrder.create({
    data: {
      tenantId,
      storeId: store.id,
      sourceId: input.sourceId,
      rawSourceStatus: input.rawStatus ?? "NEW",
      status: initialStatus,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
      addrLine1: input.address.line1,
      addrLine2: input.address.line2 ?? null,
      addrUnit: input.address.unit ?? null,
      addrCity: input.address.city ?? null,
      addrRegion: input.address.region ?? null,
      addrPostal: input.address.postal ?? null,
      instructions: input.address.instructions ?? null,
      lat: input.address.lat ?? null,
      lng: input.address.lng ?? null,
      geocodedAt: input.address.lat != null && input.address.lng != null ? new Date() : null,
      requestedWindowStart: toDate(input.requestedWindowStart),
      requestedWindowEnd: toDate(input.requestedWindowEnd),
      priority: input.priority ?? "NORMAL",
      signatureRequired: Boolean(input.flags?.signatureRequired),
      ageRestricted: Boolean(input.flags?.ageRestricted),
      cashOnDelivery: Boolean(input.flags?.cashOnDelivery),
      language: input.language ?? null,
      messagingConsent: Boolean(input.messagingConsent),
      packages: input.packages?.length
        ? {
            create: input.packages.map((pk) => ({
              tenantId,
              label: pk.label ?? null,
              tempSensitive: Boolean(pk.tempSensitive),
            })),
          }
        : undefined,
      identifiers: {
        create: [{ tenantId, tokenHash: hashToken(labelToken), kind: "LABEL" }],
      },
      statusEvents: {
        create: [{ tenantId, fromStatus: null, toStatus: initialStatus, actor: "system", reason: "created_from_source" }],
      },
    },
    select: { id: true },
  });

  writeDeliveryAudit({
    tenantId,
    action: "delivery.order.created",
    entityType: "DeliveryOrder",
    entityId: order.id,
    metadata: { sourceId: input.sourceId, storeId: store.id },
  });

  // Geocode address-only orders in the background (no-op unless a geocoder is configured).
  if (input.address.lat == null || input.address.lng == null) {
    geocodeOrder(tenantId, order.id).catch(() => {});
  }

  return { ok: true, orderId: order.id, created: true, labelToken };
}

/** Resolve a scanned label token to an order (tenant-scoped by the identifier row). */
export async function resolveLabelToken(tenantId: string, token: string) {
  const idRow = await db.deliveryOrderIdentifier.findUnique({
    where: { tenantId_tokenHash: { tenantId, tokenHash: hashToken(token) } },
    select: { order: { select: { id: true, tenantId: true, storeId: true, status: true } } },
  });
  return idRow?.order ?? null;
}

export async function listOrders(tenantId: string, opts: { status?: string; storeId?: string; take?: number } = {}) {
  return db.deliveryOrder.findMany({
    where: {
      tenantId,
      ...(opts.status && isValidStatus(opts.status) ? { status: opts.status } : {}),
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 100, 200),
  });
}

export async function getOrder(tenantId: string, orderId: string) {
  return db.deliveryOrder.findFirst({
    where: { id: orderId, tenantId },
    include: {
      packages: true,
      statusEvents: { orderBy: { createdAt: "asc" } },
      assignment: true,
      runStop: true,
    },
  });
}

/** Reassign an order to a different driver (dispatcher support action). */
export async function reassignOrder(tenantId: string, orderId: string, driverId: string, actorUserId: string) {
  const order = await db.deliveryOrder.findFirst({ where: { id: orderId, tenantId }, select: { id: true } });
  if (!order) return { ok: false as const, code: "not_found" };
  const driver = await db.driverProfile.findFirst({ where: { id: driverId, tenantId, active: true }, select: { id: true } });
  if (!driver) return { ok: false as const, code: "driver_not_found" };
  const existing = await db.deliveryAssignment.findUnique({ where: { orderId }, select: { id: true } });
  if (existing) await db.deliveryAssignment.update({ where: { id: existing.id }, data: { driverId } });
  else await db.deliveryAssignment.create({ data: { tenantId, orderId, driverId, clientOpId: `reassign-${generateToken(8)}` } });
  writeDeliveryAudit({ tenantId, action: "delivery.order.reassigned", entityType: "DeliveryOrder", entityId: orderId, actorUserId, metadata: { driverId } });
  return { ok: true as const, driverId };
}

/** Attach an internal dispatcher note (audit-backed; surfaces in the order timeline/audit). */
export async function addOrderNote(tenantId: string, orderId: string, text: string, actorUserId: string) {
  const order = await db.deliveryOrder.findFirst({ where: { id: orderId, tenantId }, select: { id: true } });
  if (!order) return { ok: false as const, code: "not_found" };
  const note = String(text || "").trim().slice(0, 1000);
  if (!note) return { ok: false as const, code: "empty_note" };
  writeDeliveryAudit({ tenantId, action: "delivery.order.note", entityType: "DeliveryOrder", entityId: orderId, actorUserId, metadata: { note } });
  return { ok: true as const };
}
