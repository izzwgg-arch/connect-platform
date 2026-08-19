/**
 * The platform rate limiter — proof it exists at all, and the rules it keys on.
 *
 * ⛔ The first test is the one that matters: a REAL Fastify instance whose
 * routes are declared BEFORE `app.register(rateLimit)`, exactly as server.ts
 * does, gets a limiter that fires. This is the shape that was silently dead
 * from the first commit to 2026-08-18 (see globalRateLimit.ts) — with
 * `global: true` the plugin attaches via `onRoute`, which has already fired for
 * every route by the time the un-awaited plugin loads. Any refactor that puts
 * the limiter back on the `global: true` path makes the first test fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

import {
  DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE,
  buildGlobalRateLimitOptions,
  isGlobalRateLimitExempt,
  resolveGlobalRateLimitKey,
  resolveGlobalRateLimitMax,
} from "./globalRateLimit";

const readSrc = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/** Source with block and line comments removed — the doc blocks in server.ts
 *  QUOTE the old code, so a negative match on the raw file fails on correct code.
 *  And never hand a 1.8 MB string to assert.match: a failure prints it whole. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

async function buildAppTheWayServerTsDoes(max: number) {
  const app = Fastify({ logger: false });
  // Routes FIRST — this is the trap.
  app.get("/declared-before-plugin", async () => ({ ok: true }));
  app.get("/internal/telephony/thing", async () => ({ ok: true }));
  // Then the plugin, un-awaited, then the hook in after() — as server.ts does.
  app.register(rateLimit, { global: false });
  app.after(() => {
    app.addHook("onRequest", (app as any).rateLimit(buildGlobalRateLimitOptions(max)));
  });
  await app.ready();
  return app;
}

test("the limiter binds to a route declared BEFORE the plugin (the dead-limiter regression)", async () => {
  const app = await buildAppTheWayServerTsDoes(3);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "198.51.100.10" } });
      statuses.push(r.statusCode);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    // And the header the platform never carried before is present.
    const r = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "198.51.100.11" } });
    assert.equal(r.headers["x-ratelimit-limit"], "3");
  } finally {
    await app.close();
  }
});

test("the OLD shape (global: true, routes declared first) really does not limit — documenting why", async () => {
  const app = Fastify({ logger: false });
  app.get("/declared-before-plugin", async () => ({ ok: true }));
  app.register(rateLimit, { max: 1, timeWindow: "1 minute" }); // the pre-2026-08-18 registration
  await app.ready();
  try {
    const a = await app.inject({ method: "GET", url: "/declared-before-plugin" });
    const b = await app.inject({ method: "GET", url: "/declared-before-plugin" });
    // If Fastify ever changes so that this starts limiting, the comment in
    // globalRateLimit.ts is out of date — but the fix stays correct either way.
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200, "the old registration shape never limited a route declared before it");
    assert.equal(a.headers["x-ratelimit-limit"], undefined);
  } finally {
    await app.close();
  }
});

test("buckets are per REAL client (last X-Forwarded-For), not per nginx hop", async () => {
  const app = await buildAppTheWayServerTsDoes(2);
  try {
    // Two clients, each under the ceiling, must not share a bucket.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      const r1 = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": ip } });
      const r2 = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": ip } });
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
    }
    // A spoofed FIRST entry does not mint a fresh bucket — the LAST entry is the peer.
    const s1 = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.9" } });
    const s2 = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "2.2.2.2, 203.0.113.9" } });
    const s3 = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "3.3.3.3, 203.0.113.9" } });
    assert.deepEqual([s1.statusCode, s2.statusCode, s3.statusCode], [200, 200, 429]);
  } finally {
    await app.close();
  }
});

test("internal callers (no X-Forwarded-For) and /internal/* are exempt", async () => {
  const app = await buildAppTheWayServerTsDoes(1);
  try {
    // No proxy header = docker peer (telephony/worker/health probe). Never limited.
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({ method: "GET", url: "/declared-before-plugin" });
      assert.equal(r.statusCode, 200, "header-less internal caller must never be limited");
    }
    // /internal/* even WITH a header (the PBX arrives through nginx).
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({ method: "GET", url: "/internal/telephony/thing", headers: { "x-forwarded-for": "209.145.60.79" } });
      assert.equal(r.statusCode, 200, "/internal/* must never be limited");
    }
  } finally {
    await app.close();
  }
});

test("the 429 body names the problem in plain English and stays JSON", async () => {
  const app = await buildAppTheWayServerTsDoes(1);
  try {
    await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "203.0.113.50" } });
    const r = await app.inject({ method: "GET", url: "/declared-before-plugin", headers: { "x-forwarded-for": "203.0.113.50" } });
    assert.equal(r.statusCode, 429);
    const body = r.json();
    assert.equal(body.error, "too_many_requests");
    assert.match(String(body.message), /slow down/i);
    assert.ok(r.headers["retry-after"], "Retry-After must be present so a client can back off");
  } finally {
    await app.close();
  }
});

// ─── pure rules ───────────────────────────────────────────────────────────────

test("resolveGlobalRateLimitKey: last entry wins; absent header is null (exempt)", () => {
  assert.equal(resolveGlobalRateLimitKey(undefined), null);
  assert.equal(resolveGlobalRateLimitKey(""), null);
  assert.equal(resolveGlobalRateLimitKey("203.0.113.5"), "203.0.113.5");
  assert.equal(resolveGlobalRateLimitKey("1.2.3.4, 203.0.113.5"), "203.0.113.5");
  assert.equal(resolveGlobalRateLimitKey(["1.2.3.4", "203.0.113.6"]), "203.0.113.6");
});

test("resolveGlobalRateLimitMax: default, override, 0 = disabled, junk = default (never unlimited)", () => {
  assert.equal(resolveGlobalRateLimitMax(undefined), DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE);
  assert.equal(resolveGlobalRateLimitMax(""), DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE);
  assert.equal(resolveGlobalRateLimitMax("900"), 900);
  assert.equal(resolveGlobalRateLimitMax("0"), 0);
  assert.equal(resolveGlobalRateLimitMax("lots"), DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE);
  assert.equal(resolveGlobalRateLimitMax("-5"), DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE);
});

test("the ceiling clears every legitimate per-IP peak ever measured (167/min) with room", () => {
  assert.ok(DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE >= 400, "sized against 4 days of nginx logs — see globalRateLimit.ts");
});

test("isGlobalRateLimitExempt: /internal/* with or without the /api prefix, nothing else", () => {
  assert.equal(isGlobalRateLimitExempt("/internal/cdr-ingest"), true);
  assert.equal(isGlobalRateLimitExempt("/api/internal/telephony/wake-extension?x=1"), true);
  assert.equal(isGlobalRateLimitExempt("/me"), false);
  assert.equal(isGlobalRateLimitExempt("/voice/internal-looking/thing"), false);
});

// ─── the call site ────────────────────────────────────────────────────────────

test("server.ts registers the plugin with global:false and installs the hook in after()", () => {
  const src = stripComments(readSrc("server.ts"));
  assert.ok(/app\.register\(rateLimit, \{ global: false \}\)/.test(src), "plugin must be registered global:false");
  assert.ok(!/app\.register\(rateLimit, \{ max: 200/.test(src), "the dead registration must be gone from CODE (comments may quote it)");
  const block = src.slice(src.indexOf("app.register(rateLimit, { global: false })"), src.indexOf("GLOBAL_RATE_LIMIT_ARMED"));
  assert.ok(block.length > 0 && block.length < 4000, "expected the registration block, got " + block.length + " chars");
  assert.match(block, /app\.after\(\(\) => \{/);
  assert.match(block, /addHook\("onRequest", \(app as any\)\.rateLimit\(buildGlobalRateLimitOptions\(max\)\)\)/);
});

test("server.ts refuses to boot on a missing or short JWT_SECRET and never falls back to a literal", () => {
  const src = stripComments(readSrc("server.ts"));
  assert.ok(!/"change-me"/.test(src), "the repo literal must not exist in server.ts CODE");
  assert.ok(/JWT_SECRET_VALUE\.length < 32/.test(src), "boot guard missing");
  assert.ok(/app\.register\(jwt, \{ secret: JWT_SECRET_VALUE \}\)/.test(src), "jwt must use the checked value");
});
