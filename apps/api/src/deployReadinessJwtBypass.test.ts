import assert from "node:assert";
import test from "node:test";
import { shouldSkipJwtVerification } from "./jwtPublicRouteBypass";

/**
 * Regression: blue/green polls GET /ready without Authorization.
 * Commit 6594d178 shipped /ready handler but omitted /ready from the JWT bypass
 * array — probes got 401. Bypass list lives in jwtPublicRouteBypass.ts next to /health.
 */
test("JWT bypass lists /ready and /api/ready beside /health for deploy probes", () => {
  assert.equal(shouldSkipJwtVerification("/health"), true);
  assert.equal(shouldSkipJwtVerification("/ready"), true);
  assert.equal(shouldSkipJwtVerification("/api/ready"), true);
});
