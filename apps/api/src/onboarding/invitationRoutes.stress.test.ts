import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/**
 * Drive the REAL invitation routes through a real Fastify, on hostile bodies
 * and under concurrency.
 *
 * ⛔ This exists because the unit tests prove the cases somebody thought of.
 * The routes are the layer where the interesting failures live: a body nobody
 * validated, two admins pressing the same button at once, an id that is not an
 * id. Every request below goes through real routing, real JSON parsing and the
 * real handler — only the database is faked.
 */

type Sub = Record<string, any>;
const state: { subs: Sub[]; events: any[]; emails: any[]; users: any[]; failNext: string | null } = {
  subs: [],
  events: [],
  emails: [],
  users: [],
  failNext: null,
};

let idSeq = 0;
const nextId = () => `sub_${++idSeq}`;

mock.module("@connect/db", {
  namedExports: {
    db: {
      onboardingSubmission: {
        findMany: async () => state.subs.map((s) => ({ ...s, _count: { requestedExtensions: 0 } })),
        findUnique: async ({ where }: any) => {
          const s = state.subs.find((x) => x.id === where.id);
          return s ? { ...s, requestedExtensions: [] } : null;
        },
        create: async ({ data }: any) => {
          if (state.failNext === "create") { state.failNext = null; throw new Error("db down"); }
          const row: Sub = {
            id: nextId(),
            publicToken: data.publicToken,
            companyName: data.companyName ?? null,
            mainEmail: data.mainEmail ?? null,
            status: data.status,
            contactFirstName: null,
            contactLastName: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            submittedAt: null,
            paidAt: null,
            createdTenantId: null,
          };
          state.subs.push(row);
          if (data.events?.create) state.events.push({ submissionId: row.id, ...data.events.create, createdAt: new Date() });
          return row;
        },
        update: async ({ where, data }: any) => {
          const s = state.subs.find((x) => x.id === where.id);
          if (s) Object.assign(s, data);
          return s;
        },
        count: async () => state.subs.length,
      },
      onboardingEvent: {
        findMany: async ({ where }: any) =>
          state.events
            .filter((e) => (where?.submissionId ? e.submissionId === where.submissionId : true))
            .filter((e) => (where?.type ? e.type === where.type : true)),
        create: async ({ data }: any) => {
          if (state.failNext === "event") { state.failNext = null; throw new Error("db down"); }
          const row = { ...data, createdAt: new Date() };
          state.events.push(row);
          return row;
        },
      },
      user: {
        findFirst: async ({ where }: any) => {
          const want = String(where?.email?.equals ?? "").toLowerCase();
          const u = state.users.find((x) => x.email.toLowerCase() === want);
          return u ? { id: u.id, status: "ACTIVE", tenant: { name: u.tenantName } } : null;
        },
      },
      emailJob: {
        create: async ({ data }: any) => {
          if (state.failNext === "email") { state.failNext = null; throw new Error("smtp down"); }
          state.emails.push(data);
          return data;
        },
      },
    },
  },
});

// ⛔ `require`, not top-level await: this file compiles to CJS and esbuild
// refuses top-level await there. The mock above must still be installed first,
// which a require after it guarantees.
const { registerOnboardingInvitationRoutes } = require("./invitationRoutes") as typeof import("./invitationRoutes");

function reset() {
  state.subs = [];
  state.events = [];
  state.emails = [];
  state.users = [];
  state.failNext = null;
  idSeq = 0;
}

/** `role` decides what the injected gate answers, exactly like the real one. */
async function makeApp(role: string | null = "SUPER_ADMIN") {
  const app = Fastify();
  await registerOnboardingInvitationRoutes(app, async (_req: any, reply: any) => {
    if (role !== "SUPER_ADMIN") { reply.code(403).send({ error: "forbidden" }); return null; }
    return { sub: "admin", role };
  });
  await app.ready();
  return app;
}

const HOSTILE_BODIES: any[] = [
  {},
  { email: null },
  { email: 123 },
  { email: {} },
  { email: [] },
  { email: true },
  { email: "" },
  { email: "   " },
  { email: "@" },
  { email: "a@b" },
  { email: "a@b.com", send: "yes" },
  { email: "a@b.com", send: 1 },
  { email: "a@b.com", companyName: null },
  { email: "a@b.com", companyName: 999 },
  { email: "a@b.com", companyName: { toString: "x" } },
  { email: "a@b.com", companyName: ["a", "b"] },
  { email: "a".repeat(5000) + "@b.com" },
  { email: "a@b.com", companyName: "x".repeat(50_000) },
  { email: "a@b.com\r\nBcc: victim@example.com" },
  { email: "a@b.com\nX-Injected: 1" },
  { companyName: "no email at all", send: true },
  { email: "a@b.com", send: true, extra: "ignored" },
  { __proto__: { polluted: true }, email: "a@b.com" },
  { email: "a@b.com", constructor: { prototype: {} } },
];

// ── 1. Every route refuses a non-super-admin ────────────────────────────────

test("stress: no route answers anything but 403 to an ordinary caller", async () => {
  reset();
  const app = await makeApp("USER");
  const calls: [string, string, any?][] = [
    ["GET", "/admin/onboarding/invitations"],
    ["GET", "/admin/onboarding/patterns"],
    ["GET", "/admin/onboarding/email-check?email=a@b.com"],
    ["POST", "/admin/onboarding/invitations", { email: "a@b.com", send: true }],
    ["POST", "/admin/onboarding/submissions/x/resend", {}],
    ["GET", "/admin/onboarding/submissions/x/story"],
    ["GET", "/admin/onboarding/submissions/x/story.csv"],
  ];
  for (const [method, url, payload] of calls) {
    const res = await app.inject({ method: method as any, url, payload });
    assert.equal(res.statusCode, 403, `${method} ${url} answered ${res.statusCode}`);
  }
  assert.equal(state.emails.length, 0, "a refused caller must never cause an email");
  assert.equal(state.subs.length, 0, "a refused caller must never create a sign-up");
  await app.close();
});

// ── 2. Hostile bodies ───────────────────────────────────────────────────────

test("stress: every hostile body is answered, never crashed, and never half-applied", async () => {
  const app = await makeApp();
  for (const payload of HOSTILE_BODIES) {
    reset();
    const res = await app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload });
    assert.ok([200, 400, 409].includes(res.statusCode), `body ${JSON.stringify(payload).slice(0, 60)} → ${res.statusCode}`);
    assert.ok(res.statusCode !== 500, "no hostile body may reach a 500");
    // ⛔ Nothing may be created without also being answered coherently.
    if (res.statusCode === 200) {
      const body = res.json();
      assert.equal(state.subs.length, 1, "one call, one sign-up");
      assert.ok(String(body.link).startsWith("https://"), "the link must be absolute");
      assert.ok(!String(body.link).includes(" "), "a space breaks the link");
      if (body.sent) assert.equal(state.emails.length, 1, "claimed sent with no email queued");
      if (!body.sent) assert.equal(state.emails.length, 0, "queued an email while reporting it did not send");
      // ⛔ What reached the database must be usable, not merely present.
      const stored = state.subs[0];
      const storedEmail = String(stored.mainEmail ?? "");
      assert.ok(!/[\r\n\u0000]/.test(storedEmail), `a line break reached toEmail: ${JSON.stringify(storedEmail)}`);
      assert.ok(!storedEmail.includes("[object"), `an object was coerced into an address: ${storedEmail}`);
      assert.ok(storedEmail.length <= 254, `stored a ${storedEmail.length}-character address`);
      assert.ok(String(stored.companyName ?? "").length <= 200, `stored a ${String(stored.companyName).length}-character company name`);
      for (const e of state.emails) {
        assert.ok(!/[\r\n\u0000]/.test(String(e.toEmail)), "a line break reached an email job");
      }
    } else {
      assert.equal(state.subs.length, 0, `refused with ${res.statusCode} but still created a sign-up`);
      assert.equal(state.emails.length, 0);
    }
  }
  assert.equal(({} as any).polluted, undefined, "prototype pollution");
  await app.close();
});

test("stress: a create that refuses says something a person can act on", async () => {
  reset();
  const app = await makeApp();
  const res = await app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload: { send: true } });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.ok(typeof body.message === "string" && body.message.length > 10, `unhelpful: ${JSON.stringify(body)}`);
  assert.ok(!/zod|schema|undefined|TypeError/i.test(body.message), `leaked internals: ${body.message}`);
  await app.close();
});

// ── 3. Resend ───────────────────────────────────────────────────────────────

test("stress: 25 concurrent resends never mint a token and never create a second sign-up", async () => {
  reset();
  const app = await makeApp();
  const created = await app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload: { email: "a@b.com", companyName: "Acme" } });
  const id = created.json().submissionId;
  const tokenBefore = state.subs[0].publicToken;

  const results = await Promise.all(
    Array.from({ length: 25 }, () => app.inject({ method: "POST", url: `/admin/onboarding/submissions/${id}/resend`, payload: {} })),
  );
  assert.ok(results.every((r) => r.statusCode === 200), "every resend should succeed");
  assert.equal(state.subs.length, 1, "⛔ a resend must never create a second sign-up");
  assert.equal(state.subs[0].publicToken, tokenBefore, "⛔ a resend must never mint a new token");
  const links = new Set(state.emails.map((e) => e.htmlBody.match(/\/onboarding\/[A-Za-z0-9_-]+/)?.[0]));
  assert.equal(links.size, 1, `25 resends produced ${links.size} different links`);
  await app.close();
});

test("stress: resend on a sign-up with nothing to send to refuses cleanly", async () => {
  reset();
  const app = await makeApp();
  const created = await app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload: { companyName: "No Email" } });
  const id = created.json().submissionId;
  const res = await app.inject({ method: "POST", url: `/admin/onboarding/submissions/${id}/resend`, payload: {} });
  assert.equal(res.statusCode, 409);
  assert.ok(/email/i.test(res.json().message));
  assert.equal(state.emails.length, 0);
  await app.close();
});

test("stress: hostile submission ids are 404 or 409 — never 500, never a leak", async () => {
  reset();
  const app = await makeApp();
  const ids = ["", " ", "../../etc/passwd", "%2e%2e%2f", "'; DROP TABLE x;--", "a".repeat(500), "😀", "null", "undefined", "0", "-1"];
  for (const raw of ids) {
    const id = encodeURIComponent(raw);
    for (const url of [
      `/admin/onboarding/submissions/${id}/resend`,
      `/admin/onboarding/submissions/${id}/story`,
      `/admin/onboarding/submissions/${id}/story.csv`,
    ]) {
      const method = url.endsWith("resend") ? "POST" : "GET";
      const res = await app.inject({ method: method as any, url, payload: method === "POST" ? {} : undefined });
      assert.ok([404, 409, 400].includes(res.statusCode), `${url} → ${res.statusCode}`);
      assert.ok(!/prisma|stack|at .*\.ts:/i.test(res.body), `internals leaked for id ${JSON.stringify(raw)}`);
    }
  }
  await app.close();
});

// ── 4. Failure paths ────────────────────────────────────────────────────────

// ⛔ Losing the link the admin just made, because the mail server hiccuped, is
// worse than the failed send — the screen shows the link either way.
test("stress: an email that cannot be queued still returns the link and still records the sign-up", async () => {
  reset();
  const app = await makeApp();
  state.failNext = "email";
  const res = await app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload: { email: "a@b.com", send: true } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.sent, false, "it must not claim to have sent");
  assert.ok(String(body.link).startsWith("https://"), "the link survives the failure");
  assert.equal(state.subs.length, 1, "the sign-up is still there to resend from");
  assert.ok(typeof body.emailError === "string");
  await app.close();
});

test("stress: a failed timeline write never turns a successful send into an error", async () => {
  reset();
  const app = await makeApp();
  state.failNext = "event";
  const res = await app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload: { email: "a@b.com", send: true } });
  assert.equal(res.statusCode, 200, "an audit hiccup must not fail the invitation");
  await app.close();
});

// ── 5. The list, under load and with junk in it ─────────────────────────────

test("stress: 500 sign-ups with hostile names render a coherent list, fast", async () => {
  reset();
  const app = await makeApp();
  const junk = ["", " ", "<script>x</script>", "a".repeat(400), "😀".repeat(20), "\u0000nul", "null", "undefined"];
  for (let i = 0; i < 500; i++) {
    state.subs.push({
      id: `s${i}`,
      publicToken: `tok${i}`,
      companyName: junk[i % junk.length],
      contactFirstName: null,
      contactLastName: null,
      mainEmail: i % 3 === 0 ? null : `x${i}@y.com`,
      status: ["INVITE_SENT", "IN_PROGRESS", "SUBMITTED", "ACTIVE", "CANCELED"][i % 5],
      createdAt: new Date(Date.now() - i * 3600_000),
      updatedAt: new Date(),
      submittedAt: null,
      paidAt: i % 7 === 0 ? new Date() : null,
      createdTenantId: null,
    });
    if (i % 2 === 0) state.events.push({ submissionId: `s${i}`, type: "AUTOSAVED", message: "Step 0", createdAt: new Date() });
  }
  const started = Date.now();
  const res = await app.inject({ method: "GET", url: "/admin/onboarding/invitations" });
  const ms = Date.now() - started;
  assert.equal(res.statusCode, 200);
  assert.ok(ms < 3000, `500 rows took ${ms}ms`);
  const body = res.json();
  assert.equal(body.invitations.length, 500);
  assert.equal(body.counts.all, 500);
  for (const r of body.invitations) {
    assert.ok(!/undefined|NaN|Invalid Date|\[object/.test(r.storyLine), r.storyLine);
    assert.ok(r.stateLabel.length > 0);
    // ⛔ the false-accusation bug, checked over every row that has activity
    if (r.openedAt || r.lastActivityAt) assert.ok(!r.storyLine.includes("nobody has ever opened it"), r.storyLine);
  }
  await app.close();
});

// ── 6. The CSV export ───────────────────────────────────────────────────────

test("stress: the CSV survives quotes, newlines and commas from a hostile customer", async () => {
  reset();
  const app = await makeApp();
  state.subs.push({ id: "csv1", publicToken: "t", companyName: 'Acme, "Inc"', mainEmail: null, status: "ACTIVE", contactFirstName: null, contactLastName: null, createdAt: new Date(), updatedAt: new Date(), submittedAt: null, paidAt: null, createdTenantId: null });
  const nasty = [
    'Searched numbers for "a","b" — 0 results',
    'Searched numbers for "line1\nline2" — 0 results',
    'Searched numbers for "a,b,c,d,e" — 0 results',
    'Stuck on "X" — the wizard said: he said "stop"',
  ];
  for (const m of nasty) state.events.push({ submissionId: "csv1", type: "STATUS_CHANGED", message: m, createdAt: new Date() });

  const res = await app.inject({ method: "GET", url: "/admin/onboarding/submissions/csv1/story.csv" });
  assert.equal(res.statusCode, 200);
  const csv = res.body;
  // Every record must parse back to exactly 3 fields — the classic CSV break.
  const rows = parseCsv(csv);
  assert.equal(rows[0].length, 3, "header");
  for (const r of rows.slice(1)) assert.equal(r.length, 3, `a row broke into ${r.length} fields: ${JSON.stringify(r)}`);
  assert.equal(rows.length, nasty.length + 1, `expected ${nasty.length} records, parsed ${rows.length - 1}`);
  // The filename must never carry the company's punctuation.
  const cd = String(res.headers["content-disposition"]);
  assert.ok(!/[",]/.test(cd.replace(/filename=|attachment;|\s|"/g, "")), cd);
  await app.close();
});

/** A real RFC4180 reader, so the assertion is about the CSV and not about a split(). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── 7. The email-exists check ───────────────────────────────────────────────

test("stress: email-check never throws and never leaks more than it should", async () => {
  reset();
  const app = await makeApp();
  state.users.push({ id: "u1", email: "Taken@Example.com", tenantName: "Landau Home" });
  const cases = ["", " ", "taken@example.com", "TAKEN@EXAMPLE.COM", "free@example.com", "a".repeat(1000), "'; DROP TABLE users;--", "😀@x.com", "no-at-sign"];
  for (const email of cases) {
    const res = await app.inject({ method: "GET", url: `/admin/onboarding/email-check?email=${encodeURIComponent(email)}` });
    assert.equal(res.statusCode, 200, `${email} → ${res.statusCode}`);
    const body = res.json();
    assert.equal(typeof body.taken, "boolean");
    // ⛔ it may say WHICH company, because that is the useful part for an admin —
    // but never the user id, and never anything about their account beyond status.
    assert.equal(body.userId, undefined);
    assert.equal(body.id, undefined);
  }
  const hit = (await app.inject({ method: "GET", url: "/admin/onboarding/email-check?email=taken%40example.com" })).json();
  assert.equal(hit.taken, true);
  assert.equal(hit.tenantName, "Landau Home");
  const miss = (await app.inject({ method: "GET", url: "/admin/onboarding/email-check?email=free%40example.com" })).json();
  assert.equal(miss.taken, false);
  assert.equal(miss.tenantName, undefined, "a miss must not carry a tenant name");
  await app.close();
});

// ── 8. Concurrency on create ────────────────────────────────────────────────

test("stress: 30 concurrent creates produce 30 sign-ups with 30 distinct tokens", async () => {
  reset();
  const app = await makeApp();
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      app.inject({ method: "POST", url: "/admin/onboarding/invitations", payload: { email: `c${i}@x.com`, send: true } }),
    ),
  );
  assert.ok(results.every((r) => r.statusCode === 200));
  assert.equal(state.subs.length, 30);
  assert.equal(state.emails.length, 30, "one email each, no more and no fewer");
  const tokens = new Set(state.subs.map((s) => s.publicToken));
  assert.equal(tokens.size, 30, "⛔ a duplicated sign-up token would hand two customers the same link");
  for (const tok of tokens) assert.ok(String(tok).length >= 20, "a short token is a guessable link");
  await app.close();
});
