/**
 * Every `/internal/agent/*` door the assistant calls must skip the JWT hook.
 *
 * ⛔ THIS IS A CALLER-SIDE BUG THAT HAS ALREADY SHIPPED TWICE. The door
 * authenticates itself with a shared secret, but the global JWT preHandler runs
 * BEFORE routing — so a door missing from the bypass list answers 401 and its
 * own secret check never runs. The agent then reports a vague "I couldn't
 * retrieve that right now" forever, and nothing in the api logs looks wrong.
 *
 * Tell the two apart by the status: these doors answer 403 on a bad secret, so
 * a 401 means you never reached the handler.
 *
 * A unit test of the door itself passes straight through this — the defect is
 * in the list, not the handler. Hence this file: it reads the SOURCE of the
 * route module and asserts every path it registers is bypassed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

/** Every path literal the provisioning route module registers. */
function registeredInternalAgentPaths(): string[] {
  const source = readFileSync(join(__dirname, "accountSetupInfoRoute.ts"), "utf8");
  return [...source.matchAll(/app\.(?:post|get)\(\s*"(\/internal\/agent\/[^"]+)"/g)].map((m) => m[1]);
}

test("every internal agent door this module registers skips the JWT hook", () => {
  const paths = registeredInternalAgentPaths();
  assert.ok(paths.length >= 2, `expected to find the registered doors, got ${JSON.stringify(paths)}`);
  for (const p of paths) {
    assert.equal(shouldSkipJwtVerification(p), true, `${p} would answer 401 before its own secret check runs`);
    // nginx forwards the /api prefix too — both spellings must bypass.
    assert.equal(shouldSkipJwtVerification(`/api${p}`), true, `/api${p} must bypass as well`);
  }
});

test("the doors the assistant depends on are named explicitly", () => {
  // Named rather than derived, so deleting a door from the source cannot make
  // this file silently assert nothing.
  for (const p of [
    "/internal/agent/account-setup-info",
    "/internal/agent/search-phone-numbers",
  ]) {
    assert.equal(shouldSkipJwtVerification(p), true, p);
  }
});

test("⛔ a door that does not exist is still NOT bypassed", () => {
  // The list must stay a list, not a prefix rule — a blanket
  // /internal/agent/* bypass would open any future door before it is reviewed.
  assert.equal(shouldSkipJwtVerification("/internal/agent/not-a-real-door"), false);
  assert.equal(shouldSkipJwtVerification("/internal/agent/"), false);
});
