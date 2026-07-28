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

test("DND direction: enable by default", () => {
  const i = detectIntent("put my phone on do not disturb please, ext 101");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, "yes");
});

test("DND direction: 'turn off' disables", () => {
  const i = detectIntent("turn off dnd on ext 101");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, "no");
});

test("DND direction: 'out of' disables", () => {
  const i = detectIntent("take my phone out of do not disturb");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, "no");
});

test("DND direction: 'cancel' disables", () => {
  const i = detectIntent("please cancel do not disturb for extension 102");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, "no");
});

test("non-DND actions carry no enableHint", () => {
  const i = detectIntent("forward my calls to extension 204");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, undefined);
});

test("MOH: 'change our hold music to Jazz' is an activate request", () => {
  const i = detectIntent("please change our hold music to Jazz");
  assert.equal(i.kind, "action");
  if (i.kind === "action") {
    assert.equal(i.actionType, "moh");
    assert.equal(i.enableHint, "yes");
  }
});

test("MOH: 'music on hold' phrasing also matches", () => {
  const i = detectIntent("can you switch the music on hold to Classical");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.actionType, "moh");
});

test("MOH direction: 'back to normal' deactivates", () => {
  const i = detectIntent("set our hold music back to normal");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, "no");
});

test("MOH direction: 'turn off the holiday hold music' deactivates", () => {
  const i = detectIntent("turn off the holiday hold music");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.enableHint, "no");
});

test("action intent: IVR/menu phrases route to the pbx_config flow (M4 first crack)", () => {
  const i = detectIntent("please put on the holiday menu until the 25th");
  assert.equal(i.kind, "action");
  // Since 2026-07-28 menu/IVR language goes to the catalog-grounded pbx_config
  // flow (real M4 ops); phrases it declines fall back to the legacy A3 path.
  if (i.kind === "action") assert.equal(i.actionType, "pbx_config");
  const j = detectIntent("switch to night mode please");
  assert.equal(j.kind, "action");
  if (j.kind === "action") assert.equal(j.actionType, "ivr_switch");
});

test("action intent: routing verb + bare DID lands in pbx_config (loose M3 fallback)", () => {
  // Live miss 2026-07-28: "Now route 845 251 0249 to extension 101" escalated
  // to the human team because no term matched the bare-DID phrasing.
  const i = detectIntent("Now route 845 251 0249 to extension 101");
  assert.equal(i.kind, "action");
  if (i.kind === "action") assert.equal(i.actionType, "pbx_config");
  const j = detectIntent("point 8455577768 to the sales team");
  assert.equal(j.kind, "action");
  if (j.kind === "action") assert.equal(j.actionType, "pbx_config");
  // Texting verbs must NOT land in pbx_config.
  const k = detectIntent("send a text message to 8455577768 saying we are closed");
  assert.notEqual((k as any).actionType, "pbx_config");
});

test("plain conversation is not misclassified", () => {
  assert.equal(detectIntent("hi, what are your office hours?").kind, "chat");
  assert.equal(detectIntent("thank you so much").kind, "chat");
});
