/**
 * Direct support↔customer messages — the channel that actually notifies.
 *
 * ⛔ What these defend, in order of cost:
 *   1. A message to the WRONG customer, or one customer reading another's.
 *   2. A "sent" reply that reaches nobody — the exact bug this replaces
 *      (the desk wrote into the assistant conversation and nothing told the
 *      customer, 2026-09-01).
 *   3. Internals (sentByUserId, escalation ids) leaking to a customer response.
 *   4. The reply box becoming a spam channel into the desk.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { registerSupportMessageRoutes, CUSTOMER_REPLIES_PER_DAY } from "./supportMessageRoutes";
import { supportReportReference } from "@connect/shared";

type Row = Record<string, any>;

const ESC_ID = "esc_customer_0001x";
const REF = supportReportReference(ESC_ID).toUpperCase();

function fakeDb(seed: { escalations?: Row[]; messages?: Row[] } = {}) {
  const messages: Row[] = [...(seed.messages ?? [])];
  const agentMessages: Row[] = [];
  const escalations: Row[] = seed.escalations ?? [
    { id: ESC_ID, tenantId: "t1", clientUserId: "u-customer", conversationId: "conv1" },
  ];
  let nextId = 1;
  const matches = (m: Row, where: any): boolean => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v && typeof v === "object" && "in" in (v as any)) {
        if (!(v as any).in.includes(m[k])) return false;
      } else if (v && typeof v === "object" && "gte" in (v as any)) {
        if (!(new Date(m[k]) >= (v as any).gte)) return false;
      } else if (v === null) {
        if (m[k] != null) return false;
      } else if (m[k] !== v) return false;
    }
    return true;
  };
  return {
    messages,
    agentMessages,
    agentEscalation: {
      findMany: async () => escalations.map((e) => ({ id: e.id })),
      findUnique: async ({ where }: any) => escalations.find((e) => e.id === where.id) ?? null,
    },
    agentMessage: {
      create: async ({ data }: any) => {
        agentMessages.push(data);
        return { id: "am" + agentMessages.length };
      },
    },
    supportMessage: {
      create: async ({ data }: any) => {
        const row = { id: "m" + nextId++, createdAt: new Date(), deliveredAt: null, readAt: null, ...data };
        messages.push(row);
        return row;
      },
      findMany: async ({ where, select, take }: any) => {
        let rows = messages.filter((m) => matches(m, where));
        if (take) rows = rows.slice(0, take);
        if (!select) return rows;
        return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
      },
      findFirst: async ({ where, select }: any) => {
        const r = messages.find((m) => matches(m, where));
        if (!r) return null;
        if (!select) return r;
        return Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]));
      },
      count: async ({ where }: any) => messages.filter((m) => matches(m, where)).length,
      updateMany: async ({ where, data }: any) => {
        const hit = messages.filter((m) => matches(m, where));
        hit.forEach((m) => Object.assign(m, data));
        return { count: hit.length };
      },
    },
  };
}

async function appWith(db: any, user: { sub: string; tenantId: string } | null = null, allowAdmin = true) {
  const app = Fastify();
  app.addHook("onRequest", async (req: any) => {
    req.user = user;
  });
  registerSupportMessageRoutes(app as any, {
    db,
    requireSuper: async (_req: any, reply: any) => {
      if (allowAdmin) return { sub: "izzy-admin" };
      reply.status(403).send({ error: "forbidden" });
      return null;
    },
  });
  await app.ready();
  return app;
}

describe("the admin sends a message", () => {
  test("it lands on the ticket's OWN customer, and mirrors into the chat", async () => {
    const db = fakeDb();
    const app = await appWith(db);
    const res = await app.inject({
      method: "POST",
      url: `/admin/support/escalations/${REF}/message`,
      payload: { message: "We found it — try again now." },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(db.messages.length, 1);
    assert.equal(db.messages[0].userId, "u-customer");
    assert.equal(db.messages[0].tenantId, "t1");
    assert.equal(db.messages[0].direction, "to_customer");
    assert.equal(db.messages[0].sentByUserId, "izzy-admin");
    // Mirrored into the conversation for anyone actively chatting.
    assert.equal(db.agentMessages.length, 1);
    assert.equal(db.agentMessages[0].role, "staff");
    await app.close();
  });

  test("⛔ a platform alarm is refused — there is no customer to message", async () => {
    const db = fakeDb({ escalations: [{ id: ESC_ID, tenantId: "t1", clientUserId: null, conversationId: null }] });
    const app = await appWith(db);
    const res = await app.inject({
      method: "POST",
      url: `/admin/support/escalations/${REF}/message`,
      payload: { message: "hello?" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(db.messages.length, 0);
    await app.close();
  });

  test("⛔ a failed conversation mirror never loses the message itself", async () => {
    const db = fakeDb();
    db.agentMessage.create = async () => {
      throw new Error("conversation table is having a day");
    };
    const app = await appWith(db);
    const res = await app.inject({
      method: "POST",
      url: `/admin/support/escalations/${REF}/message`,
      payload: { message: "still gets through" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(db.messages.length, 1);
    await app.close();
  });
});

describe("the customer's side", () => {
  test("serving messages IS delivering them — deliveredAt is stamped", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t1", userId: "u-customer", direction: "to_customer", body: "hi", createdAt: new Date(), deliveredAt: null, readAt: null, ticketRef: REF },
      ],
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-customer", tenantId: "t1" });
    const res = await app.inject({ method: "GET", url: "/support/messages" });
    assert.equal(res.statusCode, 200);
    assert.ok(db.messages[0].deliveredAt, "serving should stamp deliveredAt");
    await app.close();
  });

  test("⛔ another customer's messages are invisible — scoped by userId AND tenantId", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t1", userId: "u-customer", direction: "to_customer", body: "private", createdAt: new Date(), deliveredAt: null, readAt: null },
      ],
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-OTHER", tenantId: "t1" });
    const res = await app.inject({ method: "GET", url: "/support/messages" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().messages.length, 0);
    await app.close();
  });

  test("⛔ the customer response never carries internals", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t1", userId: "u-customer", direction: "to_customer", body: "hi", createdAt: new Date(), deliveredAt: null, readAt: null, sentByUserId: "izzy-admin", escalationId: ESC_ID, conversationId: "conv1" },
      ],
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-customer", tenantId: "t1" });
    const body = JSON.stringify((await app.inject({ method: "GET", url: "/support/messages" })).json());
    assert.ok(!body.includes("sentByUserId"), "sentByUserId leaked");
    assert.ok(!body.includes("izzy-admin"), "the admin's id leaked");
    assert.ok(!body.includes("escalationId"), "escalationId leaked");
    await app.close();
  });

  test("a reply threads onto THEIR OWN message and lands from_customer", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t1", userId: "u-customer", direction: "to_customer", body: "hi", createdAt: new Date(), deliveredAt: null, readAt: null, escalationId: ESC_ID, ticketRef: REF, conversationId: null },
      ],
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-customer", tenantId: "t1" });
    const res = await app.inject({
      method: "POST",
      url: "/support/messages/reply",
      payload: { message: "It works now, thanks!", replyToId: "m1" },
    });
    assert.equal(res.statusCode, 200);
    const reply = db.messages.find((m: any) => m.direction === "from_customer");
    assert.ok(reply);
    assert.equal(reply.escalationId, ESC_ID);
    assert.equal(reply.ticketRef, REF);
    await app.close();
  });

  test("⛔ a reply cannot thread onto SOMEONE ELSE'S message", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t2", userId: "u-other", direction: "to_customer", body: "hi", createdAt: new Date(), deliveredAt: null, readAt: null, escalationId: "esc-foreign", ticketRef: "XXXXXX" },
      ],
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-customer", tenantId: "t1" });
    const res = await app.inject({
      method: "POST",
      url: "/support/messages/reply",
      payload: { message: "hijack attempt", replyToId: "m1" },
    });
    assert.equal(res.statusCode, 200);
    const reply = db.messages.find((m: any) => m.direction === "from_customer");
    assert.ok(reply);
    // The reply lands, but inherits NOTHING from the foreign message.
    assert.equal(reply.escalationId, null);
    assert.equal(reply.ticketRef, null);
    await app.close();
  });

  test("⛔ the reply box is capped per day, with a phone number in the refusal", async () => {
    const today = new Date();
    const db = fakeDb({
      messages: Array.from({ length: CUSTOMER_REPLIES_PER_DAY }, (_, i) => ({
        id: "r" + i, tenantId: "t1", userId: "u-customer", direction: "from_customer", body: "x", createdAt: today, deliveredAt: null, readAt: null,
      })),
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-customer", tenantId: "t1" });
    const res = await app.inject({ method: "POST", url: "/support/messages/reply", payload: { message: "one more" } });
    assert.equal(res.statusCode, 429);
    assert.match(res.json().message, /845/);
    await app.close();
  });

  test("read marks THEIR OWN message only", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t1", userId: "u-other", direction: "to_customer", body: "hi", createdAt: new Date(), deliveredAt: null, readAt: null },
      ],
      escalations: [],
    });
    const app = await appWith(db, { sub: "u-customer", tenantId: "t1" });
    await app.inject({ method: "POST", url: "/support/messages/m1/read", payload: {} });
    assert.equal(db.messages[0].readAt, null, "someone else's message must not be markable");
    await app.close();
  });

  test("⛔ signed out is 401, on every customer route", async () => {
    const db = fakeDb({ escalations: [] });
    const app = await appWith(db, null);
    for (const [method, url] of [
      ["GET", "/support/messages"],
      ["POST", "/support/messages/x/read"],
      ["POST", "/support/messages/reply"],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === "POST" ? { payload: { message: "x" } } : {}) });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
    await app.close();
  });
});

describe("the admin thread view", () => {
  test("reading the thread marks the customer's replies read — the guardrail's clock stops", async () => {
    const db = fakeDb({
      messages: [
        { id: "m1", tenantId: "t1", userId: "u-customer", direction: "from_customer", body: "hello?", createdAt: new Date(), deliveredAt: null, readAt: null, escalationId: ESC_ID },
      ],
    });
    const app = await appWith(db);
    const res = await app.inject({ method: "GET", url: `/admin/support/escalations/${REF}/messages` });
    assert.equal(res.statusCode, 200);
    assert.ok(db.messages[0].readAt, "viewing the thread should mark replies read");
    await app.close();
  });
});

// ───────────────────────────────────────────── the wiring, read from source

describe("⛔ SOURCE GUARDS — the callers, where this bug actually lived", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const stripLineComments = (s: string) =>
    s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

  test("server.ts registers the message routes", () => {
    const src = read(path.join(__dirname, "..", "server.ts"));
    assert.ok(src.includes("registerSupportMessageRoutes(app"), "the routes exist but nothing serves them");
  });

  test("⛔ the desk composer posts to the NOTIFIED channel, not the conversation", () => {
    // The defect was the CALLER: the composer wrote into the assistant
    // conversation, which nothing ever told the customer about.
    const desk = read(
      path.join(__dirname, "..", "..", "..", "portal", "app", "(platform)", "admin", "support", "SupportDesk.tsx"),
    );
    assert.ok(desk.includes("/message`, {\n        message:") || /escalations\/\$\{encodeURIComponent\(esc\.reference\)\}\/message/.test(desk),
      "the desk no longer posts to the support-message route");
    const code = stripLineComments(desk);
    assert.ok(!code.includes("no chat to reply into"), "the dead-end state is back — a ticket without a chat must still be messageable");
  });

  test("⛔ the widget polls the messages and pops up on unread ones", () => {
    const widget = read(path.join(__dirname, "..", "..", "..", "portal", "components", "FloatingAssistant.tsx"));
    assert.ok(widget.includes("/support/messages"), "the widget no longer polls support messages");
    assert.ok(widget.includes("fa-nudge"), "the pop-up beside the bubble is gone");
  });
});
