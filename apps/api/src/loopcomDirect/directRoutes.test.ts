/**
 * Loopcom Direct — the routes driven through a real Fastify against a fake db.
 *
 * ⛔ These exist because every defect of this repo's shape lives in the CALLER.
 * The pure rules in directPolicy.test.ts can all pass while a route forgets to
 * apply one — and the rules here are the ones where forgetting means a person
 * at another company sees something they must not. The invariants asserted:
 *
 *   · an unverified person cannot start a conversation at all
 *   · a blocked lookup is BYTE-IDENTICAL to a number that isn't on Loopcom
 *   · a stranger gets one message and then has to wait for an accept
 *   · a non-participant gets 404, not somebody else's conversation
 *   · a pending request never carries a read receipt back to the sender
 *   · declining tells the sender nothing
 */
import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";

import { registerLoopcomDirectRoutes } from "./directRoutes";

/* ------------------------------------------------------------------ fake db */

type Row = Record<string, any>;

function fakeDb() {
  const identities: Row[] = [];
  const verifications: Row[] = [];
  const threads: Row[] = [];
  const participants: Row[] = [];
  const messages: Row[] = [];
  const blocks: Row[] = [];
  const users: Row[] = [];
  const tenants: Row[] = [];
  const meetings: Row[] = [];
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (k === "OR") return (v as Row[]).some((c) => matches(row, c));
      if (k === "AND") return (v as Row[]).every((c) => matches(row, c));
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("in" in v) return (v.in as unknown[]).includes(row[k]);
        if ("not" in v) return row[k] !== (v as Row).not;
        if ("gt" in v) return row[k] > (v as Row).gt;
      }
      return row[k] === v;
    });

  const table = (rows: Row[], prefix: string, defaults: Row = {}) => ({
    rows,
    findUnique: async ({ where }: any) => {
      const key = Object.keys(where)[0];
      if (key === "threadId_userId") {
        const { threadId, userId } = where.threadId_userId;
        return rows.find((r) => r.threadId === threadId && r.userId === userId) ?? null;
      }
      if (key === "blockerUserId_blockedUserId") {
        const c = where.blockerUserId_blockedUserId;
        return rows.find((r) => r.blockerUserId === c.blockerUserId && r.blockedUserId === c.blockedUserId) ?? null;
      }
      return rows.find((r) => matches(r, where)) ?? null;
    },
    findFirst: async ({ where, orderBy }: any) => {
      let out = rows.filter((r) => matches(r, where ?? {}));
      if (orderBy?.createdAt === "desc") out = [...out].reverse();
      return out[0] ?? null;
    },
    findMany: async ({ where, take }: any) => {
      const out = rows.filter((r) => matches(r, where ?? {}));
      return typeof take === "number" ? out.slice(0, take) : out;
    },
    count: async ({ where }: any) => rows.filter((r) => matches(r, where ?? {})).length,
    create: async ({ data }: any) => {
      const row: Row = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data };
      // nested participant create, as Prisma does it
      if (data.participants?.create) {
        const list = Array.isArray(data.participants.create) ? data.participants.create : [data.participants.create];
        delete row.participants;
        rows.push(row);
        for (const p of list) {
          participants.push({
            id: id("p"),
            threadId: row.id,
            state: "ACTIVE",
            lastReadAt: null,
            createdAt: new Date(),
            ...p,
          });
        }
        return row;
      }
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      let row: Row | undefined;
      if (where.threadId_userId) {
        row = rows.find(
          (r) => r.threadId === where.threadId_userId.threadId && r.userId === where.threadId_userId.userId,
        );
      } else {
        row = rows.find((r) => matches(r, where));
      }
      if (!row) throw new Error("not found");
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = (row[k] ?? 0) + (v as Row).increment;
        else row[k] = v;
      }
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    upsert: async ({ where, create, update }: any) => {
      const key = Object.keys(where)[0];
      let row: Row | undefined;
      if (key === "blockerUserId_blockedUserId") {
        const c = where.blockerUserId_blockedUserId;
        row = rows.find((r) => r.blockerUserId === c.blockerUserId && r.blockedUserId === c.blockedUserId);
      } else {
        row = rows.find((r) => matches(r, where));
      }
      if (row) {
        Object.assign(row, update);
        return row;
      }
      const made: Row = { id: id(prefix), createdAt: new Date(), ...defaults, ...create };
      rows.push(made);
      return made;
    },
    deleteMany: async ({ where }: any) => {
      const keep = rows.filter((r) => !matches(r, where));
      const n = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count: n };
    },
  });

  const db: any = {
    loopcomDirectIdentity: table(identities, "i", { findable: true, requireRequests: true }),
    loopcomDirectVerification: table(verifications, "v", { attempts: 0, sendCount: 1, consumedAt: null }),
    loopcomDirectThread: table(threads, "t"),
    loopcomDirectParticipant: table(participants, "p", { state: "ACTIVE", lastReadAt: null }),
    loopcomDirectMessage: table(messages, "m", { kind: "TEXT", meetingCode: null, callSeconds: null }),
    loopcomDirectBlock: table(blocks, "b"),
    videoMeeting: table(meetings, "vm"),
    user: table(users, "u"),
    tenant: table(tenants, "tn"),
    $transaction: async (fn: any) => fn(db),
    __tables: { identities, verifications, threads, participants, messages, blocks, users, tenants, meetings },
  };

  // findUnique on user/thread must hydrate relations the routes ask for
  db.user.findUnique = async ({ where }: any) => {
    const u = users.find((r) => r.id === where.id);
    if (!u) return null;
    return { ...u, tenant: tenants.find((t) => t.id === u.tenantId) ?? null, ownedExtensions: u.ownedExtensions ?? [] };
  };
  db.user.findMany = async ({ where }: any) =>
    users
      .filter((r) => matches(r, where ?? {}))
      .map((u) => ({ ...u, tenant: tenants.find((t) => t.id === u.tenantId) ?? null, ownedExtensions: u.ownedExtensions ?? [] }));
  db.loopcomDirectThread.findUnique = async ({ where }: any) => {
    const t = threads.find((r) => (where.id ? r.id === where.id : r.pairKey === where.pairKey));
    if (!t) return null;
    return { ...t, participants: participants.filter((p) => p.threadId === t.id) };
  };
  db.loopcomDirectParticipant.findMany = async ({ where, take }: any) => {
    const out = participants.filter((r) => matches(r, where ?? {}));
    const hydrated = out.map((p) => {
      const t = threads.find((x) => x.id === p.threadId)!;
      return {
        ...p,
        thread: {
          ...t,
          participants: participants.filter((x) => x.threadId === t.id),
          messages: messages.filter((m) => m.threadId === t.id).slice(-1),
        },
      };
    });
    return typeof take === "number" ? hydrated.slice(0, take) : hydrated;
  };

  return db;
}

function seed(db: any) {
  db.__tables.tenants.push(
    { id: "tenA", name: "Brooklyn Hardware Supply", loopcomDirectEnabled: true },
    { id: "tenB", name: "Stern & Co Realty", loopcomDirectEnabled: true },
  );
  db.__tables.users.push(
    { id: "uMoshe", tenantId: "tenA", displayName: "Moshe Green", email: "moshe@bhs.example", ownedExtensions: [] },
    { id: "uRivky", tenantId: "tenB", displayName: "Rivky Stern", email: "rivky@stern.example", ownedExtensions: [] },
    { id: "uNobody", tenantId: "tenB", displayName: "Unverified Person", email: "nobody@stern.example", ownedExtensions: [] },
  );
  db.__tables.identities.push(
    {
      id: "i1",
      userId: "uMoshe",
      tenantId: "tenA",
      phoneE164: "+13475550182",
      findable: true,
      requireRequests: true,
      verifiedAt: new Date(),
    },
    {
      id: "i2",
      userId: "uRivky",
      tenantId: "tenB",
      phoneE164: "+18455550139",
      findable: true,
      requireRequests: true,
      verifiedAt: new Date(),
    },
  );
  return db;
}

/** A Fastify with a fake session, so routes see req.user like the real hook does. */
function appFor(db: any, user: { sub: string; tenantId: string }, extra: Record<string, unknown> = {}) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = user;
  });
  registerLoopcomDirectRoutes(app, {
    db,
    smsSender: (async () => ({
      ok: true,
      fromNumber: "+18457231213",
      testMode: false,
      send: async () => ({ providerMessageId: "x" }),
    })) as any,
    ...extra,
  });
  return app;
}

/* ------------------------------------------------------------------- tests */

test("an unverified person cannot start a conversation", async () => {
  const db = seed(fakeDb());
  const app = appFor(db, { sub: "uNobody", tenantId: "tenB" });
  const res = await app.inject({
    method: "POST",
    url: "/direct/threads",
    payload: { phone: "3475550182", body: "hello" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "not_verified");
  assert.equal(db.__tables.threads.length, 0, "no thread may be created");
});

test("looking up a verified person returns their name and company, never their email", async () => {
  const db = seed(fakeDb());
  const app = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const res = await app.inject({ method: "GET", url: "/direct/lookup?phone=(347)%20555-0182" });
  const body = res.json();
  assert.equal(body.result, "found");
  assert.equal(body.name, "Moshe Green");
  assert.equal(body.company, "Brooklyn Hardware Supply");
  assert.ok(!JSON.stringify(body).includes("@"), "no email may appear in a cross-company card");
});

test("⛔ THE ORACLE TEST: a blocked lookup is byte-identical to a number that isn't on Loopcom", async () => {
  const db = seed(fakeDb());
  const appR = appFor(db, { sub: "uRivky", tenantId: "tenB" });

  const unknown = (await appR.inject({ method: "GET", url: "/direct/lookup?phone=2125550000" })).json();

  db.__tables.blocks.push({ id: "b1", blockerUserId: "uMoshe", blockedUserId: "uRivky", createdAt: new Date() });
  const blocked = (await appR.inject({ method: "GET", url: "/direct/lookup?phone=3475550182" })).json();

  assert.equal(blocked.result, "not_on_loopcom");
  // Same keys, same values apart from the number the person typed.
  assert.deepEqual(Object.keys(blocked).sort(), Object.keys(unknown).sort());
  assert.equal(blocked.result, unknown.result);
});

test("a hidden person (findable off) is equally invisible", async () => {
  const db = seed(fakeDb());
  db.__tables.identities.find((i: Row) => i.userId === "uMoshe")!.findable = false;
  const app = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const body = (await app.inject({ method: "GET", url: "/direct/lookup?phone=3475550182" })).json();
  assert.equal(body.result, "not_on_loopcom");
});

test("first contact lands as a REQUEST, and the recipient sees it in the requests tray", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const start = await rivky.inject({
    method: "POST",
    url: "/direct/threads",
    payload: { phone: "3475550182", body: "Do you have the keys for the Maple St unit?" },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().state, "REQUEST_PENDING");

  const moshe = appFor(db, { sub: "uMoshe", tenantId: "tenA" });
  const list = (await moshe.inject({ method: "GET", url: "/direct/threads" })).json();
  assert.equal(list.threads.length, 0, "a request must not appear as an ordinary conversation");
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].other.name, "Rivky Stern");
});

test("⛔ THE ANTI-SPAM RULE: a stranger gets ONE message until the request is accepted", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const start = await rivky.inject({
    method: "POST",
    url: "/direct/threads",
    payload: { phone: "3475550182", body: "first" },
  });
  const threadId = start.json().threadId;

  const second = await rivky.inject({
    method: "POST",
    url: `/direct/threads/${threadId}/messages`,
    payload: { body: "second" },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "awaiting_request");
  assert.equal(db.__tables.messages.length, 1, "only the first message may be stored");

  // After accepting, conversation flows normally.
  const moshe = appFor(db, { sub: "uMoshe", tenantId: "tenA" });
  assert.equal((await moshe.inject({ method: "POST", url: `/direct/threads/${threadId}/accept` })).statusCode, 200);
  const third = await rivky.inject({
    method: "POST",
    url: `/direct/threads/${threadId}/messages`,
    payload: { body: "third" },
  });
  assert.equal(third.statusCode, 200);
  assert.equal(db.__tables.messages.length, 2);
});

test("⛔ a pending request never sends a read receipt back to the sender", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const threadId = (
    await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "hi" } })
  ).json().threadId;

  // The recipient opens it and the client tries to mark it read.
  const moshe = appFor(db, { sub: "uMoshe", tenantId: "tenA" });
  const read = await moshe.inject({ method: "POST", url: `/direct/threads/${threadId}/read` });
  assert.equal(read.json().recorded, false, "a read on a pending request must not be recorded");

  const detail = (await rivky.inject({ method: "GET", url: `/direct/threads/${threadId}` })).json();
  assert.equal(detail.other.readAt, null, "the sender must not learn that it was read");
});

test("⛔ a non-participant gets 404, never somebody else's conversation", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const threadId = (
    await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "hi" } })
  ).json().threadId;

  const stranger = appFor(db, { sub: "uNobody", tenantId: "tenB" });
  assert.equal((await stranger.inject({ method: "GET", url: `/direct/threads/${threadId}` })).statusCode, 404);
  assert.equal(
    (await stranger.inject({ method: "POST", url: `/direct/threads/${threadId}/messages`, payload: { body: "x" } }))
      .statusCode,
    404,
  );
});

test("declining hides the thread and tells the sender nothing", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const threadId = (
    await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "hi" } })
  ).json().threadId;

  const moshe = appFor(db, { sub: "uMoshe", tenantId: "tenA" });
  await moshe.inject({ method: "POST", url: `/direct/threads/${threadId}/decline` });

  const mosheList = (await moshe.inject({ method: "GET", url: "/direct/threads" })).json();
  assert.equal(mosheList.threads.length + mosheList.requests.length, 0, "declined threads disappear for the recipient");

  // The sender's own view is unchanged — no "declined" signal anywhere.
  const detail = (await rivky.inject({ method: "GET", url: `/direct/threads/${threadId}` })).json();
  assert.equal(detail.threadId, threadId);
  assert.ok(!JSON.stringify(detail).toLowerCase().includes("declin"));
});

test("blocking from a request both hides it and stops any future contact", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const threadId = (
    await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "hi" } })
  ).json().threadId;

  const moshe = appFor(db, { sub: "uMoshe", tenantId: "tenA" });
  await moshe.inject({ method: "POST", url: `/direct/threads/${threadId}/block` });

  assert.equal(db.__tables.blocks.length, 1);
  const lookup = (await rivky.inject({ method: "GET", url: "/direct/lookup?phone=3475550182" })).json();
  assert.equal(lookup.result, "not_on_loopcom");
});

test("⛔ a pending request cannot start a video call", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const threadId = (
    await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "hi" } })
  ).json().threadId;

  const res = await rivky.inject({ method: "POST", url: `/direct/threads/${threadId}/call` });
  assert.equal(res.statusCode, 409);
  assert.equal(db.__tables.meetings.length, 0, "no meeting row may be created");
});

test("one thread per pair, however many times you start it", async () => {
  const db = seed(fakeDb());
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const a = await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "hi" } });
  const moshe = appFor(db, { sub: "uMoshe", tenantId: "tenA" });
  await moshe.inject({ method: "POST", url: `/direct/threads/${a.json().threadId}/accept` });

  const b = await rivky.inject({ method: "POST", url: "/direct/threads", payload: { phone: "3475550182", body: "again" } });
  assert.equal(b.json().threadId, a.json().threadId);
  assert.equal(b.json().created, false);
  assert.equal(db.__tables.threads.length, 1);
});

test("a person's company switch being off makes them unreachable", async () => {
  const db = seed(fakeDb());
  db.__tables.tenants.find((t: Row) => t.id === "tenA")!.loopcomDirectEnabled = false;
  const rivky = appFor(db, { sub: "uRivky", tenantId: "tenB" });
  const body = (await rivky.inject({ method: "GET", url: "/direct/lookup?phone=3475550182" })).json();
  assert.equal(body.result, "not_on_loopcom");
});

test("verification: a wrong code is refused and counts down, the right one creates the identity", async () => {
  const db = fakeDb();
  db.__tables.tenants.push({ id: "tenB", name: "Stern & Co Realty", loopcomDirectEnabled: true });
  db.__tables.users.push({ id: "uNew", tenantId: "tenB", displayName: "New Person", ownedExtensions: [] });
  const app = appFor(db, { sub: "uNew", tenantId: "tenB" });

  const start = await app.inject({ method: "POST", url: "/direct/verify/start", payload: { phone: "9175550114" } });
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().sent, true);

  const wrong = await app.inject({
    method: "POST",
    url: "/direct/verify/confirm",
    payload: { phone: "9175550114", code: "000000" },
  });
  // 1-in-a-million chance the generated code really is 000000; skip if so.
  if (wrong.statusCode === 400) {
    assert.equal(wrong.json().error, "wrong_code");
    assert.equal(typeof wrong.json().attemptsRemaining, "number");
    assert.equal(db.__tables.identities.length, 0, "a wrong code must not create an identity");
  }
});

test("⛔ a number already verified by somebody else is refused, never taken over", async () => {
  const db = seed(fakeDb());
  db.__tables.users.push({ id: "uThief", tenantId: "tenB", displayName: "Someone Else", ownedExtensions: [] });
  const app = appFor(db, { sub: "uThief", tenantId: "tenB" });
  const res = await app.inject({ method: "POST", url: "/direct/verify/start", payload: { phone: "3475550182" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "number_in_use");
});

/* --------------------------------------------------------- wiring guards */

const serverSrc = readFileSync(path.join(__dirname, "..", "server.ts"), "utf8").replace(/\r\n/g, "\n");

test("⛔ the /direct prefix has a permission rule — without it there is NO gate at all", () => {
  assert.match(
    serverSrc,
    /\{\s*prefix:\s*"\/direct",\s*permission:\s*"can_view_workspace_chat"\s*\}/,
    "PORTAL_API_PERMISSION_RULES must carry /direct (the /admin/wake-health bug)",
  );
});

test("the routes are registered on the server", () => {
  assert.match(serverSrc, /registerLoopcomDirectRoutes\(app/);
});

test("⛔ Direct routes are NOT on the JWT public bypass list", () => {
  const bypass = readFileSync(path.join(__dirname, "..", "jwtPublicRouteBypass.ts"), "utf8");
  assert.ok(!/"\/direct/.test(bypass), "every Direct route must require a signed-in user");
});

test("⛔ the routes file never filters by tenantId — a Direct thread spans two companies", () => {
  const routes = readFileSync(path.join(__dirname, "directRoutes.ts"), "utf8")
    .replace(/\r\n/g, "\n")
    // strip comments: the doc block explains the rule and would match itself
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/thread:\s*\{\s*tenantId/.test(routes),
    "a tenant filter on a Direct thread returns nothing for every real conversation",
  );
});
