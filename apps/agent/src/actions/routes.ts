/**
 * Approval routes. One-tap email links (signed token) + portal (owner JWT).
 * GET /agent/approve?token=... — from email; redeems the signed decision.
 * POST /agent/actions/decide — from the portal Approvals page (owner JWT).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ActionService } from "./service";
import { verifyPortalJwt } from "../auth";

export function registerActionRoutes(app: FastifyInstance, actions: ActionService) {
  app.get("/agent/approve", async (req, reply) => {
    const token = (req.query as any)?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "missing_token" });
    // X1: service-level redemption enforces params-hash binding for modify/repair
    // actions (a legacy token can never decide a bound action).
    const res = await actions.redeemEmailDecision(token);
    if (!res.ok) return reply.code(403).type("text/html").send("<h3>This approval link is invalid, expired, or does not match the requested change.</h3>");
    return reply.type("text/html").send(`<h3>Action ${res.decision === "approve" ? "approved ✅" : "denied ✕"}.</h3><p>You can close this window.</p>`);
  });

  app.post("/agent/actions/decide", async (req, reply) => {
    const auth = req.headers.authorization;
    const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
    if (!id || id.role !== "owner") return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ actionId: z.string(), decision: z.enum(["approve", "deny"]), reason: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const who = `owner:${id.clientUserId}`;
    const res = body.data.decision === "approve" ? await actions.approve(body.data.actionId, who) : await actions.deny(body.data.actionId, who, body.data.reason);
    return { status: res.status };
  });
}
