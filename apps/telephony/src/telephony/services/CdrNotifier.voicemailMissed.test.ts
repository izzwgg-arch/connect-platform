import assert from "node:assert/strict";
import { test } from "node:test";

// Env bootstrap — env.ts validates on import (same pattern as
// MobilePushNotifier.test.ts). Must run before requiring CdrNotifier.
process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deriveDisposition, isVoicemailOnlyAnswer } = require("./CdrNotifier") as typeof import("./CdrNotifier");
import type { NormalizedCall } from "../types";

// Minimal NormalizedCall factory — only fields deriveDisposition touches.
function call(overrides: Partial<NormalizedCall> & { metadata?: Record<string, unknown> }): NormalizedCall {
  return {
    id: "l1", linkedId: "l1", tenantId: null, tenantSlug: null, tenantName: null,
    direction: "inbound", state: "hungup", from: "8455551234", fromName: null,
    fromPrefix: null, to: "110", connectedLine: null, source_extension: null,
    destination_extension: null, channelState: null, channels: [], bridgeIds: [],
    extensions: [], queueId: null, trunk: null,
    startedAt: "2026-07-28T12:54:45.000Z",
    answeredAt: "2026-07-28T12:55:03.000Z",
    endedAt: "2026-07-28T12:55:06.000Z",
    durationSec: 21, billableSec: 3,
    metadata: {},
    ...overrides,
  } as NormalizedCall;
}

// Leg shapes mirror what CallStateStore.onCdr accumulates into metadata.cdrLegs
// (verified against live VitalPBX CDR rows, 2026-07-28).
const DIAL_NO_ANSWER = { source: "8455551234", destination: "110", dcontext: "T2_ivr-only-extensions", duration: 9, billableSec: 0, disposition: "NO ANSWER", lastApplication: "Dial" };
const VM_ANSWERED = { source: "8455551234", destination: "110", dcontext: "T2_ivr-only-extensions", duration: 3, billableSec: 3, disposition: "ANSWERED", lastApplication: "VoiceMail" };
const VM_DEST_ANSWERED = { source: "8455551234", destination: "VM-105", dcontext: "T2_did-direct", duration: 14, billableSec: 14, disposition: "ANSWERED", lastApplication: "VoiceMail" };
const DIAL_ANSWERED = { source: "8455551234", destination: "110", dcontext: "T2_ivr-only-extensions", duration: 20, billableSec: 19, disposition: "ANSWERED", lastApplication: "Dial" };

test("ring-to-voicemail (Dial NO ANSWER + VoiceMail ANSWERED) → missed", () => {
  const c = call({ metadata: { cdrDisposition: "ANSWERED", cdrLegs: [DIAL_NO_ANSWER, VM_ANSWERED] } });
  assert.equal(isVoicemailOnlyAnswer(c), true);
  assert.equal(deriveDisposition(c, "incoming"), "missed");
});

test("direct-to-voicemail (VM- destination) → missed", () => {
  const c = call({ metadata: { cdrDisposition: "ANSWERED", cdrLegs: [VM_DEST_ANSWERED] } });
  assert.equal(deriveDisposition(c, "incoming"), "missed");
});

test("human answered → stays answered", () => {
  const c = call({ metadata: { cdrDisposition: "ANSWERED", cdrLegs: [DIAL_ANSWERED] } });
  assert.equal(isVoicemailOnlyAnswer(c), false);
  assert.equal(deriveDisposition(c, "incoming"), "answered");
});

test("answered then transferred to VM later → stays answered (mixed legs)", () => {
  const c = call({ metadata: { cdrDisposition: "ANSWERED", cdrLegs: [DIAL_ANSWERED, VM_ANSWERED] } });
  assert.equal(deriveDisposition(c, "incoming"), "answered");
});

test("outgoing call is never reclassified by the VM rule", () => {
  const c = call({ direction: "outbound", metadata: { cdrDisposition: "ANSWERED", cdrLegs: [VM_ANSWERED] } });
  assert.equal(deriveDisposition(c, "outgoing"), "answered");
});

test("no legs (early notify before Cdr events) → unchanged legacy behavior", () => {
  const c = call({ metadata: { cdrDisposition: "ANSWERED" } });
  assert.equal(deriveDisposition(c, "incoming"), "answered");
});

test("legacy legs without lastApplication → unchanged legacy behavior", () => {
  const legacyLeg = { source: "8455551234", destination: "110", dcontext: "T2_x", duration: 3, billableSec: 3, disposition: "ANSWERED" };
  const c = call({ metadata: { cdrDisposition: "ANSWERED", cdrLegs: [legacyLeg] } });
  assert.equal(deriveDisposition(c, "incoming"), "answered");
});

test("outgoing NO ANSWER is canceled, never missed", () => {
  const c = call({ direction: "outbound", answeredAt: null, metadata: { cdrDisposition: "NO ANSWER" } });
  assert.equal(deriveDisposition(c, "outgoing"), "canceled");
});

test("incoming NO ANSWER stays missed", () => {
  const c = call({ answeredAt: null, metadata: { cdrDisposition: "NO ANSWER" } });
  assert.equal(deriveDisposition(c, "incoming"), "missed");
});
