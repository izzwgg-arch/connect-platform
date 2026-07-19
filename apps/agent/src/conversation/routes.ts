/**
 * Chat API — consumed by the portal (server-side proxy) and later channels.
 * Auth model (Phase 1): the portal's API proxies requests with the shared
 * internal secret AGENT_INTERNAL_SECRET and asserts the caller's identity
 * (tenantId/userId/role) from its own session auth. The agent trusts only
 * that header, never client-supplied identity directly from browsers.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConversationEngine } from "./engine";

const Identity = z.object({
  tenantId: z.string().min(1),
  clientUserId: z.string().min(1).nullable(),
  role: z.enum(["owner", "customer"]),
});

const MessageBody = z.object({
  identity: Identity,
  text: z.string().min(1).max(8000),
  channel: z.string().optional(),
});

export function registerChatRoutes(app: FastifyInstance, engine: ConversationEngine) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/agent/chat")) return;
    const secret = process.env.AGENT_INTERNAL_SECRET;
    if (!secret || req.headers["x-agent-internal-secret"] !== secret) {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  app.post("/agent/chat/message", async (req, reply) => {
    const parsed = MessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", detail: parsed.error.issues });
    const { identity, text, channel } = parsed.data;
    const res = await engine.handleMessage({ ...identity, channel }, text);
    return res;
  });

  app.post("/agent/chat/close", async (req, reply) => {
    const body = z.object({ identity: Identity, conversationId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const ok = await engine.closeConversation(body.data.identity, body.data.conversationId);
    return ok ? { closed: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post("/agent/chat/history", async (req, reply) => {
    const body = z.object({ identity: Identity }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return engine.listHistory(body.data.identity);
  });

  app.post("/agent/chat/messages", async (req, reply) => {
    const body = z.object({ identity: Identity, conversationId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const msgs = await engine.getMessages(body.data.identity, body.data.conversationId);
    return msgs === null ? reply.code(404).send({ error: "not_found" }) : { messages: msgs };
  });
}
