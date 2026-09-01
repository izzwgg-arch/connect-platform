/**
 * DIRECT MESSAGES between LoopCom support and the person who filed a ticket.
 *
 *   POST /admin/support/escalations/:reference/message   an admin writes to them
 *   GET  /admin/support/escalations/:reference/messages  the thread, admin side
 *   GET  /support/messages                               the customer's widget polls
 *   POST /support/messages/:id/read                      they opened it
 *   POST /support/messages/reply                         they wrote back
 *
 * ⛔⛔ WHY THIS EXISTS: the desk's old "reply" posted into the assistant
 * CONVERSATION (`/admin/support/conversations/:id/message`), and NOTHING ever
 * told the customer — the widget only shows a conversation while they are
 * actively chatting in it, and Report-a-problem tickets have no conversation at
 * all. Izzy replied to a real ticket and the customer never got it
 * (2026-09-01). These rows are what the widget polls and notifies on, so a
 * message here is a message the customer is actually TOLD about.
 *
 * ⛔ An admin message is a HUMAN'S OWN WORDS, so it does not go through the
 * OpenAI rewrite or the safety gate — those exist because a model's rewrite
 * cannot be trusted; a person signing their own message can be. It is still
 * audited (sentByUserId) and still scoped to the ticket's own customer.
 *
 * ⛔ The customer routes select fields explicitly. `sentByUserId` and anything
 * internal never reach a customer response.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveEscalationId } from "./customerUpdateRoutes";

type JwtUser = { sub?: string; tenantId?: string };

export type SupportMessageRouteDeps = {
  db: any;
  /** The support console's own SUPER_ADMIN gate, injected so there is ONE implementation. */
  requireSuper: (req: any, reply: any) => Promise<any> | any;
  log?: { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };
};

/** ⛔ Bounded: a customer reply box must not become a spam channel into the desk. */
export const CUSTOMER_REPLIES_PER_DAY = 20;
export const MAX_MESSAGE_CHARS = 2000;

/** The explicit projection a customer may see. A test pins that it never grows internals. */
const CUSTOMER_FIELDS = {
  id: true,
  ticketRef: true,
  direction: true,
  body: true,
  createdAt: true,
  readAt: true,
} as const;

export function registerSupportMessageRoutes(app: FastifyInstance, deps: SupportMessageRouteDeps): void {
  const { db } = deps;

  /** An admin writes to the customer on a ticket. Works with or without a chat. */
  app.post("/admin/support/escalations/:reference/message", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const reference = String((req.params as any)?.reference ?? "").trim();
    const parsed = z
      .object({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) })
      .safeParse(req.body || {});
    if (!reference || !parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        message: `Write a message first — up to ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`,
      });
    }

    const escalationId = await resolveEscalationId(db, reference);
    const esc = escalationId
      ? await db.agentEscalation.findUnique({
          where: { id: escalationId },
          select: { id: true, tenantId: true, clientUserId: true, conversationId: true },
        })
      : null;
    if (!esc) {
      return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    }
    // ⛔ A platform alarm has no person on the other end. Refusing here is what
    // keeps this a customer channel rather than a notes field.
    if (!esc.clientUserId) {
      return reply.status(409).send({
        error: "not_applicable",
        message: "That ticket is a platform alarm — there is no customer to message.",
      });
    }

    const row = await db.supportMessage.create({
      data: {
        tenantId: esc.tenantId,
        userId: esc.clientUserId,
        escalationId: esc.id,
        ticketRef: reference.toUpperCase(),
        conversationId: esc.conversationId ?? null,
        direction: "to_customer",
        body: parsed.data.message,
        sentByUserId: String(actor.sub ?? "") || null,
      },
      select: { id: true, createdAt: true },
    });

    // Mirror into the assistant conversation when one exists, so a customer who
    // is actively chatting sees it inline immediately. ⛔ Best-effort ONLY: the
    // SupportMessage above is the channel that notifies; losing the mirror
    // loses nothing the customer depends on.
    if (esc.conversationId) {
      await db.agentMessage
        .create({
          data: { conversationId: esc.conversationId, role: "staff", content: parsed.data.message, model: "human" },
        })
        .catch(() => {});
    }

    deps.log?.info?.({ reference, messageId: row.id }, "support-message: sent to the customer");
    return reply.send({ ok: true, id: row.id, at: row.createdAt });
  });

  /** The thread for one ticket, admin side. Reading it marks the customer's replies read. */
  app.get("/admin/support/escalations/:reference/messages", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const reference = String((req.params as any)?.reference ?? "").trim();
    const escalationId = reference ? await resolveEscalationId(db, reference) : null;
    if (!escalationId) {
      return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    }

    const rows = await db.supportMessage.findMany({
      where: { escalationId },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    // An admin looking at the thread IS reading the replies — this is what the
    // "a customer replied and nobody read it" guardrail counts against.
    await db.supportMessage
      .updateMany({
        where: { escalationId, direction: "from_customer", readAt: null },
        data: { readAt: new Date() },
      })
      .catch(() => {});
    return reply.send({ messages: rows });
  });

  /**
   * What the customer's widget polls (piggybacked on the same 2-minute tick as
   * /support/updates). Serving a message IS delivering it.
   */
  app.get("/support/messages", async (req: any, reply: any) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    const rows = await db.supportMessage.findMany({
      where: { userId: user.sub, tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: CUSTOMER_FIELDS,
    });
    await db.supportMessage
      .updateMany({
        where: { userId: user.sub, tenantId: user.tenantId, direction: "to_customer", deliveredAt: null },
        data: { deliveredAt: new Date() },
      })
      .catch(() => {
        /* the message on screen is worth more than the bookkeeping */
      });
    return reply.send({ messages: rows });
  });

  /** They opened it — the pop-up beside the bubble stands down. */
  app.post("/support/messages/:id/read", async (req: any, reply: any) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    await db.supportMessage.updateMany({
      where: {
        id: String((req.params as any)?.id ?? ""),
        userId: user.sub,
        tenantId: user.tenantId,
        direction: "to_customer",
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return reply.send({ ok: true });
  });

  /** The customer writes back. Lands on the desk and in the maintenance view. */
  app.post("/support/messages/reply", async (req: any, reply: any) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    const parsed = z
      .object({
        message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
        replyToId: z.string().trim().max(64).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Write a message first." });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sentToday = await db.supportMessage.count({
      where: { userId: user.sub, direction: "from_customer", createdAt: { gte: today } },
    });
    if (sentToday >= CUSTOMER_REPLIES_PER_DAY) {
      return reply.status(429).send({
        error: "too_many",
        message: "You've sent quite a few messages today — call us at (845) 723-1213 and a person will help right away.",
      });
    }

    // ⛔ Scoped: a reply can only thread onto a message that is THEIRS.
    const parent = parsed.data.replyToId
      ? await db.supportMessage.findFirst({
          where: { id: parsed.data.replyToId, userId: user.sub, tenantId: user.tenantId },
          select: { escalationId: true, ticketRef: true, conversationId: true },
        })
      : null;

    const row = await db.supportMessage.create({
      data: {
        tenantId: user.tenantId,
        userId: user.sub,
        escalationId: parent?.escalationId ?? null,
        ticketRef: parent?.ticketRef ?? null,
        conversationId: parent?.conversationId ?? null,
        direction: "from_customer",
        body: parsed.data.message,
      },
      select: { id: true, createdAt: true },
    });
    deps.log?.info?.({ messageId: row.id, ticketRef: parent?.ticketRef ?? null }, "support-message: customer replied");
    return reply.send({ ok: true, id: row.id });
  });
}
