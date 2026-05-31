import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveInboundCrmCallerForViewer } from "./inboundCallerMatch";

const matchBodySchema = z.object({
  tenantId: z.string().min(1),
  phone: z.string().min(4),
  viewer: z.object({
    userId: z.string().min(1),
    role: z.string().optional(),
  }),
});

export type VerifyInternalSecret = (req: unknown) => boolean;

/**
 * Internal route for telephony WS enrichment (CDR_INGEST_SECRET).
 * POST /internal/telephony/inbound-crm-match
 */
export function registerInboundCrmMatchInternalRoute(
  app: FastifyInstance,
  verifyInternalSecret: VerifyInternalSecret,
): void {
  app.post("/internal/telephony/inbound-crm-match", async (req, reply) => {
    if (!verifyInternalSecret(req)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const parsed = matchBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const match = await resolveInboundCrmCallerForViewer({
      tenantId: parsed.data.tenantId,
      phone: parsed.data.phone,
      viewer: parsed.data.viewer,
    });
    return { match };
  });
}
