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
import { resolveAdminCaller } from "../adminAuth";

export function registerDiagRoutes(app: FastifyInstance, diag: DiagnosticsEngine) {
  app.post("/agent/diag/run", async (req, reply) => {
    // Admin JWT or internal secret only.
    let requestedBy = "internal";
    const secret = process.env.AGENT_INTERNAL_SECRET;
    const internal = secret && req.headers["x-agent-internal-secret"] === secret;
    let caller = null as ReturnType<typeof resolveAdminCaller>;
    if (!internal) {
      caller = resolveAdminCaller(req);
      if (!caller) return reply.code(403).send({ error: "forbidden" });
      requestedBy = `owner:${caller.clientUserId}`;
    }
    const body = z
      .object({ tenantId: z.string().min(1), extension: z.string().nullable().optional(), complaint: z.string().nullable().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // ⛔ A tenant admin may only diagnose THEIR OWN tenant. Diagnostics read that
    // tenant's devices, calls and voicemail, so a body-supplied tenantId that is
    // not the caller's own (and the caller is not staff / internal) is refused.
    if (caller && !caller.isStaff && body.data.tenantId !== caller.tenantId) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const report = await diag.run(body.data.tenantId, body.data.extension ?? null, body.data.complaint ?? null, requestedBy);
    return report;
  });
}
