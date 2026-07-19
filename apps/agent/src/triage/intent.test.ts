import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIntent } from "./intent";

test("diagnostic intent: English 'not ringing'", () => {
  const i = detectIntent("my phone is not ringing when customers call ext 204");
  assert.equal(i.kind, "diagnostic");
  if (i.kind === "diagnostic") assert.equal(i.extensionHint, "204");
});

test("diagnostic intent: Yiddish", () => {
  const i = detectIntent("דער טעלעפאן קלינגט נישט");
  assert.equal(i.kind, "diagnostic");
});

test("action intent: forwarding with target + until", () => {
  const i = detectIntent("forward my calls to extension 204 until tomorrow morning");
  assert.equal(i.kind, "action");
  if (i.kind === "action") {
    assert.equal(i.actionType, "forward");
    assert.equal(i.targetHint, "204");
    assert.match(i.untilHint ?? "", /tomorrow/);
  }
});

test("action intent: DND", () => {
  const i = detectIntent("turn on do not disturb for ext 101");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.actionType, "dnd");
});

test("action intent: IVR switch", () => {
  const i = detectIntent("please put on the holiday menu until the 25th");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.actionType, "ivr_switch");
});

test("plain conversation is not misclassified", () => {
  assert.equal(detectIntent("hi, what are your office hours?").kind, "chat");
  assert.equal(detectIntent("thank you so much").kind, "chat");
});
