/**
 * The Coworker workspace routes through a REAL Fastify with a REAL portal JWT —
 * identity, ownership (someone else's turn is 404), the turn lifecycle on
 * /agent/chat/message, and the voice route's engine choice.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerCoworkerUiRoutes, transcribeForCoworker, taskTitle } from "./uiRoutes";
import { registerChatRoutes } from "../conversation/routes";
import { ActivityHub } from "./activity";
import { CoworkerPrefsStore, DEFAULT_PREFS } from "./prefs";
import { AuditLog, FileAuditSink } from "../audit/audit";

const SECRET = "test-secret-coworker";
process.env.JWT_SECRET = SECRET;

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" });
  const body = b(payload);
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const U1 = `Bearer ${jwt({ sub: "u1", tenantId: "t1", role: "USER" })}`;
const U2 = `Bearer ${jwt({ sub: "u2", tenantId: "t1", role: "USER" })}`;
const T2 = `Bearer ${jwt({ sub: "u1", tenantId: "t2", role: "USER" })}`;

function fakePrisma() {
  const audit: any[] = [];
  const convs = [
    { id: "c-old", tenantId: "t1", clientUserId: "u1", startedAt: new Date(Date.now() - 2 * 86400_000), status: "CLOSED", closedAt: null, messages: [{ content: "Organize my Downloads folder\n[Attached: list.csv (1 KB)]" }] },
    { id: "c-theirs", tenantId: "t1", clientUserId: "u2", startedAt: new Date(), status: "OPEN", closedAt: null, messages: [{ content: "private" }] },
  ];
  return {
    audit,
    prisma: {
      agentConversation: {
        findMany: async ({ where }: any) => convs.filter((c) => c.tenantId === where.tenantId && c.clientUserId === where.clientUserId && c.startedAt >= where.startedAt.gte),
      },
      agentAuditLog: {
        create: async ({ data }: any) => { audit.push({ ...data, ts: data.ts ?? new Date() }); return data; },
        findFirst: async ({ where }: any) => [...audit].reverse().find((r) => r.event === where.event && r.tenantId === where.tenantId && r.payload?.userId === where.payload.equals) ?? null,
        findMany: async ({ where, take }: any) => [...audit].reverse().filter((r) => r.event === where.event && r.tenantId === where.tenantId && r.payload?.userId === where.payload.equals).slice(0, take),
      },
    },
  };
}

let app: ReturnType<typeof Fastify>;
let hub: ActivityHub;
let db: ReturnType<typeof fakePrisma>;
let engineCalls: any[];
let engineImpl: (ctx: any) => Promise<any>;

beforeEach(async () => {
  hub = new ActivityHub();
  db = fakePrisma();
  const audit = new AuditLog([new FileAuditSink(await mkdtemp(path.join(tmpdir(), "cw-routes-"))), { write: async (row: any) => { await db.prisma.agentAuditLog.create({ data: row }); } }]);
  engineCalls = [];
  engineImpl = async () => ({ conversationId: "c-new", reply: "done", language: "en", degraded: false });
  const engine = { handleMessage: async (ctx: any, text: string) => { engineCalls.push({ ctx, text }); return engineImpl(ctx); } } as any;
  app = Fastify();
  registerChatRoutes(app, engine, null, null, null, hub);
  registerCoworkerUiRoutes(app, {
    hub, prisma: db.prisma, audit,
    store: { historyVisible: async () => true } as any,
    prefs: new CoworkerPrefsStore(db.prisma, audit),
    transcribe: { keys: {}, glossaryContext: async () => undefined },
  });
  await app.ready();
});

const post = (url: string, auth: string | null, body: unknown) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, payload: JSON.stringify(body ?? {}) });

test("every workspace route refuses without a valid token", async () => {
  for (const url of ["/agent/coworker/activity", "/agent/coworker/attach", "/agent/coworker/answer", "/agent/coworker/stop", "/agent/coworker/tasks", "/agent/coworker/log", "/agent/coworker/prefs", "/agent/coworker/transcribe"]) {
    assert.equal((await post(url, null, {})).statusCode, 403, url);
    assert.equal((await post(url, "Bearer not.a.jwt", {})).statusCode, 403, url);
  }
});

test("a message with a turnId opens the turn for that person, passes it to the engine, and finishes it", async () => {
  let midTurn: any = null;
  engineImpl = async (ctx) => {
    midTurn = hub.read(ctx.turnId, { tenantId: "t1", clientUserId: "u1" }, 0);
    hub.stepStarted(ctx.turnId, "s1", "computer_fs_list", "files", "Looking in your Downloads folder");
    return { conversationId: "c-new", reply: "done", language: "en", degraded: false };
  };
  const r = await post("/agent/chat/message", U1, { text: "hi", turnId: "turn-route-001", newTask: true, conversationId: "c-old", context: { path: "/coworker", folders: [{ path: "C:\\dev\\shop", name: "shop", repo: true }] } });
  assert.equal(r.statusCode, 200);
  assert.ok(midTurn?.ok && midTurn.done === false, "the turn was open while the engine ran");
  const ctx = engineCalls[0].ctx;
  assert.equal(ctx.turnId, "turn-route-001");
  assert.equal(ctx.startNewConversation, true);
  assert.equal(ctx.conversationId, "c-old");
  assert.deepEqual(ctx.coworkerFolders, [{ path: "C:\\dev\\shop", name: "shop", repo: true }]);
  const after = await post("/agent/coworker/activity", U1, { turnId: "turn-route-001", after: 0 });
  const body = after.json();
  assert.equal(body.done, true);
  assert.deepEqual(body.events.map((e: any) => (e.type === "step" ? `step:${e.state}` : e.type)), ["step:running", "step:failed", "done"]);
});

test("someone else's turn reads as not found on every door, and a live turnId cannot be reused", async () => {
  let release!: () => void;
  engineImpl = () => new Promise((resolve) => { release = () => resolve({ conversationId: "c", reply: "", language: "en", degraded: false }); });
  const running = post("/agent/chat/message", U1, { text: "long task", turnId: "turn-route-002" });
  for (let i = 0; i < 50 && !hub.has("turn-route-002"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post("/agent/coworker/activity", U2, { turnId: "turn-route-002" })).statusCode, 404);
  assert.equal((await post("/agent/coworker/activity", T2, { turnId: "turn-route-002" })).statusCode, 404);
  assert.equal((await post("/agent/coworker/stop", U2, { turnId: "turn-route-002" })).statusCode, 404);
  assert.equal((await post("/agent/coworker/answer", U2, { turnId: "turn-route-002", questionId: "q1", answer: "x" })).statusCode, 404);
  assert.equal(hub.isStopped("turn-route-002"), false);
  const reuse = await post("/agent/chat/message", U1, { text: "again", turnId: "turn-route-002" });
  assert.equal(reuse.statusCode, 409);
  assert.equal(reuse.json().error, "turn_busy");
  const stolen = await post("/agent/chat/message", U2, { text: "mine now", turnId: "turn-route-002" });
  assert.equal(stolen.statusCode, 409);
  assert.equal(stolen.json().error, "turn_owned_elsewhere");
  assert.equal((await post("/agent/coworker/stop", U1, { turnId: "turn-route-002" })).json().ok, true);
  release();
  await running;
});

test("a bad turnId is a 400 before any work, and a turn is finished even when the engine throws", async () => {
  assert.equal((await post("/agent/chat/message", U1, { text: "x", turnId: "bad id!" })).statusCode, 400);
  assert.equal(engineCalls.length, 0);
  engineImpl = async () => { throw new Error("boom"); };
  const r = await post("/agent/chat/message", U1, { text: "x", turnId: "turn-route-003" });
  assert.equal(r.statusCode, 500);
  const read = hub.read("turn-route-003", { tenantId: "t1", clientUserId: "u1" }, 0);
  assert.ok(read.ok && read.done === true, "a crashed turn never spins forever");
});

test("answer: 409 when already answered, 400 on an empty answer", async () => {
  hub.open("turn-route-004", { tenantId: "t1", clientUserId: "u1" });
  const pending = hub.ask("turn-route-004", { question: "Which?" });
  const q = (hub.read("turn-route-004", { tenantId: "t1", clientUserId: "u1" }, 0) as any).events[0];
  assert.equal((await post("/agent/coworker/answer", U1, { turnId: "turn-route-004", questionId: q.questionId, answer: "  " })).statusCode, 400);
  assert.equal((await post("/agent/coworker/answer", U1, { turnId: "turn-route-004", questionId: q.questionId, answer: "That one" })).statusCode, 200);
  assert.deepEqual(await pending, { answered: true, answer: "That one" });
  assert.equal((await post("/agent/coworker/answer", U1, { turnId: "turn-route-004", questionId: q.questionId, answer: "again" })).statusCode, 409);
});

test("attach finds the running turn of the person's own task only", async () => {
  hub.open("turn-route-005", { tenantId: "t1", clientUserId: "u1" });
  hub.setConversation("turn-route-005", "c-live");
  assert.equal((await post("/agent/coworker/attach", U1, { conversationId: "c-live" })).json().turnId, "turn-route-005");
  assert.equal((await post("/agent/coworker/attach", U2, { conversationId: "c-live" })).json().turnId, null);
});

test("tasks lists only this person's last 30 days, titled from the first message", async () => {
  const r = (await post("/agent/coworker/tasks", U1, {})).json();
  assert.equal(r.visible, true);
  assert.deepEqual(r.tasks.map((t: any) => [t.id, t.title]), [["c-old", "Organize my Downloads folder"]]);
  assert.equal(taskTitle("x".repeat(200)).length, 78);
  assert.equal(taskTitle(""), "Untitled task");
});

test("prefs: defaults, a partial save merges, unknown keys are dropped, memory is capped, and it is per person", async () => {
  assert.deepEqual((await post("/agent/coworker/prefs", U1, {})).json().prefs, DEFAULT_PREFS);
  const saved = (await post("/agent/coworker/prefs", U1, { prefs: { phone: false, detail: "detailed", memory: "m".repeat(5000), isAdmin: true } })).json().prefs;
  assert.equal(saved.phone, false);
  assert.equal(saved.detail, "detailed");
  assert.equal(saved.memory.length, 2000);
  assert.equal(saved.email, DEFAULT_PREFS.email);
  assert.equal("isAdmin" in saved, false);
  const again = (await post("/agent/coworker/prefs", U1, { prefs: { notify: false } })).json().prefs;
  assert.equal(again.phone, false, "an earlier save survives a later partial one");
  assert.deepEqual((await post("/agent/coworker/prefs", U2, {})).json().prefs, DEFAULT_PREFS, "someone else's settings are untouched");
  assert.equal((await post("/agent/coworker/prefs", U1, { prefs: ["x"] })).statusCode, 400);
});

test("log returns this person's recorded steps newest first", async () => {
  const audit = db.prisma.agentAuditLog;
  await audit.create({ data: { event: "coworker.step", tenantId: "t1", conversationId: "c1", payload: { userId: "u1", kind: "files", label: "Looking in your Downloads folder", state: "done", tookMs: 120 } } });
  await audit.create({ data: { event: "coworker.step", tenantId: "t1", conversationId: "c9", payload: { userId: "u2", kind: "files", label: "Someone else's", state: "done" } } });
  const r = (await post("/agent/coworker/log", U1, { limit: 10 })).json();
  assert.deepEqual(r.entries.map((e: any) => e.label), ["Looking in your Downloads folder"]);
});

test("transcribe: no keys → 502 no_transcription_provider; junk audio → 400", async () => {
  assert.equal((await post("/agent/coworker/transcribe", U1, { audioBase64: "x" })).statusCode, 400);
  const r = await post("/agent/coworker/transcribe", U1, { audioBase64: Buffer.alloc(512, 3).toString("base64"), filename: "voice.webm" });
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().error, "no_transcription_provider");
});

test("voice: English goes to OpenAI's text, Yiddish to Yiddish Labs', and either one failing leaves the other", async () => {
  const yl = (language: string, text: string, delayMs = 0) => () => ({
    submitSync: async () => { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return { id: "1", status: "completed", text, language } as any; },
    get: async () => ({ id: "1", status: "completed", text, language }) as any,
  });
  const keys = { keys: { openaiApiKey: "sk", yiddishLabsApiKey: "yl" }, glossaryContext: async () => undefined };
  const buf = Buffer.alloc(256, 1);
  const openaiSays = (text: string) => async () => ({ text });

  const en = await transcribeForCoworker(keys, buf, "v.webm", openaiSays("Move the invoices into August"), yl("en", "move the invoices in to august"));
  assert.deepEqual(en, { ok: true, text: "Move the invoices into August", language: "en", engine: "openai" });

  const yi = await transcribeForCoworker(keys, buf, "v.webm", openaiSays("Shik mir di invoices"), yl("yi", "שיק מיר די אינוואָיסעס"));
  assert.deepEqual(yi, { ok: true, text: "שיק מיר די אינוואָיסעס", language: "yi", engine: "yiddishlabs" });

  const hebrewFromOpenai = await transcribeForCoworker(keys, buf, "v.webm", openaiSays("שיק מיר"), yl("yi", "שיק מיר די"));
  assert.equal(hebrewFromOpenai.ok && hebrewFromOpenai.engine, "yiddishlabs");

  const openaiDown = await transcribeForCoworker(keys, buf, "v.webm", async () => { throw new Error("503"); }, yl("en", "hello there"));
  assert.deepEqual(openaiDown, { ok: true, text: "hello there", language: "en", engine: "yiddishlabs" });

  const ylDown = await transcribeForCoworker(keys, buf, "v.webm", openaiSays("hello there"), () => ({ submitSync: async () => { throw new Error("down"); }, get: async () => { throw new Error("down"); } }) as any);
  assert.deepEqual(ylDown, { ok: true, text: "hello there", language: "en", engine: "openai" });

  const bothDown = await transcribeForCoworker(keys, buf, "v.webm", async () => { throw new Error("x"); }, () => ({ submitSync: async () => { throw new Error("x"); }, get: async () => { throw new Error("x"); } }) as any);
  assert.deepEqual(bothDown, { ok: false, error: "transcription_unavailable" });
});
