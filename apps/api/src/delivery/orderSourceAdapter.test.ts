import { test } from "node:test";
import assert from "node:assert/strict";
import { MockOrderSourceAdapter } from "./orderSourceAdapter";

const a = new MockOrderSourceAdapter();

test("normalizes a well-formed created event", () => {
  const evt = a.normalizeEvent({
    type: "created",
    id: "SRC-1",
    storeRef: "elm-st",
    customer: { name: "Jo", phone: "+15551230000" },
    address: { line1: "142 Elm St", unit: "4B", instructions: "leave at door" },
    packages: [{ label: "t1" }, { label: "t2", tempSensitive: true }],
    flags: { signatureRequired: true },
    rawStatus: "OUT_FOR_DELIV",
  });
  assert.ok(evt);
  assert.equal(evt!.type, "created");
  assert.equal(evt!.sourceId, "SRC-1");
  assert.equal(evt!.order!.storeExternalRef, "elm-st");
  assert.equal(evt!.order!.address.unit, "4B");
  assert.equal(evt!.order!.packages!.length, 2);
  assert.equal(evt!.order!.flags!.signatureRequired, true);
  assert.equal(evt!.order!.rawStatus, "OUT_FOR_DELIV"); // raw source status preserved verbatim
});

test("cancel event needs no order body", () => {
  const evt = a.normalizeEvent({ type: "canceled", id: "SRC-2" });
  assert.ok(evt);
  assert.equal(evt!.type, "canceled");
  assert.equal(evt!.order, undefined);
});

test("rejects malformed payloads instead of guessing", () => {
  assert.equal(a.normalizeEvent(null), null);
  assert.equal(a.normalizeEvent({ type: "created" }), null); // no id
  assert.equal(a.normalizeEvent({ type: "created", id: "x", storeRef: "s" }), null); // no address.line1
  assert.equal(a.normalizeEvent({ type: "bogus", id: "x" }), null);
});

test("sampleOrders are deterministic and well-formed", () => {
  const s1 = a.sampleOrders("elm-st", 3);
  const s2 = a.sampleOrders("elm-st", 3);
  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 3);
  assert.equal(s1[0].order!.storeExternalRef, "elm-st");
});
