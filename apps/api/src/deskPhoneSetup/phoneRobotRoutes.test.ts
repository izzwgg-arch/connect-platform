/**
 * The office wizard's improviser door — round 23 (2026-09-17). Driven directly
 * against `registerPhoneRobotRoutes` with a FAKE agent, because the whole point of
 * this file is what happens BEFORE and AFTER the agent answers: ownership first,
 * the permission after, the size cap, the URL fence, the audit trail and the rate
 * cap — never whether a real OpenAI call works, which is the agent module's own
 * test file's job.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerPhoneRobotRoutes, __resetPhoneRobotRateLimitForTests } from "./phoneRobotRoutes";

const CUSTOMER = { sub: "u_1", tenantId: "t_abc", email: "dina@abc.example", role: "TENANT_ADMIN" };
const RUN = { id: "run_1", tenantId: "t_abc" };
const PHONE = { id: "ph_1", runId: "run_1", tenantId: "t_abc" };
const FOLDER = "https://m.connectcomunications.com/phoneprov/0123456789abcdef/";

function makeApp(opts: {
  user?: any; ownedRun?: any; setupAllowed?: boolean; phone?: any; provisioningUrl?: string | null;
  askAgent?: any;
} = {}) {
  const app = Fastify();
  const audits: any[] = [];
  const user = opts.user ?? CUSTOMER;
  registerPhoneRobotRoutes(app as any, {
    deps: { audit: async (p: any) => { audits.push(p); } } as any,
    db: {
      deskPhoneSetupPhone: {
        findFirst: async () => (Object.prototype.hasOwnProperty.call(opts, "phone") ? opts.phone : PHONE),
      },
    },
    ownRun: async (req: any, reply: any) => {
      if (opts.ownedRun === null) { reply.status(404).send({ error: "not_found" }); return null; }
      return { user, run: opts.ownedRun ?? RUN };
    },
    allowedToSetUp: async (_u: any, reply: any) => {
      if (opts.setupAllowed === false) { reply.status(403).send({ error: "forbidden" }); return false; }
      return true;
    },
    provisioningUrlFor: async (): Promise<string | null> =>
      (Object.prototype.hasOwnProperty.call(opts, "provisioningUrl") ? (opts.provisioningUrl ?? null) : FOLDER),
    askAgent: opts.askAgent,
  });
  (app as any).__audits = audits;
  return app;
}

const postAdvise = (app: any, payload: any) =>
  app.inject({ method: "POST", url: "/desk-phones/runs/run_1/phones/ph_1/robot-advise", payload });

test("ownership is resolved before anything else — an unowned run answers 404", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ ownedRun: null });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  assert.equal(r.statusCode, 404);
});

test("the permission is asked after ownership, never before", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ setupAllowed: false });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  assert.equal(r.statusCode, 403);
});

test("an unknown phone on an owned run is a 404", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ phone: null });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  assert.equal(r.statusCode, 404);
});

test("a malformed body (bad goal) is refused", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ askAgent: async () => ({ verdict: "done", customerHint: "x" }) });
  const r = await postAdvise(app, { goal: "not_a_real_goal", snapshot: {} });
  assert.equal(r.statusCode, 400);
});

test("a well-formed plan passes straight through, the agent is handed this tenant's own folder, and the audit records it", async () => {
  __resetPhoneRobotRateLimitForTests();
  let sent: any = null;
  const app = makeApp({
    askAgent: async (b: any) => {
      sent = b;
      return { verdict: "actions", actions: [{ kind: "click", ref: "ref_1" }], customerHint: "Pointing it at Loopcom…", model: "openai:gpt-5" };
    },
  });
  const r = await postAdvise(app, { goal: "provision", snapshot: { text: "hi" }, history: [] });
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.verdict, "actions");
  assert.deepEqual(b.actions, [{ kind: "click", ref: "ref_1" }]);
  assert.equal(b.customerHint, "Pointing it at Loopcom…");
  assert.equal(sent.allowedUrl, FOLDER, "the agent is handed this tenant's own folder, not asked to guess it");
  const audits = (app as any).__audits;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "DESK_PHONE_ROBOT_ADVISED");
  assert.deepEqual(audits[0].metadata.actionKinds, ["click"]);
  assert.equal(audits[0].metadata.model, "openai:gpt-5");
  assert.equal(audits[0].metadata.round, 0);
});

test("a plan that types a URL other than this tenant's own folder is replaced with give_up, audited by name", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    askAgent: async () => ({
      verdict: "actions",
      actions: [{ kind: "fill", ref: "ref_9", text: "https://evil.example.com/x" }],
      customerHint: "Pointing it at Loopcom…",
    }),
  });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  const b = JSON.parse(r.body);
  assert.equal(b.verdict, "give_up");
  assert.equal(b.reason, "fenced_url_refused");
  assert.equal(b.actions, undefined, "give_up never carries actions");
  const audits = (app as any).__audits;
  assert.ok(audits.some((a: any) => a.action === "DESK_PHONE_ROBOT_FENCE_TRIPPED"), "the trip is audited by its own name");
  const advised = audits.find((a: any) => a.action === "DESK_PHONE_ROBOT_ADVISED");
  assert.equal(advised.metadata.verdict, "give_up");
});

test("the exact allowed URL, verbatim, is never fenced", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    askAgent: async () => ({
      verdict: "actions", actions: [{ kind: "fill", ref: "ref_9", text: FOLDER }], customerHint: "Pointing it at Loopcom…",
    }),
  });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  assert.equal(JSON.parse(r.body).verdict, "actions");
});

test("no folder known yet means no fill with a URL is ever allowed, not even the customer's real one guessed at", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    provisioningUrl: null,
    askAgent: async () => ({ verdict: "actions", actions: [{ kind: "fill", ref: "ref_9", text: FOLDER }], customerHint: "x" }),
  });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  assert.equal(JSON.parse(r.body).verdict, "give_up");
});

test("a fill with no '://' in it is never fenced, whatever it says", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    askAgent: async () => ({ verdict: "actions", actions: [{ kind: "fill", ref: "ref_2", text: "admin" }], customerHint: "Signing into the phone…" }),
  });
  const r = await postAdvise(app, { goal: "identify", snapshot: {} });
  assert.equal(JSON.parse(r.body).verdict, "actions");
});

test("round-23 hardening: a BARE hostname (no ://) is fenced exactly like a full URL", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    askAgent: async () => ({ verdict: "actions", actions: [{ kind: "fill", ref: "ref_9", text: "evil.example/take-everything" }], customerHint: "x" }),
  });
  const r = await postAdvise(app, { goal: "provision", snapshot: {} });
  const b = JSON.parse(r.body);
  assert.equal(b.verdict, "give_up");
  assert.ok((app as any).__audits.some((a: any) => a.action === "DESK_PHONE_ROBOT_FENCE_TRIPPED"));
});

test("round-23 hardening: ANY non-empty text into an element the snapshot names as a server/URL field is fenced", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    askAgent: async () => ({ verdict: "actions", actions: [{ kind: "fill", ref: "ref_7", text: "perfectly innocent words" }], customerHint: "x" }),
  });
  const r = await postAdvise(app, {
    goal: "provision",
    snapshot: { elements: [{ ref: "ref_7", name: "AutoProvisionServerURL" }] },
  });
  assert.equal(JSON.parse(r.body).verdict, "give_up");
});

test("an unreachable or malformed agent answer is a safe give_up, never a crash", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ askAgent: async () => null });
  const r = await postAdvise(app, { goal: "identify", snapshot: {} });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).verdict, "give_up");
});

test("an agent answer with a verdict outside the schema is a safe give_up", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ askAgent: async () => ({ verdict: "maybe" } as any) });
  const r = await postAdvise(app, { goal: "identify", snapshot: {} });
  assert.equal(JSON.parse(r.body).verdict, "give_up");
});

test("customer-facing copy never carries a forbidden word, even if the model wrote one", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({
    askAgent: async () => ({ verdict: "done", customerHint: "The AI robot signed in for you." }),
  });
  const r = await postAdvise(app, { goal: "reset", snapshot: {} });
  const hint = JSON.parse(r.body).customerHint;
  assert.ok(!/\b(ai|robot)\b/i.test(hint), hint);
});

test("a snapshot over the size cap is refused before it ever reaches the agent", async () => {
  __resetPhoneRobotRateLimitForTests();
  let called = false;
  const app = makeApp({ askAgent: async () => { called = true; return null; } });
  const r = await postAdvise(app, { goal: "provision", snapshot: { text: "x".repeat(70 * 1024) } });
  assert.equal(r.statusCode, 400);
  assert.equal(called, false, "an oversized body must never reach the agent");
});

test("the rate cap trips at 30 advise calls per phone per hour", async () => {
  __resetPhoneRobotRateLimitForTests();
  const app = makeApp({ askAgent: async () => ({ verdict: "actions", actions: [], customerHint: "x" }) });
  let last: any = null;
  for (let i = 0; i < 31; i += 1) {
    last = await postAdvise(app, { goal: "provision", snapshot: {} });
  }
  const b = JSON.parse(last.body);
  assert.equal(b.verdict, "give_up");
  assert.equal(b.reason, "advise_rate_limited");
});
