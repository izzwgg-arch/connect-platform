// Proof of delivery + exception routes (Phase 9).
import { db } from "@connect/db";
import { buildChatSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { requireDriver, requireDeliveryPermission } from "./guard";
import { DELIVERY_PERMISSIONS } from "./permissions";
import { submitProof, submitException } from "./proofService";
import { writeDeliveryAudit } from "./audit";

const PUBLIC_BASE = (process.env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
const signed = (key: string | null) => (key && PUBLIC_BASE ? buildChatSignedDownloadUrl(PUBLIC_BASE, key, 3600) : null);

export async function registerDeliveryProofRoutes(app: any): Promise<void> {
  // Driver: submit proof of delivery → DELIVERED (safeguards enforced server-side).
  app.post("/mobile/delivery/orders/:orderId/proof", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const r = await submitProof(ctx.user.tenantId, String(req.params.orderId), ctx.driver.id, req.body || {});
    if (!r.ok) return reply.status(r.code === "not_found" ? 404 : 422).send(r);
    return reply.send(r);
  });

  // Driver: submit a failed-delivery / exception.
  app.post("/mobile/delivery/orders/:orderId/exception", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const r = await submitException(ctx.user.tenantId, String(req.params.orderId), ctx.driver.id, req.body || {});
    if (!r.ok) return reply.status(r.code === "not_found" ? 404 : 422).send(r);
    return reply.send(r);
  });

  // Dispatcher: review proof of delivery (permission-gated + access is audited).
  app.get("/delivery/orders/:orderId/proof", async (req: any, reply: any) => {
    const user = await requireDeliveryPermission(req, reply, DELIVERY_PERMISSIONS.ACCESS_PROOF);
    if (!user) return;
    const orderId = String(req.params.orderId);
    const pod = await db.proofOfDelivery.findFirst({ where: { orderId, tenantId: user.tenantId } });
    if (!pod) return reply.status(404).send({ error: "no_proof" });
    writeDeliveryAudit({ tenantId: user.tenantId, action: "delivery.proof.viewed", entityType: "DeliveryOrder", entityId: orderId, actorUserId: user.sub });
    return reply.send({
      methods: pod.methods, handover: pod.handover, recipientName: pod.recipientName,
      photoUrl: signed(pod.photoStorageKey), signatureUrl: signed(pod.signatureStorageKey),
      gps: pod.gpsLat != null ? { lat: pod.gpsLat, lng: pod.gpsLng, accuracy: pod.gpsAccuracy } : null,
      overrideReason: pod.overrideReason, capturedAt: pod.capturedAt,
    });
  });

  // Dispatcher: approve an exception that requires review.
  app.post("/delivery/exceptions/:id/approve", async (req: any, reply: any) => {
    const user = await requireDeliveryPermission(req, reply, DELIVERY_PERMISSIONS.DISPATCH);
    if (!user) return;
    const ex = await db.deliveryException.findFirst({ where: { id: String(req.params.id), tenantId: user.tenantId }, select: { id: true } });
    if (!ex) return reply.status(404).send({ error: "not_found" });
    await db.deliveryException.update({ where: { id: ex.id }, data: { needsApproval: false, approvedByUserId: user.sub, approvedAt: new Date() } });
    writeDeliveryAudit({ tenantId: user.tenantId, action: "delivery.exception.approved", entityType: "DeliveryException", entityId: ex.id, actorUserId: user.sub });
    return reply.send({ ok: true });
  });
}
