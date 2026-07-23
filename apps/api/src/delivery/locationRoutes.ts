// Location + ETA routes (Phase 5). Register from registerDeliveryRoutes():
//   import { registerDeliveryLocationRoutes } from "./locationRoutes";
//   await registerDeliveryLocationRoutes(app);

import { z } from "zod";
import { requireDriver, requireDeliveryDispatch } from "./guard";
import { startSession, endSession, ingestSamples, getDispatchMap } from "./locationService";

export async function registerDeliveryLocationRoutes(app: any): Promise<void> {
  // Driver: start/end tracking session (bounds when location is collected).
  app.post("/mobile/delivery/tracking/start", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const runId = String(req.body?.runId || "");
    if (!runId) return reply.status(400).send({ error: "run_required" });
    return reply.send(await startSession(ctx.user.tenantId, runId, ctx.driver.id));
  });

  app.post("/mobile/delivery/tracking/end", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) return reply.status(400).send({ error: "session_required" });
    const r = await endSession(ctx.user.tenantId, sessionId, String(req.body?.reason || "COMPLETED"));
    if (!r.ok) return reply.status(404).send(r);
    return reply.send(r);
  });

  // Driver: batched location ingest (store-and-forward friendly).
  const sample = z.object({
    lat: z.number(),
    lng: z.number(),
    accuracy: z.number().nullable().optional(),
    speed: z.number().nullable().optional(),
    heading: z.number().nullable().optional(),
    batteryPct: z.number().int().nullable().optional(),
    deviceTs: z.number(),
  });
  const locationBody = z.object({ sessionId: z.string().min(1), samples: z.array(sample).max(500) });

  app.post("/mobile/delivery/location", async (req: any, reply: any) => {
    const ctx = await requireDriver(req, reply);
    if (!ctx) return;
    const parsed = locationBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const r = await ingestSamples(ctx.user.tenantId, parsed.data.sessionId, parsed.data.samples);
    if (!r.ok) return reply.status(409).send(r);
    return reply.send(r);
  });

  // Dispatcher: live map data (active runs + latest positions + movement status).
  app.get("/delivery/map", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const storeId = typeof req.query?.storeId === "string" ? req.query.storeId : undefined;
    return reply.send(await getDispatchMap(user.tenantId, storeId));
  });
}
