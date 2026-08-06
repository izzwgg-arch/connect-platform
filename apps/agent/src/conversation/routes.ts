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
import type { ChatUploadStore } from "../attachments/uploadStore";
import { verifyPortalJwt, type AgentIdentity } from "../auth";
import { elevateForCustomOwnerRole } from "../authRoles";

const Identity = z.object({
  tenantId: z.string().min(1),
  clientUserId: z.string().min(1).nullable(),
  role: z.enum(["owner", "customer"]),
});

export function resolveIdentity(req: FastifyRequest): AgentIdentity | null {
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

export function registerChatRoutes(
  app: FastifyInstance,
  engine: ConversationEngine,
  uploads: ChatUploadStore | null = null,
  /** Reads User.uiLanguage so someone whose account is set to Yiddish is
   *  answered in Yiddish even when they type in English. Optional: without it
   *  the engine falls back to detecting the language of each message. */
  prisma: any = null,
) {
  app.post("/agent/chat/message", async (req, reply) => {
    const identity = resolveIdentity(req);
    if (!identity) return reply.code(403).send({ error: "forbidden" });
    // SUPER_ADMIN / TENANT_ADMIN arrive in the JWT, but a custom role named
    // "owner" cannot — it needs a DB read, so top it up here. Fails closed:
    // any lookup error leaves the JWT's role untouched.
    const role = await elevateForCustomOwnerRole(prisma, identity);
    const body = z
      .object({
        text: z.string().min(1).max(8000),
        channel: z.string().optional(),
        /** Finished upload ids from /agent/chat/upload/finish (this session). */
        attachments: z.array(z.string().min(1).max(64)).max(10).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Attachment ids resolve ONLY within the caller's own tenant — an id from
    // another tenant simply doesn't exist here.
    const attachments = (body.data.attachments ?? [])
      .map((id) => uploads?.get(id, identity.tenantId) ?? null)
      .filter((a): a is NonNullable<typeof a> => a !== null);
    // Someone who set their account to Yiddish should not have to write
    // Yiddish to be answered in it. Failure here is non-fatal — the engine
    // just falls back to detecting the message's own language.
    let preferredLanguage: "en" | "yi" | undefined;
    if (prisma && identity.clientUserId) {
      try {
        const u = await prisma.user.findUnique({ where: { id: identity.clientUserId }, select: { uiLanguage: true } });
        if (u?.uiLanguage === "yi") preferredLanguage = "yi";
      } catch { /* fall back to detection */ }
    }
    return engine.handleMessage({ ...identity, role, channel: body.data.channel, preferredLanguage }, body.data.text, attachments);
  });

  // ── Chunked file upload (chat widget). nginx caps /agent-api/* bodies at
  // 10 MB, so files arrive as base64 chunks: init → chunk×N → finish. ──
  if (uploads) {
    app.post("/agent/chat/upload/init", async (req, reply) => {
      const identity = resolveIdentity(req);
      if (!identity) return reply.code(403).send({ ok: false, error: "forbidden" });
      const body = z
        .object({
          filename: z.string().min(1).max(200),
          mimeType: z.string().max(100).optional(),
          sizeBytes: z.number().int().positive(),
          totalChunks: z.number().int().positive(),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ ok: false, error: "bad_request" });
      const r = await uploads.init({
        tenantId: identity.tenantId,
        clientUserId: identity.clientUserId,
        filename: body.data.filename,
        mimeType: body.data.mimeType ?? "application/octet-stream",
        sizeBytes: body.data.sizeBytes,
        totalChunks: body.data.totalChunks,
      });
      if ("error" in r) return reply.code(400).send({ ok: false, error: r.error });
      return { ok: true, uploadId: r.uploadId };
    });

    app.post("/agent/chat/upload/chunk", async (req, reply) => {
      const identity = resolveIdentity(req);
      if (!identity) return reply.code(403).send({ ok: false, error: "forbidden" });
      const body = z
        .object({
          uploadId: z.string().min(1).max(64),
          index: z.number().int().min(0),
          dataBase64: z.string().min(4),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ ok: false, error: "bad_request" });
      const r = await uploads.addChunk({ tenantId: identity.tenantId, ...body.data });
      if ("error" in r) return reply.code(400).send({ ok: false, error: r.error });
      return { ok: true, received: r.received };
    });

    app.post("/agent/chat/upload/finish", async (req, reply) => {
      const identity = resolveIdentity(req);
      if (!identity) return reply.code(403).send({ ok: false, error: "forbidden" });
      const body = z.object({ uploadId: z.string().min(1).max(64) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ ok: false, error: "bad_request" });
      const r = await uploads.finish({ tenantId: identity.tenantId, uploadId: body.data.uploadId });
      if ("error" in r) return reply.code(400).send({ ok: false, error: r.error });
      const a = r.attachment;
      return { ok: true, attachment: { id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, kind: a.kind } };
    });
  }

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
