/**
 * The client-trace batch normaliser — the bounds ARE the safety, so each bound
 * is pinned here. A relaxed cap would let one chatty client write unbounded
 * rows; a missing clamp would let a replayed buffer land "in the past".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_TRACE_KINDS,
  MAX_CLIENT_SKEW_FUTURE_MS,
  MAX_CLIENT_SKEW_PAST_MS,
  MAX_EVENTS_PER_BATCH,
  normalizeClientTraceBatch,
} from "./clientTraceBatch";

const NOW = Date.parse("2026-09-03T15:00:00.000Z");

test("a well-formed batch becomes rows with kind, facts and a clamped timestamp", () => {
  const at = new Date(NOW - 5_000).toISOString();
  const b = normalizeClientTraceBatch(
    { sessionId: "sess1", events: [{ at, kind: "speaker_selected", facts: { id: "abcd1234", label: "Jabra Evolve2 (Hands-Free)", why: "setting" } }] },
    NOW,
  );
  assert.equal(b.sessionId, "sess1");
  assert.equal(b.rows.length, 1);
  assert.equal(b.dropped, 0);
  assert.equal(b.overflow, 0);
  assert.equal(b.rows[0].createdAt.getTime(), NOW - 5_000);
  assert.equal(b.rows[0].payload.kind, "speaker_selected");
  assert.equal(b.rows[0].payload.label, "Jabra Evolve2 (Hands-Free)");
  assert.equal(b.rows[0].payload.clientAt, at);
});

test("⛔ the per-batch cap holds and the overflow is COUNTED, never silently lost", () => {
  const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 17 }, (_, i) => ({ kind: "press", facts: { action: "dtmf", i } }));
  const b = normalizeClientTraceBatch({ sessionId: "s", events }, NOW);
  assert.equal(b.rows.length, MAX_EVENTS_PER_BATCH);
  assert.equal(b.overflow, 17);
});

test("⛔ an unknown kind is dropped — the allowlist IS the schema", () => {
  const b = normalizeClientTraceBatch(
    { sessionId: "s", events: [{ kind: "press", facts: {} }, { kind: "delete_everything", facts: {} }, { kind: "", facts: {} }, "junk", null] },
    NOW,
  );
  assert.equal(b.rows.length, 1);
  assert.equal(b.dropped, 4);
  for (const k of CLIENT_TRACE_KINDS) assert.equal(typeof k, "string");
});

test("⛔ a stale or future timestamp is stamped now — a replayed buffer cannot land in the past", () => {
  const tooOld = new Date(NOW - MAX_CLIENT_SKEW_PAST_MS - 1).toISOString();
  const tooNew = new Date(NOW + MAX_CLIENT_SKEW_FUTURE_MS + 1).toISOString();
  const fine = new Date(NOW - MAX_CLIENT_SKEW_PAST_MS + 1000).toISOString();
  const b = normalizeClientTraceBatch(
    { sessionId: "s", events: [{ at: tooOld, kind: "press" }, { at: tooNew, kind: "press" }, { at: fine, kind: "press" }, { at: "not a date", kind: "press" }] },
    NOW,
  );
  assert.equal(b.rows[0].createdAt.getTime(), NOW);
  assert.equal(b.rows[1].createdAt.getTime(), NOW);
  assert.equal(b.rows[2].createdAt.getTime(), Date.parse(fine));
  assert.equal(b.rows[3].createdAt.getTime(), NOW);
});

test("kind always wins over a facts.kind a client might send", () => {
  const b = normalizeClientTraceBatch({ sessionId: "s", events: [{ kind: "press", facts: { kind: "speaker_selected", action: "answer" } }] }, NOW);
  assert.equal(b.rows[0].payload.kind, "press");
  assert.equal(b.rows[0].payload.action, "answer");
});

test("strings are trimmed, nesting is bounded, non-finite numbers are nulled", () => {
  const long = "x".repeat(2000);
  const b = normalizeClientTraceBatch(
    { sessionId: "s", events: [{ kind: "device_inventory", facts: { label: long, n: Number.POSITIVE_INFINITY, deep: { a: { b: { c: 1 } } }, list: Array.from({ length: 100 }, (_, i) => i) } }] },
    NOW,
  );
  const p = b.rows[0].payload as Record<string, any>;
  assert.equal((p.label as string).length, 300);
  assert.equal(p.n, null);
  assert.deepEqual(p.deep, { a: {} });
  assert.equal((p.list as unknown[]).length, 40);
});

test("a body with no usable sessionId resolves to null so the route can answer 400", () => {
  assert.equal(normalizeClientTraceBatch({}, NOW).sessionId, null);
  assert.equal(normalizeClientTraceBatch(null, NOW).sessionId, null);
  assert.equal(normalizeClientTraceBatch({ sessionId: "   ", events: [] }, NOW).sessionId, null);
  assert.equal(normalizeClientTraceBatch({ sessionId: "x".repeat(65), events: [] }, NOW).sessionId, null);
  assert.equal(normalizeClientTraceBatch({ sessionId: "ok", events: "nope" }, NOW).rows.length, 0);
});
