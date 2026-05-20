import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("worker reuses shared billing gateway resolver", () => {
  const src = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
  assert.match(src, /getBillingSolaAdapter/);
  assert.doesNotMatch(src, /getWorkerSolaAdapterForTenant\s*\(/);
});
