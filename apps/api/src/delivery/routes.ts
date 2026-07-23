// Delivery route registration — Phase 3 (adds dispatcher routes).
// REPLACES the Phase 2 routes.ts. Wire in apps/api/src/server.ts:
//   import { registerDeliveryRoutes } from "./delivery/routes";
//   await registerDeliveryRoutes(app);

import { z } from "zod";
import { requireDeliveryDispatch, requireDriver, verifyOrderSourceSecret } from "./guard";
import { getDeliverySettings } from "./settingsService";
import { MockOrderSourceAdapter } from "./orderSourceAdapter";
import { ingestOrderEvent, listOrders, getOrder, transitionOrder } from "./orderService";
import { scanLabel } from "./scanService";
import { createRun, addStop, startRun, listRunsForDriver } from "./runService";
import { optimizeRun, stopNavUrl } from "./routeService";
import { isValidStatus, type DeliveryOrderStatus, type TransitionActor } from "./status";
import { registerDeliveryDispatchRoutes } from "./dispatchRoutes";
import { registerDeliveryLocationRoutes } from "./locationRoutes";
import { registerDeliveryCustomerRoutes } from "./customerRoutes";
import { registerDeliverySmsRoutes } from "./smsRoutes";
import { registerDeliveryVoiceRoutes } from "./voiceRoutes";
import { registerDeliveryProofRoutes } from "./proofRoutes";
import { registerDeliveryReportRoutes } from "./reportRoutes";

const mockAdapter = new MockOrderSourceAdapter();

export async function registerDeliveryRoutes(app: any): Promise<void> {
  // ── Internal order-source ingest (mock adapter until Phase 10) ──────────────
  app.post("/internal/delivery/orders", async (req: any, reply: any) => {
    if (!verifyOrderSourceSecret(req)) return reply.status(401).send({ error: "unauthorized" });
    const tenantId = String(req.headers?.["x-tenant-id"] || req.body?.tenantId || "").trim();
    if (!tenantId) return reply.status(400).send({ error: "tenant_required" });
    const event = mockAdapter.normalizeEvent(req.body?.event ?? req.body);
    if (!event) return reply.status(422).send({ error: "unrecognized_order_payload" });
    const result = await ingestOrderEvent(tenantId, event);
    if (!result.ok) return reply.status(409).send({ error: result.code });
    return reply.send(result);
  });

  // ── Dispatcher: settings + orders ──────────────────────────────────────────
  app.get("/delivery/config", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    return reply.send(await getDeliverySettings(user.tenantId));
  });

  app.get("/delivery/orders", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const q = req.query ?? {};
    return reply.send(
      await listOrders(user.tenantId, {
        status: typeof q.status === "string" ? q.status : undefined,
        storeId: typeof q.storeId === "string" ? q.storeId : undefined,
      }),
    );
  });

  app.get("/delivery/orders/:id", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const order = await getOrder(user.tenantId, String(req.params.id));
    if (!order) return reply.status(404).send({ error: "not_found" });
    return reply.send(order);
  });

  const transitionBody = z.object({
    to: z.string(),
    reason: z.string().max(500).optional(),
    hasProof: z.boolean().optional(),
    hasLocation: z.boolean().optional(),
  });

  app.post("/delivery/orders/:id/transition", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const parsed = transitionBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    if (!isValidStatus(parsed.data.to)) return reply.status(400).send({ error: "invalid_to_status" });
    const result = await transitionOrder({
      tenantId: user.tenantId,
      orderId: String(req.params.id),
      to: parsed.data.to as DeliveryOrderStatus,
      actor: "dispatcher" as TransitionActor,
      actorUserId: user.sub,
      reason: parsed.data.reason ?? null,
      hasProof: parsed.data.hasProof,
      hasLocation: parsed.data.hasLocation,
    });
    if (!result.ok) return reply.status(422).send(result);
    return reply.send(result);
  });

  // ── Dispatcher: runs ────────────────────────────────────────────────────────
  app.post("/delivery/runs", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return reply.status(400).send({ error: "store_required" });
    return reply.send(await createRun(user.tenantId, storeId, { driverId: req.body?.driverId }));
  });

  app.post("/delivery/runs/:id/stops", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const orderId = String(req.body?.orderId || "");
    if (!orderId) return reply.status(400).send({ error: "order_required" });
    const r = await addStop(user.tenantId, String(req.params.id), orderId);
    if (!r.ok) return reply.status(404).send(r);
    return reply.send(r);
  });

  app.post("/delivery/runs/:id/start", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const r = await startRun(user.tenantId, String(req.params.id), user.sub);
    if (!r.ok) return reply.status(404).send(r);
    return reply.send(r);
  });

  // Compute the best route (optimize stop order) for a run.
  app.post("/delivery/runs/:id/optimize", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const r = await optimizeRun(user.tenantId, String(req.params.id), user.sub);
    if (!r.ok) return reply.status(404).send(r);
    return reply.send(r);
  });

  // Driver: navigation deep link for a stop (Waze default; ?app=google to override).
  app.get("/mobile/delivery/stops/:orderId/nav", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const app2 = req.query?.app === "google" ? "google" : "waze";
    const r = await stopNavUrl(ctx.user.tenantId, String(req.params.orderId), app2 as any);
    if (!r.ok) return reply.status(404).send(r);
    return reply.send(r);
  });

  // ── Driver app ──────────────────────────────────────────────────────────────
  app.get("/mobile/delivery/runs", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    return reply.send(await listRunsForDriver(ctx.user.tenantId, ctx.driver.id));
  });

  const scanBody = z.object({
    token: z.string().min(1),
    clientOpId: z.string().min(1),
    confirmReassign: z.boolean().optional(),
  });

  app.post("/mobile/delivery/scan", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const parsed = scanBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const result = await scanLabel({
      tenantId: ctx.user.tenantId,
      driverId: ctx.driver.id,
      driverStoreIds: ctx.driver.storeIds,
      actorUserId: ctx.user.sub,
      token: parsed.data.token,
      clientOpId: parsed.data.clientOpId,
      confirmReassign: parsed.data.confirmReassign,
    });
    return reply.send(result);
  });

  // ── Dispatcher web experience (Phase 3) ──────────────────────────────────────
  await registerDeliveryDispatchRoutes(app);

  // ── Live location + ETA (Phase 5) ────────────────────────────────────────────
  await registerDeliveryLocationRoutes(app);

  // ── Customer tracking page + links (Phase 6) ─────────────────────────────────
  await registerDeliveryCustomerRoutes(app);

  // ── SMS notifications + inbound commands (Phase 7 — TEST endpoints only) ──────
  await registerDeliverySmsRoutes(app);

  // ── Voice/IVR status resolve (Phase 8 — READ-ONLY; no PBX writes) ────────────
  await registerDeliveryVoiceRoutes(app);

  // ── Proof of delivery + exceptions (Phase 9) ─────────────────────────────────
  await registerDeliveryProofRoutes(app);

  // ── Reporting (Phase 11) ─────────────────────────────────────────────────────
  await registerDeliveryReportRoutes(app);
}
