// Proof-of-delivery + exception service (Phase 9). Enforces the pure safeguards/rules, stores
// media via the shared (S3/R2/local) storage with signed access, and drives the state machine.

import { db } from "@connect/db";
import { writeChatAttachmentFile } from "@connect/shared/chatAttachmentStorage";
import { requiredProof, decideCompletion, type ProofMethod, type HandoverType } from "./proofRequirements";
import { exceptionRule, validateException, isValidExceptionReason, type ExceptionReason } from "./exceptionRules";
import { transitionOrder } from "./orderService";
import { canTransition, type DeliveryOrderStatus } from "./status";
import { haversineMeters } from "./geo";
import { notifyOrder } from "./smsService";
import { writeDeliveryAudit } from "./audit";

const POD_MAX_BYTES = 8 * 1024 * 1024;
const NEAR_RADIUS_M = 200;

async function storeMedia(tenantId: string, orderId: string, kind: string, base64: string, mime: string): Promise<string> {
  const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");
  const ext = mime.includes("png") ? "png" : "jpg";
  const res = await writeChatAttachmentFile({
    tenantKey: tenantId, threadId: `pod-${orderId}`, originalFilename: `${kind}.${ext}`,
    buffer, mimeType: mime, maxBytes: POD_MAX_BYTES,
  });
  return res.storageKey;
}

function nearDestination(order: { lat: number | null; lng: number | null }, gps?: { lat?: number; lng?: number }): boolean {
  if (order.lat == null || order.lng == null || gps?.lat == null || gps?.lng == null) return true; // can't check → don't block on proximity
  return haversineMeters({ lat: order.lat, lng: order.lng }, { lat: gps.lat!, lng: gps.lng! }) <= NEAR_RADIUS_M;
}

export interface ProofInput {
  handover?: HandoverType;
  recipientName?: string;
  pin?: string;
  gpsLat?: number; gpsLng?: number; gpsAccuracy?: number;
  photoBase64?: string; photoMime?: string;
  signatureBase64?: string; signatureMime?: string;
  overrideReason?: string;
}

export async function submitProof(tenantId: string, orderId: string, driverId: string, input: ProofInput) {
  const order = await db.deliveryOrder.findFirst({
    where: { id: orderId, tenantId },
    select: { id: true, status: true, signatureRequired: true, ageRestricted: true, lat: true, lng: true },
  });
  if (!order) return { ok: false as const, code: "not_found" };
  if (order.status !== "ARRIVED") return { ok: false as const, code: "must_arrive_first", status: order.status };

  const alreadySubmitted = Boolean(await db.proofOfDelivery.findUnique({ where: { orderId }, select: { id: true } }));

  // Store media first (so provided-proof reflects what's captured).
  const photoKey = input.photoBase64 ? await storeMedia(tenantId, orderId, "photo", input.photoBase64, input.photoMime || "image/jpeg") : null;
  const signatureKey = input.signatureBase64 ? await storeMedia(tenantId, orderId, "signature", input.signatureBase64, input.signatureMime || "image/png") : null;

  const provided: ProofMethod[] = [];
  if (photoKey) provided.push("photo");
  if (signatureKey) provided.push("signature");
  if (input.pin) provided.push("pin");
  if (input.recipientName) provided.push("recipient_name");
  if (input.gpsLat != null && input.gpsLng != null) provided.push("gps");
  if (input.handover) provided.push("tap");

  const required = requiredProof({ signatureRequired: order.signatureRequired, ageRestricted: order.ageRestricted });
  const near = nearDestination(order, { lat: input.gpsLat, lng: input.gpsLng });
  const decision = decideCompletion({
    requiredProof: required, providedProof: provided, handover: input.handover,
    nearDestination: near, hasLocation: input.gpsLat != null && input.gpsLng != null,
    overrideReason: input.overrideReason, alreadySubmitted,
  });
  if (!decision.ok) return { ok: false as const, code: "blocked", blocks: decision.blocks, missingProof: decision.missingProof };

  await db.proofOfDelivery.create({
    data: {
      tenantId, orderId, methods: provided.join(","), handover: input.handover ?? null,
      recipientName: input.recipientName ?? null, photoStorageKey: photoKey, signatureStorageKey: signatureKey,
      gpsLat: input.gpsLat ?? null, gpsLng: input.gpsLng ?? null, gpsAccuracy: input.gpsAccuracy ?? null,
      overrideReason: input.overrideReason ?? null, capturedByDriverId: driverId,
    },
  });

  const t = await transitionOrder({
    tenantId, orderId, to: "DELIVERED", actor: "driver", actorUserId: driverId,
    hasProof: true, hasLocation: input.gpsLat != null,
  });
  if (!t.ok) return { ok: false as const, code: "transition_failed", detail: t };

  notifyOrder(tenantId, orderId, "delivered").catch(() => {});
  writeDeliveryAudit({ tenantId, action: "delivery.proof.captured", entityType: "DeliveryOrder", entityId: orderId, actorUserId: driverId, metadata: { methods: provided } });
  return { ok: true as const, methods: provided };
}

export interface ExceptionInput {
  reason: string;
  note?: string;
  photoBase64?: string; photoMime?: string;
}

export async function submitException(tenantId: string, orderId: string, driverId: string, input: ExceptionInput) {
  if (!isValidExceptionReason(input.reason)) return { ok: false as const, code: "invalid_reason" };
  const reason = input.reason as ExceptionReason;

  const order = await db.deliveryOrder.findFirst({ where: { id: orderId, tenantId }, select: { id: true, status: true } });
  if (!order) return { ok: false as const, code: "not_found" };

  const photoKey = input.photoBase64 ? await storeMedia(tenantId, orderId, "exception", input.photoBase64, input.photoMime || "image/jpeg") : null;
  const check = validateException({ reason, hasPhoto: Boolean(photoKey), note: input.note });
  if (!check.ok) return { ok: false as const, code: "incomplete", missing: check.missing };

  const rule = check.rule;
  // Map the rule's target to a status that's legal from the current one (driver at the stop).
  let to = rule.targetStatus as DeliveryOrderStatus;
  if (!canTransition(order.status as DeliveryOrderStatus, to)) {
    to = canTransition(order.status as DeliveryOrderStatus, "DELIVERY_FAILED") ? "DELIVERY_FAILED" : to;
  }

  await db.deliveryException.create({
    data: { tenantId, orderId, reasonCode: reason, note: input.note ?? null, photoStorageKey: photoKey, needsApproval: rule.requiresApproval, createdByDriverId: driverId },
  });

  const t = await transitionOrder({ tenantId, orderId, to, actor: "driver", actorUserId: driverId, reason });
  if (!t.ok) return { ok: false as const, code: "transition_failed", detail: t };

  if (rule.notifiesCustomer) notifyOrder(tenantId, orderId, "failed").catch(() => {});
  writeDeliveryAudit({ tenantId, action: "delivery.exception.recorded", entityType: "DeliveryOrder", entityId: orderId, actorUserId: driverId, metadata: { reason, to, needsApproval: rule.requiresApproval } });
  return { ok: true as const, status: to, rule };
}
