/**
 * The live agent-run view the support console reads.
 *
 * ⛔ What these defend: an operator being blind while a run is in flight, an
 * unbounded writer filling the database, and the run's internal detail (which
 * quotes other tenants and file paths by construction) ever reaching a
 * customer-facing route.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { registerAgentRunRoutes, sanitiseSteps, MAX_STEPS, MAX_STEP_TEXT } from "./agentRunRoutes";

// ───────────────────────────────────────────────────────────────── the bounds

describe("bounding what a laptop can write into the database", () => {
  test("⛔ steps are capped, and it is the LAST ones that are kept", () => {
    // A runaway agent must not be able to fill the database, and the end of a
    // run is the part somebody is watching.
    const many = Array.from({ length: 5000 }, (_, i) => ({ at: "x", kind: "tool", text: "step " + i }));
    const out = sanitiseSteps(many);
    assert.equal(out.length, MAX_STEPS);
    assert.equal(out[out.length - 1].text, "step 4999");
  });

  test("⛔ one step cannot be enormous", () => {
    const out = sanitiseSteps([{ at: "x", kind: "tool", text: "A".repeat(50_000) }]);
    assert.equal(out[0].text.length, MAX_STEP_TEXT);
  });

  test("an unrecognised kind is pinned rather than passed through", () => {
    const out = sanitiseSteps([{ at: "x", kind: "<script>alert(1)</script>", text: "hi" }]);
    assert.equal(out[0].kind, "text");
  });

  test("empty and malformed steps are dropped, never thrown on", () => {
    assert.deepEqual(sanitiseSteps([{ text: "" }, null, 42, "x"]), []);
    for (const junk of [null, undefined, "string", 42, {}]) {
      assert.ok(Array.isArray(sanitiseSteps(junk as any)));
    }
  });
});

// ─────────────────────────────────────────────────────────────────── the routes

type Row = Record<string, any>;

function fakeDb() {
  const runs = new Map<string, Row>();
  const watchers = new Map<string, Row>();
  return {
    runs,
    watchers,
    agentEscalation: {
      findMany: async () => [{ id: "esc_one" }],
    },
    supportAgentRun: {
      upsert: async ({ where, create, update }: any) => {
        const existing = runs.get(where.id);
        const row = existing
          ? { ...existing, ...update }
          : { startedAt: new Date(), ...create, id: where.id };
        runs.set(where.id, row);
        return row;
      },
      findMany: async ({ where, select }: any) => {
        let rows = [...runs.values()];
        if (where?.id?.in) rows = rows.filter((r) => where.id.in.includes(r.id));
        return rows.map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r));
      },
      findUnique: async ({ where }: any) => runs.get(where.id) ?? null,
    },
    supportAgentWatcher: {
      upsert: async ({ where, create, update }: any) => {
        const row = watchers.has(where.host) ? { ...watchers.get(where.host), ...update } : { ...create };
        watchers.set(where.host, row);
        return row;
      },
      findMany: async () => [...watchers.values()],
    },
  };
}

async function appWith(db: any, allow = true) {
  const app = Fastify();
  registerAgentRunRoutes(app as any, {
    db,
    requireSuper: async (_req: any, reply: any) => {
      if (allow) return { sub: "izzy" };
      reply.status(403).send({ error: "forbidden" });
      return null;
    },
  });
  await app.ready();
  return app;
}

describe("the run feed", () => {
  test("a run is upserted, so pushing it five times leaves ONE row", async () => {
    // The watcher pushes repeatedly during a run. Without upsert-by-runId the
    // dashboard would show a trail of duplicates for one ticket.
    const db = fakeDb();
    const app = await appWith(db);
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/support/agent-runs",
        payload: { runId: "Q2FJRK-123", ticketRef: "Q2FJRK", status: "running", steps: [{ at: "x", kind: "tool", text: "step " + i }] },
      });
      assert.equal(res.statusCode, 200);
    }
    assert.equal(db.runs.size, 1);
    assert.equal(db.runs.get("Q2FJRK-123")!.steps.length, 1);
    await app.close();
  });

  test("⛔ a steps-only push does not blank what the first push established", async () => {
    // The first push carries the company name; later ones carry only steps. If
    // the update wrote every field, the dashboard would lose the name mid-run.
    const db = fakeDb();
    const app = await appWith(db);
    await app.inject({
      method: "POST",
      url: "/admin/support/agent-runs",
      payload: { runId: "RUN-0001", ticketRef: "Q2FJRK", tenantName: "Gesheft", requestSummary: "phones are down" },
    });
    await app.inject({
      method: "POST",
      url: "/admin/support/agent-runs",
      payload: { runId: "RUN-0001", ticketRef: "Q2FJRK", steps: [{ at: "x", kind: "tool", text: "grep" }] },
    });
    const row = db.runs.get("RUN-0001")!;
    assert.equal(row.tenantName, "Gesheft");
    assert.equal(row.requestSummary, "phones are down");
    await app.close();
  });

  test("the list is light — no steps, no report", async () => {
    // A dashboard polling every few seconds must not drag whole reports with it.
    const db = fakeDb();
    const app = await appWith(db);
    await app.inject({
      method: "POST",
      url: "/admin/support/agent-runs",
      payload: { runId: "RUN-0001", ticketRef: "Q2FJRK", report: "SECRET INTERNAL REPORT", steps: [{ at: "x", kind: "tool", text: "grep" }] },
    });
    const res = await app.inject({ method: "GET", url: "/admin/support/agent-runs" });
    const body = res.json();
    assert.equal(body.runs.length, 1);
    assert.equal(typeof body.runs[0].steps, "number", "the list carries a COUNT, not the steps");
    assert.ok(!JSON.stringify(body).includes("SECRET INTERNAL REPORT"));
    await app.close();
  });

  test("opening one run gives the steps and the report", async () => {
    const db = fakeDb();
    const app = await appWith(db);
    await app.inject({
      method: "POST",
      url: "/admin/support/agent-runs",
      payload: { runId: "RUN-0001", ticketRef: "Q2FJRK", report: "the answer", steps: [{ at: "x", kind: "tool", text: "grep" }] },
    });
    const res = await app.inject({ method: "GET", url: "/admin/support/agent-runs/RUN-0001" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().run.report, "the answer");
    assert.equal(res.json().run.steps.length, 1);
    await app.close();
  });

  test("an unknown run is a plain 404, not a crash", async () => {
    const app = await appWith(fakeDb());
    const res = await app.inject({ method: "GET", url: "/admin/support/agent-runs/nope" });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test("a malformed push is refused in plain English", async () => {
    const app = await appWith(fakeDb());
    for (const payload of [{}, { runId: "x" }, { runId: "Q2FJRK-1" }, { ticketRef: "Q2FJRK" }]) {
      const res = await app.inject({ method: "POST", url: "/admin/support/agent-runs", payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.match(res.json().message, /runId|ticketRef/);
    }
    await app.close();
  });

  test("⛔ every route is SUPER_ADMIN only", async () => {
    const app = await appWith(fakeDb(), false);
    for (const [method, url] of [
      ["POST", "/admin/support/agent-runs"],
      ["GET", "/admin/support/agent-runs"],
      ["GET", "/admin/support/agent-runs/RUN-0001"],
      ["POST", "/admin/support/agent-watcher"],
      ["GET", "/admin/support/agent-watcher"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
    }
    await app.close();
  });
});

describe("the watcher heartbeat", () => {
  test("⛔ a stale heartbeat reads NOT ALIVE — silence must be visible", async () => {
    // The whole reason this exists: the watcher sat off for three days and
    // "no new reports" looked exactly like "a quiet week".
    const db = fakeDb();
    const app = await appWith(db);
    await app.inject({ method: "POST", url: "/admin/support/agent-watcher", payload: { host: "izzy-pc", state: "idle" } });
    let res = await app.inject({ method: "GET", url: "/admin/support/agent-watcher" });
    assert.equal(res.json().watchers[0].alive, true);

    db.watchers.get("izzy-pc")!.lastBeatAt = new Date(Date.now() - 10 * 60_000);
    res = await app.inject({ method: "GET", url: "/admin/support/agent-watcher" });
    assert.equal(res.json().watchers[0].alive, false);
    await app.close();
  });

  test("it carries what has been used today against the caps", async () => {
    const db = fakeDb();
    const app = await appWith(db);
    await app.inject({
      method: "POST",
      url: "/admin/support/agent-watcher",
      payload: { host: "izzy-pc", state: "working", currentTicket: "Q2FJRK", usedToday: { customer: 3 }, caps: { customer: 10 } },
    });
    const w = (await app.inject({ method: "GET", url: "/admin/support/agent-watcher" })).json().watchers[0];
    assert.equal(w.currentTicket, "Q2FJRK");
    assert.deepEqual(w.usedToday, { customer: 3 });
    assert.deepEqual(w.caps, { customer: 10 });
    await app.close();
  });
});

describe("the internal/customer boundary", () => {
  test("⛔ SOURCE GUARD: this file exposes no customer-facing route", () => {
    // A run's steps and report quote other tenants, file paths and internal
    // systems by construction. Every route here is /admin and SUPER_ADMIN gated.
    const src = fs.readFileSync(path.join(__dirname, "agentRunRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
    const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => m[2]);
    assert.ok(routes.length >= 5, "expected the five routes");
    for (const r of routes) {
      assert.ok(r.startsWith("/admin/support/"), `non-admin route exposed: ${r}`);
    }
    // and every one of them asks the SUPER_ADMIN gate first
    assert.equal(routes.length, (src.match(/deps\.requireSuper\(req, reply\)/g) || []).length);
  });
});
