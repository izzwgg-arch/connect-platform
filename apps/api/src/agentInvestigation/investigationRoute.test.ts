/**
 * The investigation door, end to end against a REAL Fastify instance.
 *
 * ⛔ The source guards below exist because this codebase's most repeated
 * failure is a feature that is built, tested, and connected to nothing: the
 * worker's dead FCM sender, the empty knowledge base, the trainer that taught
 * nothing, and the account-setup door that 401'd for six days because its path
 * was missing from the JWT bypass list. A unit test of the handler passes
 * straight through every one of those. So these read server.ts's own source.
 *
 * ⛔ All source reads normalise CRLF. Izzy's checkout is `core.autocrlf=true`,
 * so a literal "\n" match silently fails on Windows only and reads exactly like
 * a regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";
import { registerAgentInvestigationRoute, _resetInvestigationRateLimit } from "./investigationRoute";

const SECRET = "test-internal-secret-value";

function readSource(rel: string): string {
  return readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

/** Comments are stripped so a doc block MENTIONING the call cannot satisfy a guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── wiring: the failure shape this codebase keeps repeating ──────────────────

test("server.ts imports AND calls the registration — a route nobody registers is the failure shape here", () => {
  const server = stripComments(readSource("../server.ts"));
  assert.match(
    server,
    /import\s*\{\s*registerAgentInvestigationRoute\s*\}\s*from\s*"\.\/agentInvestigation\/investigationRoute"/,
    "server.ts must import the registrar",
  );
  assert.match(
    server,
    /registerAgentInvestigationRoute\s*\(\s*app\s*\)/,
    "server.ts must actually CALL it — importing alone registers nothing",
  );
});

test("the door is on the JWT bypass list, or its own secret check never runs", () => {
  assert.equal(shouldSkipJwtVerification("/internal/agent/investigate"), true);
  assert.equal(shouldSkipJwtVerification("/api/internal/agent/investigate"), true);
});

// ── auth ─────────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify();
  registerAgentInvestigationRoute(app);
  await app.ready();
  return app;
}

test("fails CLOSED: no secret, wrong secret, and an UNSET server secret are all refused", async () => {
  const prev = process.env.AGENT_INTERNAL_SECRET;
  const app = await buildApp();
  try {
    process.env.AGENT_INTERNAL_SECRET = SECRET;

    const noHeader = await app.inject({
      method: "POST",
      url: "/internal/agent/investigate",
      payload: { tenantId: "t1", source: "connect", sql: "select 1" },
    });
    assert.equal(noHeader.statusCode, 403, "no secret must be refused");

    const wrong = await app.inject({
      method: "POST",
      url: "/internal/agent/investigate",
      headers: { "x-agent-internal-secret": "not-the-secret" },
      payload: { tenantId: "t1", source: "connect", sql: "select 1" },
    });
    assert.equal(wrong.statusCode, 403, "a wrong secret must be refused");

    // ⛔ The one that matters most: an UNSET secret must not become an open door.
    delete process.env.AGENT_INTERNAL_SECRET;
    const unset = await app.inject({
      method: "POST",
      url: "/internal/agent/investigate",
      headers: { "x-agent-internal-secret": "anything" },
      payload: { tenantId: "t1", source: "connect", sql: "select 1" },
    });
    assert.equal(unset.statusCode, 403, "an unset secret must FAIL CLOSED, not open the door");
  } finally {
    await app.close();
    if (prev === undefined) delete process.env.AGENT_INTERNAL_SECRET;
    else process.env.AGENT_INTERNAL_SECRET = prev;
  }
});

test("a bad body is a 400, not a 500", async () => {
  const prev = process.env.AGENT_INTERNAL_SECRET;
  process.env.AGENT_INTERNAL_SECRET = SECRET;
  const app = await buildApp();
  try {
    for (const payload of [
      {},
      { tenantId: "t1" },
      { tenantId: "t1", source: "mars", sql: "select 1" },
      { tenantId: "t1", source: "connect" },
      { tenantId: "", source: "connect", sql: "select 1" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/agent/investigate",
        headers: { "x-agent-internal-secret": SECRET },
        payload,
      });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
  } finally {
    await app.close();
    if (prev === undefined) delete process.env.AGENT_INTERNAL_SECRET;
    else process.env.AGENT_INTERNAL_SECRET = prev;
  }
});

test("the rate limiter is real and its refusal explains itself", async () => {
  const prev = process.env.AGENT_INTERNAL_SECRET;
  process.env.AGENT_INTERNAL_SECRET = SECRET;
  _resetInvestigationRateLimit();
  const app = await buildApp();
  try {
    let sawRateLimit = false;
    // A write is refused by the guard BEFORE touching a database, so this loop
    // exercises the limiter without needing a live connection.
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/agent/investigate",
        headers: { "x-agent-internal-secret": SECRET },
        payload: { tenantId: "t1", source: "connect", sql: "delete from x" },
      });
      if (res.statusCode === 429) {
        sawRateLimit = true;
        const body = res.json() as any;
        assert.equal(body.error, "rate_limited");
        assert.match(body.message, /loop/i, "the refusal must say what went wrong");
        break;
      }
    }
    assert.ok(sawRateLimit, "the limiter must actually fire");
  } finally {
    await app.close();
    _resetInvestigationRateLimit();
    if (prev === undefined) delete process.env.AGENT_INTERNAL_SECRET;
    else process.env.AGENT_INTERNAL_SECRET = prev;
  }
});

// ── the promise the whole feature rests on ───────────────────────────────────

test("⛔ THE PROMISE: a write is refused by the guard and never reaches a database", async () => {
  const prev = process.env.AGENT_INTERNAL_SECRET;
  process.env.AGENT_INTERNAL_SECRET = SECRET;
  _resetInvestigationRateLimit();
  const app = await buildApp();
  try {
    for (const sql of [
      `delete from "Extension"`,
      `update "Tenant" set name = 'x'`,
      `drop table "ConnectCdr"`,
      `select 1; delete from "Extension"`,
      `select pg_read_file('/etc/passwd')`,
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/agent/investigate",
        headers: { "x-agent-internal-secret": SECRET },
        payload: { tenantId: "t1", source: "connect", sql },
      });
      const body = res.json() as any;
      assert.equal(body.ok, false, `must refuse: ${sql}`);
      assert.equal(body.refusedByGuard, true, `must be refused by the GUARD, before any database: ${sql}`);
    }
  } finally {
    await app.close();
    _resetInvestigationRateLimit();
    if (prev === undefined) delete process.env.AGENT_INTERNAL_SECRET;
    else process.env.AGENT_INTERNAL_SECRET = prev;
  }
});

// ── the read-only transaction is not optional ────────────────────────────────

test("the Postgres path opens a READ ONLY transaction — the outermost enforcement layer", () => {
  const runner = stripComments(readSource("./investigationRunner.ts"));
  assert.match(runner, /SET TRANSACTION READ ONLY/, "Postgres reads must run in a READ ONLY transaction");
  assert.match(runner, /statement_timeout/, "and under a statement timeout");
  assert.match(
    runner,
    /\$transaction/,
    "the READ ONLY setting only holds inside a transaction — outside one it is a no-op",
  );
});

test("the PBX connection helper is REUSED, not reimplemented", () => {
  const runner = stripComments(readSource("./investigationRunner.ts"));
  assert.match(
    runner,
    /import\s*\{\s*connectOmbutelMysql\s*\}\s*from\s*"\.\.\/pbxQueueDirectory"/,
    "a second PBX connection helper is how one of them ends up on a writable credential",
  );
  assert.ok(
    !/createConnection|createPool/.test(runner),
    "this module must never open its own PBX connection",
  );
});

test("driver errors are redacted so a connection string cannot reach a model or a report", () => {
  const runner = stripComments(readSource("./investigationRunner.ts"));
  assert.match(runner, /<connection>/, "connection strings must be scrubbed from errors");
  assert.match(runner, /password=<redacted>/, "passwords must be scrubbed from errors");
});
