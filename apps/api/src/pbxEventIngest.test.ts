/**
 * PBX event ingest — pure-core tests (Phase 1, Step 1).
 *
 *   npm test --workspace @connect/api
 *
 * Covers: enable flag, validation/limits, redaction-before-store, idempotent
 * dedupe key, and in-batch dedupe. No DB / no Fastify boot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  PBX_EVENT_MAX_BATCH,
  PBX_EVENT_MAX_METADATA_BYTES,
  PBX_EVENT_REDACTION_VERSION,
  computePbxEventKey,
  isPbxEventIngestEnabled,
  normalizePbxEvent,
  normalizePbxEventBatch,
  pbxEventSchema,
  redactPbxEventMetadata,
} from "./pbxEventIngest";

const ISO = "2026-06-14T17:00:00.000Z";

function baseEvent(over: Record<string, unknown> = {}) {
  return {
    source: "ami",
    eventType: "Newchannel",
    occurredAt: ISO,
    linkedId: "1718384400.10",
    uniqueId: "1718384400.10",
    channel: "PJSIP/T8_102-00000abc",
    ...over,
  };
}

// ─── Enable flag ──────────────────────────────────────────────────────────────

test("ingest disabled by default (no env var)", () => {
  assert.equal(isPbxEventIngestEnabled({}), false);
});

test("ingest disabled for falsy values", () => {
  for (const v of ["0", "false", "no", "off", "", "  "]) {
    assert.equal(isPbxEventIngestEnabled({ PBX_EVENT_INGEST_ENABLED: v }), false, v);
  }
});

test("ingest enabled only for explicit truthy values", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(isPbxEventIngestEnabled({ PBX_EVENT_INGEST_ENABLED: v }), true, v);
  }
});

// ─── Validation / limits ──────────────────────────────────────────────────────

test("valid event passes schema", () => {
  assert.equal(pbxEventSchema.safeParse(baseEvent()).success, true);
});

test("event requires at least one correlation key", () => {
  const r = pbxEventSchema.safeParse(
    baseEvent({ linkedId: undefined, uniqueId: undefined }),
  );
  assert.equal(r.success, false);
});

test("event with only uniqueId is accepted", () => {
  const r = pbxEventSchema.safeParse(baseEvent({ linkedId: undefined }));
  assert.equal(r.success, true);
});

test("unknown top-level keys are stripped (not stored)", () => {
  const r = pbxEventSchema.safeParse(baseEvent({ password: "hunter2", secret: "x" }));
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal("password" in r.data, false);
    assert.equal("secret" in r.data, false);
  }
});

test("invalid source rejected", () => {
  assert.equal(pbxEventSchema.safeParse(baseEvent({ source: "kafka" })).success, false);
});

test("non-ISO occurredAt rejected", () => {
  assert.equal(
    pbxEventSchema.safeParse(baseEvent({ occurredAt: "yesterday" })).success,
    false,
  );
});

test("batch rejects empty events array", () => {
  const r = normalizePbxEventBatch({ events: [] });
  assert.equal(r.ok, false);
});

test("batch rejects over-limit size", () => {
  const events = Array.from({ length: PBX_EVENT_MAX_BATCH + 1 }, (_, i) =>
    baseEvent({ linkedId: `L${i}`, uniqueId: `U${i}` }),
  );
  const r = normalizePbxEventBatch({ events });
  assert.equal(r.ok, false);
});

test("batch accepts max size", () => {
  const events = Array.from({ length: PBX_EVENT_MAX_BATCH }, (_, i) =>
    baseEvent({ linkedId: `L${i}`, uniqueId: `U${i}`, channel: `c${i}` }),
  );
  const r = normalizePbxEventBatch({ events });
  assert.equal(r.ok, true);
});

// ─── Redaction before store ───────────────────────────────────────────────────

test("metadata secrets are redacted by key", () => {
  const out = redactPbxEventMetadata({
    password: "s3cr3t",
    secret: "abc",
    authToken: "xyz",
    callerId: "5551234",
  }) as Record<string, unknown>;
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.secret, "[REDACTED]");
  assert.equal(out.authToken, "[REDACTED]");
  assert.equal(out.callerId, "5551234"); // non-sensitive preserved
});

test("JWT-like metadata string is masked", () => {
  const out = redactPbxEventMetadata({
    note: "eyJhbGciOiJIUzI1Nid.eyJzdWIiOiIxMjM0NSJ9",
  }) as Record<string, unknown>;
  assert.equal(out.note, "[REDACTED_JWT]");
});

test("oversized metadata is truncated, not stored verbatim", () => {
  const big = "x".repeat(PBX_EVENT_MAX_METADATA_BYTES + 100);
  const out = redactPbxEventMetadata({ blob: big }) as Record<string, unknown>;
  assert.equal(out._truncated, true);
  assert.equal(out._reason, "metadata_too_large");
});

test("null metadata stays null", () => {
  assert.equal(redactPbxEventMetadata(null), null);
  assert.equal(redactPbxEventMetadata(undefined), null);
});

test("normalized event carries redaction version and redacted metadata", () => {
  const parsed = pbxEventSchema.parse(
    baseEvent({ metadata: { password: "p", channelVar: "ok" } }),
  );
  const row = normalizePbxEvent(parsed);
  assert.equal(row.redactionVersion, PBX_EVENT_REDACTION_VERSION);
  assert.equal((row.metadata as Record<string, unknown>).password, "[REDACTED]");
  assert.equal((row.metadata as Record<string, unknown>).channelVar, "ok");
});

// ─── Idempotent dedupe ────────────────────────────────────────────────────────

test("eventKey is deterministic for identical events", () => {
  const a = computePbxEventKey({
    source: "ami",
    eventType: "Hangup",
    linkedId: "L1",
    uniqueId: "U1",
    channel: "c1",
    occurredAt: ISO,
  });
  const b = computePbxEventKey({
    source: "ami",
    eventType: "Hangup",
    linkedId: "L1",
    uniqueId: "U1",
    channel: "c1",
    occurredAt: ISO,
  });
  assert.equal(a, b);
});

test("eventKey differs when any component differs", () => {
  const base = {
    source: "ami",
    eventType: "Hangup",
    linkedId: "L1",
    uniqueId: "U1",
    channel: "c1",
    occurredAt: ISO,
  };
  const k0 = computePbxEventKey(base);
  assert.notEqual(k0, computePbxEventKey({ ...base, eventType: "Newstate" }));
  assert.notEqual(k0, computePbxEventKey({ ...base, linkedId: "L2" }));
  assert.notEqual(k0, computePbxEventKey({ ...base, channel: "c2" }));
  assert.notEqual(k0, computePbxEventKey({ ...base, occurredAt: "2026-06-14T17:00:01.000Z" }));
});

test("duplicate events within a batch collapse to one row", () => {
  const e = baseEvent();
  const r = normalizePbxEventBatch({ events: [e, { ...e }, { ...e }] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.received, 3);
    assert.equal(r.rows.length, 1);
    assert.equal(r.deduped, 2);
  }
});

test("occurredAt is normalized to a Date and key uses canonical ISO", () => {
  const parsed = pbxEventSchema.parse(baseEvent({ occurredAt: "2026-06-14T17:00:00Z" }));
  const row = normalizePbxEvent(parsed);
  assert.ok(row.occurredAt instanceof Date);
  // Canonicalized form feeds the key, so equivalent timestamps dedupe.
  const expected = computePbxEventKey({
    source: "ami",
    eventType: "Newchannel",
    linkedId: "1718384400.10",
    uniqueId: "1718384400.10",
    channel: "PJSIP/T8_102-00000abc",
    occurredAt: new Date("2026-06-14T17:00:00Z").toISOString(),
  });
  assert.equal(row.eventKey, expected);
});
