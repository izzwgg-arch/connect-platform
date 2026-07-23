// Voice/IVR routes (Phase 8). INTERNAL/READ-ONLY, secret-gated. Returns a prerecorded-fragment
// voice plan for a caller. Writes NOTHING to the PBX. The delivery IVR dialplan branch (AstDB)
// is a SEPARATE, explicitly-approved step — this phase does not modify the PBX in any way.

import { verifyOrderSourceSecret } from "./guard";
import { resolveVoiceStatus } from "./voiceService";

export async function registerDeliveryVoiceRoutes(app: any): Promise<void> {
  app.post("/internal/delivery/voice/resolve", async (req: any, reply: any) => {
    if (!verifyOrderSourceSecret(req)) return reply.status(401).send({ error: "unauthorized" });
    const tenantId = String(req.headers?.["x-tenant-id"] || req.body?.tenantId || "");
    if (!tenantId) return reply.status(400).send({ error: "tenant_required" });
    const result = await resolveVoiceStatus({
      tenantId,
      callerId: req.body?.callerId ? String(req.body.callerId) : undefined,
      digits: req.body?.digits ? String(req.body.digits) : undefined,
      afterHours: Boolean(req.body?.afterHours),
    });
    return reply.send(result);
  });
}
