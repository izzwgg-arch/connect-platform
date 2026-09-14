import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerDeployLogRoutes } from "./deployLogRoutes.js";

const id = "10fee31a-fd98-45b7-9071-0e856e6bb7e5";
const url = `/admin/deploy/jobs/${id}/log`;
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const missing = { ok: false, status: 404, data: { error: "log_not_available" } };
async function fixture(status: string, log: { ok: boolean; status: number; data: unknown } = missing, service = "portal") {
  const app = Fastify();
  const calls: string[] = [];
  registerDeployLogRoutes(app, {
    requireSuperAdmin: async (req, reply) => {
      if (req.headers["x-test-admin"] === "yes") return { role: "SUPER_ADMIN" };
      reply.status(401).send({ error: "unauthorized" });
      return null;
    },
    dqFetch: async (path) => {
      calls.push(path);
      return path.includes("/log?") ? log : ok({ job: { id, status, service } });
    },
  });
  return { app, calls, get: (path = url) => app.inject({ url: path, headers: { "x-test-admin": "yes" } }) };
}

test("queued jobs for every deploy service return 200 without requesting an absent log", async () => {
  for (const service of ["api", "portal", "telephony", "worker", "realtime", "full-stack"]) {
    const f = await fixture("queued", missing, service);
    try {
      const res = await f.get();
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().pending, true);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0], `/ops/deploy/jobs/${id}`);
    } finally { await f.app.close(); }
  }
});
test("running job's log creation race is a waiting response, not a public 404", async () => {
  const f = await fixture("running");
  try { const res = await f.get(); assert.equal(res.statusCode, 200); assert.equal(res.json().pending, true); }
  finally { await f.app.close(); }
});
test("replaying all 74 pre-log requests from the incident generates zero public 404s", async () => {
  const f = await fixture("queued");
  try {
    const codes: number[] = [];
    for (let i = 0; i < 74; i++) codes.push((await f.get()).statusCode);
    assert.equal(codes.filter((code) => code === 404).length, 0);
    assert.ok(codes.every((code) => code === 200));
    assert.equal(f.calls.filter((path) => path.includes("/log?")).length, 0);
  } finally { await f.app.close(); }
});
test("completed job without a retained log is explicitly unavailable, not pending", async () => {
  const f = await fixture("success");
  try { const res = await f.get(); assert.equal(res.statusCode, 200); assert.equal(res.json().pending, false); assert.equal(res.json().available, false); }
  finally { await f.app.close(); }
});
test("real log content and bounded line count are preserved", async () => {
  const payload = { id, lines: 1, text: "done expected-sha" };
  const f = await fixture("success", ok(payload));
  try { const res = await f.get(`${url}?lines=999999`); assert.deepEqual(res.json(), payload); assert.match(f.calls[1], /lines=2000$/); }
  finally { await f.app.close(); }
});
test("authentication and invalid IDs are refused before queue access", async () => {
  const f = await fixture("queued");
  try {
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.equal((await f.get("/admin/deploy/jobs/not-an-id/log")).statusCode, 400);
    assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
test("unknown jobs and queue failures keep their real error status", async () => {
  for (const status of [404, 502, 504]) {
    const app = Fastify();
    registerDeployLogRoutes(app, { requireSuperAdmin: async () => true,
      dqFetch: async () => ({ ok: false, status, data: { error: "queue_error" } }) });
    try { assert.equal((await app.inject({ url })).statusCode, status); }
    finally { await app.close(); }
  }
});
test("unrelated log failures are not disguised as waiting", async () => {
  const f = await fixture("running", { ok: false, status: 500, data: { error: "log_read_failed" } });
  try { assert.equal((await f.get()).statusCode, 500); }
  finally { await f.app.close(); }
});
test("malformed queue job response cannot authorize a log lookup", async () => {
  const app = Fastify(); let calls = 0;
  registerDeployLogRoutes(app, { requireSuperAdmin: async () => true,
    dqFetch: async () => { calls++; return ok({ job: { id: "different", status: "running" } }); } });
  try { assert.equal((await app.inject({ url })).statusCode, 502); assert.equal(calls, 1); }
  finally { await app.close(); }
});
