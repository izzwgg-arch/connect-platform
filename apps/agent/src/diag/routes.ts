/**
 * Diagnostics test route — Phase 1 certification path.
 * Capabilities here are status "built": they may ONLY be exercised by the
 * owner (JWT) or internal callers (secret) for testing/certification. They are
 * NOT exposed to customer chat until the certification harness flips them to
 * "certified" (PLAN.md §13a).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DiagnosticsEngine } from "./engine";
import { verifyPortalJwt } from "../auth";

export function registerDiagRoutes(app: FastifyInstance, diag: DiagnosticsEngine) {
  app.post("/agent/diag/run", async (req, reply) => {
    // Owner JWT or internal secret only.
    let requestedBy = "internal";
    const auth = req.headers.authorization;
    const secret = process.env.AGENT_INTERNAL_SECRET;
    const internal = secret && req.headers["x-agent-internal-secret"] === secret;
    if (!internal) {
      const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
      if (!id || id.role !== "owner") return reply.code(403).send({ error: "forbidden" });
      requestedBy = `owner:${id.clientUserId}`;
    }
    const body = z
      .object({ tenantId: z.string().min(1), extension: z.string().nullable().optional(), complaint: z.string().nullable().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const report = await diag.run(body.data.tenantId, body.data.extension ?? null, body.data.complaint ?? null, requestedBy);
    return report;
  });
}
