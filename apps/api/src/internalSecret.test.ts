import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkInternalSecret } from "./internalSecret";

const SERVER_TS = readFileSync(path.join(__dirname, "server.ts"), "utf8");
const COMPOSE = readFileSync(
  path.join(__dirname, "..", "..", "..", "docker-compose.app.yml"),
  "utf8",
);

// ── the verdicts themselves ──────────────────────────────────────────────────

test("no secret configured => CLOSED (503), never allowed", () => {
  for (const configured of [undefined, null, "", "   ", "\t\n"]) {
    for (const incoming of [undefined, null, "", "anything", "guess"]) {
      const v = checkInternalSecret(configured as any, incoming as any);
      assert.equal(v.ok, false, `unset secret must never allow (incoming=${String(incoming)})`);
      assert.equal(v.reason, "not_configured");
      assert.equal((v as any).status, 503);
    }
  }
});

test("secret configured, header absent => 401", () => {
  for (const incoming of [undefined, null, "", "   "]) {
    const v = checkInternalSecret("s3cret-value", incoming as any);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "missing");
    assert.equal((v as any).status, 401);
  }
});

test("secret configured, header wrong => 403", () => {
  for (const incoming of ["nope", "s3cret-valu", "s3cret-value ".repeat(3), "S3CRET-VALUE"]) {
    const v = checkInternalSecret("s3cret-value", incoming);
    assert.equal(v.ok, false, `must reject ${incoming}`);
    assert.equal(v.reason, "mismatch");
    assert.equal((v as any).status, 403);
  }
});

test("secret configured, header correct => ok (whitespace tolerated on both sides)", () => {
  assert.equal(checkInternalSecret("s3cret-value", "s3cret-value").ok, true);
  assert.equal(checkInternalSecret("  s3cret-value  ", " s3cret-value ").ok, true);
});

test("length-independent: a long secret is compared in full, not truncated at 64", () => {
  const long = "a".repeat(200);
  assert.equal(checkInternalSecret(long, long).ok, true);
  // The old inline form did padEnd(64).slice(0, 64) and would have called these
  // two EQUAL. Any regression to a fixed-width buffer fails right here.
  assert.equal(checkInternalSecret(long, "a".repeat(199) + "b").ok, false);
  assert.equal(checkInternalSecret("a".repeat(64) + "X", "a".repeat(64) + "Y").ok, false);
});

// ── the CALL SITES ───────────────────────────────────────────────────────────
// A unit test of the helper passes straight through a caller that never calls
// it — which is precisely how this door stayed open. These read server.ts's
// source, the same shape as sipPublicEndpoint.test.ts / applyRegenRebake.

const GUARDED_ENDPOINTS = [
  "/internal/cdr-ingest",
  "/internal/mobile-ring-notify",
  "/internal/mobile-prewake",
  "/internal/pbx/publish-wake-config",
  "/internal/pbx/wake-extension",
  "/internal/telephony/pbx-tenant-map",
  "/internal/pbx/contact-status",
  "/internal/chat/sms-system-reply",
];

test("every /internal/* door routes through the shared guard", () => {
  for (const ep of GUARDED_ENDPOINTS) {
    assert.ok(
      SERVER_TS.includes(`guardInternalSecret(req, reply, "${ep}")`),
      `${ep} must call guardInternalSecret — an inline copy is how the fail-open survived`,
    );
  }
});

test("server.ts has no fail-open internal-secret branch left", () => {
  assert.ok(
    !SERVER_TS.includes("internal endpoint is unauthenticated"),
    "the fail-open warn line means a door still allows callers when the secret is unset",
  );
  assert.ok(
    !/if \(!secret\) return true;/.test(SERVER_TS),
    "verifyCdrSecret must not allow-on-missing",
  );
  assert.ok(
    !/const secret = process\.env\.CDR_INGEST_SECRET\?\.trim\(\);\s*\n\s*const incoming = String\(\(req\.headers/.test(
      SERVER_TS,
    ),
    "an inline x-cdr-secret comparison has been reintroduced — use guardInternalSecret",
  );
});

test("verifyCdrSecret delegates to checkInternalSecret", () => {
  const fn = SERVER_TS.slice(
    SERVER_TS.indexOf("function verifyCdrSecret"),
    SERVER_TS.indexOf("function guardInternalSecret"),
  );
  assert.ok(fn.length > 0, "verifyCdrSecret must still exist");
  assert.ok(fn.includes("checkInternalSecret("), "verifyCdrSecret must use the shared helper");
  assert.ok(!fn.includes("return true;"), "no unconditional allow");
});

test("the guard is not gated on NODE_ENV (this container sets none)", () => {
  const region = SERVER_TS.slice(
    SERVER_TS.indexOf("function verifyCdrSecret"),
    SERVER_TS.indexOf("function guardInternalSecret") + 1800,
  );
  assert.ok(!region.includes("NODE_ENV"), "NODE_ENV gates are permanently false in apps/api");
});

// ── the ENVIRONMENT the guard reads ──────────────────────────────────────────
// The secret lives in /opt/connectcomms/env/.env.platform. `environment:` wins
// over `env_file:`, so an `environment:` entry substituted from the deploy
// shell (which never sources .env.platform) silently forced it to "".

test("no compose service overrides CDR_INGEST_SECRET back to empty", () => {
  const live = COMPOSE.split("\n").filter(
    (l) => !l.trimStart().startsWith("#") && l.includes("CDR_INGEST_SECRET:"),
  );
  assert.deepEqual(
    live,
    [],
    `CDR_INGEST_SECRET must come from env_file only; found: ${JSON.stringify(live)}`,
  );
});

test("api, api_candidate, telephony and worker all read .env.platform", () => {
  const count = (COMPOSE.match(/- \/opt\/connectcomms\/env\/\.env\.platform/g) || []).length;
  assert.ok(count >= 4, `expected env_file on api/api_candidate/telephony/worker, found ${count}`);
});
