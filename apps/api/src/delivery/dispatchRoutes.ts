// Dispatcher API routes (Phase 3). Registered by registerDeliveryRoutes().
import { z } from "zod";
import { requireDeliveryDispatch, requireDeliveryConfig, requireDeliveryDriverAdmin } from "./guard";
import { getDashboardCounts, listExceptions, listExceptionQueue, resolveExceptionRow, listDeliveryAudit, upsertConfig, listDrivers, getDriverDetail, createDriver, deactivateDriver } from "./dispatchService";
import { dashboardTiles, rankAttention, needsIntervention, type AttentionItem } from "./dashboard";
import { transitionOrder } from "./orderService";
import { mintTrackingLink } from "./customerTrackingService";

export async function registerDeliveryDispatchRoutes(app: any): Promise<void> {
  // Dashboard: counts + shaped tiles + attention ranking (summary before detail).
  app.get("/delivery/dashboard", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const storeId = typeof req.query?.storeId === "string" ? req.query.storeId : undefined;
    const counts = await getDashboardCounts(user.tenantId, storeId);
    const exceptions = await listExceptions(user.tenantId, storeId);
    const attention: AttentionItem[] = exceptions.map((o) => ({ kind: "exception", ref: o.sourceId, detail: o.status }));
    return reply.send({
      counts,
      tiles: dashboardTiles(counts),
      attention: rankAttention(attention),
      needsIntervention: needsIntervention(counts),
    });
  });

  app.get("/delivery/exceptions", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const storeId = typeof req.query?.storeId === "string" ? req.query.storeId : undefined;
    return reply.send(await listExceptions(user.tenantId, storeId));
  });

  // Actionable exception queue (reason-coded, with per-row actions).
  app.get("/delivery/exceptions/queue", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const storeId = typeof req.query?.storeId === "string" ? req.query.storeId : undefined;
    return reply.send(await listExceptionQueue(user.tenantId, storeId));
  });

  const exceptionActionBody = z.object({ action: z.enum(["resolve", "dismiss", "reschedule", "notify"]) });
  app.post("/delivery/exceptions/:id/action", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const parsed = exceptionActionBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const { action } = parsed.data;
    const resolved = await resolveExceptionRow(user.tenantId, String(req.params.id), user.sub, action === "dismiss" ? "dismiss" : "resolve");
    if (!resolved.ok) return reply.status(404).send(resolved);
    // Follow-on effects for the two order-affecting actions.
    if (action === "reschedule") {
      await transitionOrder({ tenantId: user.tenantId, orderId: resolved.orderId, to: "RESCHEDULED", actor: "dispatcher", actorUserId: user.sub, reason: "exception_reschedule" });
    } else if (action === "notify") {
      // Ensure the customer has a live tracking link (SMS send stays test-mode elsewhere).
      await mintTrackingLink(user.tenantId, resolved.orderId, 72, user.sub);
    }
    return reply.send({ ok: true, action, orderId: resolved.orderId });
  });

  app.get("/delivery/audit", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    return reply.send(await listDeliveryAudit(user.tenantId));
  });

  // Config (tenant admins / manage_delivery_config).
  const configBody = z.object({
    enabled: z.boolean().optional(),
    mapReveal: z.enum(["PROGRESSIVE", "FULL", "NONE"]).optional(),
    exactPinStopsAway: z.number().int().min(0).max(10).optional(),
    verifyTier: z.enum(["TIERED", "STRICT", "LIGHT"]).optional(),
    voiceMode: z.enum(["PRERECORDED_NUMBER_PLAYBACK", "TTS", "COARSE"]).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    notifyOutForDelivery: z.boolean().optional(),
    notifyDelayed: z.boolean().optional(),
    notifyDelivered: z.boolean().optional(),
    notifyApproaching: z.boolean().optional(),
  });

  app.put("/delivery/config", async (req: any, reply: any) => {
    const user = await requireDeliveryConfig(req, reply);
    if (!user) return;
    const parsed = configBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return reply.send(await upsertConfig(user.tenantId, parsed.data, user.sub));
  });

  // Drivers.
  app.get("/delivery/drivers", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    return reply.send(await listDrivers(user.tenantId));
  });

  app.get("/delivery/drivers/:id", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const d = await getDriverDetail(user.tenantId, String(req.params.id));
    if (!d) return reply.status(404).send({ error: "not_found" });
    return reply.send(d);
  });

  const createDriverBody = z.object({ userId: z.string().min(1), storeIds: z.array(z.string()).default([]) });
  app.post("/delivery/drivers", async (req: any, reply: any) => {
    const user = await requireDeliveryDriverAdmin(req, reply);
    if (!user) return;
    const parsed = createDriverBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    return reply.send(await createDriver(user.tenantId, parsed.data.userId, parsed.data.storeIds, user.sub));
  });

  app.post("/delivery/drivers/:id/deactivate", async (req: any, reply: any) => {
    const user = await requireDeliveryDriverAdmin(req, reply);
    if (!user) return;
    const r = await deactivateDriver(user.tenantId, String(req.params.id), user.sub);
    if (!r.ok) return reply.status(404).send(r);
    return reply.send(r);
  });
}
