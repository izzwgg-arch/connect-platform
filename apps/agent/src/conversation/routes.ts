/**
 * Chat API — consumed by the portal (browser, Bearer JWT) and internal
 * server-to-server callers (x-agent-internal-secret).
 *
 * Identity resolution (strict order):
 *  1. Valid portal JWT (Authorization: Bearer) → identity DERIVED from the
 *     token. Any identity in the body is ignored — browsers are never trusted
 *     to assert who they are.
 *  2. Internal secret header → identity taken from body.identity (the caller
 *     is one of our own services which already authenticated the user).
 *  3. Neither → 403.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConversationEngine } from "./engine";
import { verifyPortalJwt, type AgentIdentity } from "../auth";

const Identity = z.object({
  tenantId: z.string().min(1),
  clientUserId: z.string().min(1).nullable(),
  role: z.enum(["owner", "customer"]),
});

function resolveIdentity(req: FastifyRequest): AgentIdentity | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const id = verifyPortalJwt(auth.slice(7));
    if (id) return id;
  }
  const secret = process.env.AGENT_INTERNAL_SECRET;
  if (secret && req.headers["x-agent-internal-secret"] === secret) {
    const body = (req.body ?? {}) as any;
    const parsed = Identity.safeParse(body.identity);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function registerChatRoutes(app: FastifyInstance, engine: ConversationEngine) {
  app.post("/agent/chat/message", async (req, reply) => {
    const identity = resolveIdentity(req);
    if (!identity) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ text: z.string().min(1).max(8000), channel: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return engine.handleMessage({ ...identity, channel: body.data.channel }, body.data.text);
  });

  app.post("/agent/chat/close", async (req, reply) => {
    const identity = resolveIdentity(req);
    if (!identity) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ conversationId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const ok = await engine.closeConversation(identity, body.data.conversationId);
    return ok ? { closed: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post("/agent/chat/history", async (req, reply) => {
    const identity = resolveIdentity(req);
    if (!identity) return reply.code(403).send({ error: "forbidden" });
    return engine.listHistory(identity);
  });

  app.post("/agent/chat/messages", async (req, reply) => {
    const identity = resolveIdentity(req);
    if (!identity) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ conversationId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const msgs = await engine.getMessages(identity, body.data.conversationId);
    return msgs === null ? reply.code(404).send({ error: "not_found" }) : { messages: msgs };
  });
}
