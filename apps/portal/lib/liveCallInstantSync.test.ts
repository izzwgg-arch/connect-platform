/**
 * Instant hangup sync on the portal (2026-08-31).
 *
 * Guards for the "somebody hung up and Active Calls / Team Directory kept
 * showing On Call for up to a minute" fixes:
 *
 *  1. createCallSeqTracker — pure ordering rules for the /ws/telephony call
 *     stream: a `call.upsert` DELIVERED after the call's `call.remove` (the
 *     server enriches upserts asynchronously) must be dropped, or the dead
 *     call resurrects until the server's next sweep.
 *  2. Source guards: useTelephonySocket actually USES the tracker (a pure
 *     helper nobody calls guards nothing), and the /pbx page's Active Calls
 *     render rides the live WS feed — never the 60s-polled HTTP payload.
 *
 * Run: npx tsx --test lib/liveCallInstantSync.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCallSeqTracker } from "../services/callStreamOrder";

// Source-reading tests MUST normalise CRLF (Windows checkouts) — see
// [[source-reading-tests-must-normalise-crlf]].
function readSource(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

// ── 1. Pure ordering rules ──────────────────────────────────────────────────

test("THE RACE: an upsert delivered after the remove is dropped", () => {
  const t = createCallSeqTracker();
  assert.equal(t.acceptUpsert("c1", 1), true, "first upsert applies");
  t.noteRemove("c1", 2); // hangup remove (sent synchronously, higher seq)
  assert.equal(t.acceptUpsert("c1", 1), false, "the stale enriched upsert must NOT resurrect the call");
});

test("a legitimately newer upsert after a remove is applied (tenant-correction re-add)", () => {
  const t = createCallSeqTracker();
  t.acceptUpsert("c1", 1);
  t.noteRemove("c1", 2);
  assert.equal(t.acceptUpsert("c1", 3), true, "the re-add for the corrected tenant has a newer seq and must pass");
});

test("out-of-order upserts: the older delivery is dropped, the newer applied", () => {
  const t = createCallSeqTracker();
  assert.equal(t.acceptUpsert("c1", 2), true);
  assert.equal(t.acceptUpsert("c1", 1), false);
  assert.equal(t.acceptUpsert("c1", 3), true);
});

test("messages WITHOUT a seq (older server) are always applied — never stricter than the server", () => {
  const t = createCallSeqTracker();
  t.noteRemove("c1", 5);
  assert.equal(t.acceptUpsert("c1", undefined), true);
  assert.equal(t.acceptUpsert("c1", null), true);
  assert.equal(t.acceptUpsert("c1", "junk"), true);
  t.noteRemove("c1", undefined); // must not throw or corrupt state
  assert.equal(t.acceptUpsert("c1", 6), true);
});

test("reset() forgets everything — a reconnected server restarts its counters at 1", () => {
  const t = createCallSeqTracker();
  t.acceptUpsert("c1", 50);
  t.reset();
  assert.equal(t.acceptUpsert("c1", 1), true, "post-snapshot, seq 1 from the fresh server must apply");
});

test("independent calls never interfere", () => {
  const t = createCallSeqTracker();
  t.noteRemove("c1", 9);
  assert.equal(t.acceptUpsert("c2", 1), true);
});

test("the tombstone map is bounded (oldest entries pruned at the cap)", () => {
  const t = createCallSeqTracker(10);
  for (let i = 0; i < 25; i++) t.acceptUpsert(`c${i}`, 1);
  assert.ok(t.size() <= 10, `size ${t.size()} must stay at/under the cap`);
  // The newest entries survive.
  assert.equal(t.acceptUpsert("c24", 1), false, "newest entry's seq is still remembered");
});

// ── 2. Wiring guards ────────────────────────────────────────────────────────

test("WIRING: useTelephonySocket routes call messages through the seq tracker and resets on snapshots", () => {
  const src = readSource("hooks/useTelephonySocket.ts");
  assert.ok(src.includes("createCallSeqTracker"), "the hook must build the tracker");
  assert.ok(src.includes(".acceptUpsert("), "upserts must be gated through acceptUpsert");
  assert.ok(src.includes(".noteRemove("), "removes must record their seq");
  const resetCount = (src.match(/\.reset\(\)/g) ?? []).length;
  assert.ok(resetCount >= 2, "BOTH snapshot paths (telephony.snapshot + telephony.calls.snapshot) must reset the tracker");
});

test("WIRING: the /pbx Active Calls table rides the live WS feed, not the 60s HTTP poll", () => {
  const src = readSource("app/(platform)/pbx/page.tsx");
  assert.ok(src.includes("useTelephony()"), "the page must consume the telephony WS context");
  assert.ok(src.includes("callsForTenant(telephony.activeCalls"), "active calls must come from the WS feed, tenant-scoped");
  assert.ok(
    !src.includes("activeCalls?.calls"),
    "the polled combined payload's activeCalls must no longer be rendered — that was the literal 'stays there for a minute'",
  );
});
