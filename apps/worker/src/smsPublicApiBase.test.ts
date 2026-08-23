/**
 * Guards for the SMS/MMS public API base — the 2026-08-19 regression where
 * `PUBLIC_API_URL` (a bare origin, worker-only) entered the chain and every
 * MMS media URL lost its `/api`, 404ing at VoIP.ms. See
 * docs/ai-context/AGENT_HANDOFF_HANNA_FIRST_CALLS_2026-08-21.md §2.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSmsPublicApiBase, resolveSmsPortalOrigin } from "./smsPublicApiBase";

test("THE PRODUCTION FAILURE: a bare-origin PUBLIC_API_URL gets /api appended", () => {
  // Exactly what .env.platform:34 held from ~April to 2026-08-23.
  assert.strictEqual(
    resolveSmsPublicApiBase({ PUBLIC_API_URL: "https://app.connectcomunications.com" }),
    "https://app.connectcomunications.com/api",
  );
});

test("the corrected env value passes through untouched", () => {
  assert.strictEqual(
    resolveSmsPublicApiBase({ PUBLIC_API_URL: "https://app.loopcom.net/api" }),
    "https://app.loopcom.net/api",
  );
});

test("no env at all → canonical default with /api (the pre-regression behaviour)", () => {
  assert.strictEqual(resolveSmsPublicApiBase({}), "https://app.connectcomunications.com/api");
});

test("a bare-origin value in ANY chain position is repaired", () => {
  assert.strictEqual(
    resolveSmsPublicApiBase({ PUBLIC_API_BASE_URL: "https://app.loopcom.net/" }),
    "https://app.loopcom.net/api",
  );
  assert.strictEqual(
    resolveSmsPublicApiBase({ API_PUBLIC_URL: "https://app.loopcom.net" }),
    "https://app.loopcom.net/api",
  );
});

test("a value that already carries a path is never rewritten", () => {
  assert.strictEqual(
    resolveSmsPublicApiBase({ PUBLIC_API_BASE_URL: "https://api.example.com/v2" }),
    "https://api.example.com/v2",
  );
});

test("chain precedence: PUBLIC_API_BASE_URL > API_PUBLIC_URL > PUBLIC_API_URL > portal origin", () => {
  assert.strictEqual(
    resolveSmsPublicApiBase({
      PUBLIC_API_BASE_URL: "https://a.example.com/api",
      API_PUBLIC_URL: "https://b.example.com/api",
      PUBLIC_API_URL: "https://c.example.com/api",
    }),
    "https://a.example.com/api",
  );
  assert.strictEqual(
    resolveSmsPublicApiBase({ PUBLIC_PORTAL_URL: "https://app.loopcom.net" }),
    "https://app.loopcom.net/api",
  );
});

test("blank/whitespace env values fall through instead of winning the chain", () => {
  assert.strictEqual(
    resolveSmsPublicApiBase({ PUBLIC_API_BASE_URL: "  ", PUBLIC_API_URL: "" }),
    "https://app.connectcomunications.com/api",
  );
});

test("an unparseable value is left exactly as configured (old behaviour)", () => {
  assert.strictEqual(resolveSmsPublicApiBase({ PUBLIC_API_URL: "not a url" }), "not a url");
});

test("portal origin resolver keeps its own chain and default", () => {
  assert.strictEqual(resolveSmsPortalOrigin({}), "https://app.connectcomunications.com");
  assert.strictEqual(
    resolveSmsPortalOrigin({ PUBLIC_PORTAL_URL: "https://app.loopcom.net/" }),
    "https://app.loopcom.net",
  );
});

test("SOURCE GUARD: connectChatSmsJob derives publicBase through the guarded helper, never an inline chain", () => {
  // The defect was the CALLER's inline chain — a unit test of a helper passes
  // straight through a reintroduced inline derivation. CRLF-normalised read.
  const src = readFileSync(join(__dirname, "connectChatSmsJob.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes("resolveSmsPublicApiBase(process.env)"), "must call the guarded resolver");
  const noComments = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/publicBase\s*=\s*\(\s*process\.env/.test(noComments),
    "the inline publicBase env chain must not return to connectChatSmsJob.ts",
  );
});
