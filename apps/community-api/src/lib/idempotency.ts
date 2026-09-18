import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";

/**
 * `Idempotency-Key` on any mutating request: the first response is stored for
 * 24h and replayed byte-for-byte to a retry from the same person. A mobile
 * retry after a dropped connection therefore cannot double-connect, double-
 * quote or double-accept.
 */
export function registerIdempotency(app: FastifyInstance, db: Db) {
  app.addHook("preHandler", async (req, reply) => {
    const key = String(req.headers["idempotency-key"] || "").trim();
    if (!key || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
    const actor = (req as any).actor as { personId: string } | undefined;
    if (!actor) return;
    const scoped = `${actor.personId}:${key}`;
    const hit = await db.idempotencyKey.findUnique({ where: { key: scoped } });
    if (hit) {
      if (hit.method !== req.method || hit.path !== req.url.split("?")[0]) {
        return reply.status(422).send({
          error: "idempotency_key_reused",
          message: "That Idempotency-Key was already used for a different request.",
        });
      }
      reply.header("idempotent-replayed", "true");
      return reply.status(hit.statusCode).send(hit.response);
    }
    (req as any).idempotencyScopedKey = scoped;
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const scoped = (req as any).idempotencyScopedKey as string | undefined;
    if (!scoped || reply.statusCode >= 500) return payload;
    const actor = (req as any).actor as { personId: string };
    let body: unknown = null;
    try {
      body = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      body = { raw: String(payload) };
    }
    await db.idempotencyKey
      .create({
        data: {
          key: scoped,
          personId: actor.personId,
          method: req.method,
          path: req.url.split("?")[0],
          statusCode: reply.statusCode,
          response: body as object,
        },
      })
      .catch(() => undefined);
    return payload;
  });
}

export async function sweepIdempotencyKeys(db: Db) {
  await db.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });
}
