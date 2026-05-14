import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readServerTs(): string {
  const candidates = [
    path.join(process.cwd(), "src", "server.ts"),
    path.join(process.cwd(), "apps", "api", "src", "server.ts"),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`server.ts not found (cwd=${process.cwd()})`);
  return readFileSync(hit, "utf8");
}

/**
 * Regression guard: blue/green polls GET /ready without Authorization.
 * The JWT preHandler allowlist lives in server.ts next to "/health".
 */
test("server.ts JWT bypass lists /ready beside /health for deploy probes", () => {
  const serverTs = readServerTs();
  assert.match(
    serverTs,
    /"\/health",\s*\n\s*\/\/[^\n]*\n\s*"\/ready",/,
    'expected "/ready" in JWT preHandler allowlist immediately after "/health"',
  );
});
