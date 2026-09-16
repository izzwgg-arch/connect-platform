/**
 * The backup-route admin door (unified messaging Phase 1, 2026-09-16).
 *
 * `PATCH /admin/apps/voip-ms/numbers/:id` grew `fallbackProvider`. These
 * guards read SOURCE (raw, not comment-stripped — the repo's comment-stripper
 * rule) because every rule is a caller-side gate in the route body:
 *
 *  - ⛔ SUPER_ADMIN ONLY: carrier routing is a platform decision and carrier
 *    names must never surface to customers (Izzy, 2026-09-16) — a tenant
 *    admin can neither read nor set which carrier backs their number.
 *  - ⛔ Only registry-backed adapters are legal targets (SIGNALWIRE, TELNYX):
 *    VOIPMS is absent on purpose until its send path becomes an adapter, so
 *    the door cannot arm a backup the worker would silently refuse.
 *  - ⛔ A backup equal to the primary is refused — it would "fire" into the
 *    exact carrier that just failed.
 *  - The worker actually READS the column (a settable field nobody reads is
 *    a lie in the UI).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const ROUTES = norm(readFileSync(join(__dirname, "..", "connectChatRoutes.ts"), "utf8"));
const WORKER_JOB = norm(readFileSync(join(__dirname, "..", "..", "..", "worker", "src", "connectChatSmsJob.ts"), "utf8"));

function patchRouteBody(): string {
  const start = ROUTES.indexOf('app.patch("/admin/apps/voip-ms/numbers/:id"');
  assert.ok(start > -1, "the numbers PATCH route exists");
  const end = ROUTES.indexOf("app.get(", start);
  return ROUTES.slice(start, end > start ? end : undefined);
}

test("fallbackProvider accepts ONLY registry-backed carriers — VOIPMS deliberately absent", () => {
  const body = patchRouteBody();
  const zodLine = body.match(/fallbackProvider:\s*z\.enum\(\[([^\]]*)\]\)/);
  assert.ok(zodLine, "fallbackProvider is a closed enum");
  const values = zodLine![1]!.replace(/["'\s]/g, "").split(",").filter(Boolean).sort();
  assert.deepEqual(values, ["SIGNALWIRE", "TELNYX"]);
  assert.ok(!zodLine![1]!.includes("VOIPMS"), "VOIPMS is not a legal backup target yet");
});

test("setting a backup route is SUPER_ADMIN only — tenant admins never touch carrier routing", () => {
  const body = patchRouteBody();
  const gate = body.indexOf("body.fallbackProvider !== undefined && !isSuper(user)");
  assert.ok(gate > -1, "the platform-only gate exists");
  assert.ok(body.slice(gate, gate + 400).includes('"PLATFORM_ONLY"'), "and it refuses with PLATFORM_ONLY");
  const write = body.indexOf("fallbackProvider: body.fallbackProvider");
  assert.ok(write > gate, "the write happens only after the gate");
});

test("a backup equal to the number's primary carrier is refused", () => {
  const body = patchRouteBody();
  assert.ok(body.includes('"FALLBACK_EQUALS_PRIMARY"'), "the equals-primary refusal exists");
  assert.ok(
    body.indexOf('"FALLBACK_EQUALS_PRIMARY"') < body.indexOf("fallbackProvider: body.fallbackProvider"),
    "and it runs before the write",
  );
});

test("the numbers GET hands carrier identity to SUPER_ADMIN only", () => {
  const start = ROUTES.indexOf('app.get("/admin/apps/voip-ms/numbers"');
  const end = ROUTES.indexOf("app.patch(", start);
  const body = ROUTES.slice(start, end);
  assert.ok(body.includes("...(isSuper(user) ? { provider:"), "carrier fields ride a super-only spread");
  // fallbackProvider must appear ONLY inside that spread — a second, plain
  // projection line would hand the carrier to tenant admins.
  const mentions = body.split("fallbackProvider").length - 1;
  assert.equal(mentions, 3, "exactly the spread's three mentions (key + ternary value), nothing unconditional");
  // And every mention lives INSIDE the super-only spread expression.
  const spreadStart = body.indexOf("...(isSuper(user) ? {");
  const spreadEnd = body.indexOf("} : {})", spreadStart);
  const before = body.slice(0, spreadStart).includes("fallbackProvider");
  const after = body.slice(spreadEnd).includes("fallbackProvider");
  assert.equal(before || after, false, "no fallbackProvider outside the super-only spread");
});

test("the worker actually reads fallbackProvider — the toggle is not decorative", () => {
  assert.ok(WORKER_JOB.includes("fallbackProvider"), "connectChatSmsJob reads the column");
  assert.ok(WORKER_JOB.includes("attemptProviderFallback"), "and routes it into the backup-route decision");
});
