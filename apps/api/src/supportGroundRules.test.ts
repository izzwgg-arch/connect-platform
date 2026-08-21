/**
 * The Ground Rules — the executable half of the owner's rulebook.
 *
 * These tests are the real safety net for Phase 5c: the execution engine will
 * call `classifyAction` before doing anything, so the ORDER of the three lists
 * and the fail-safe default are the properties that keep production intact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GROUND_RULES,
  classifyAction,
  normaliseRulesInput,
  parseRuleLines,
  renderGroundRulesForAgent,
  MAX_RULES_BLOCK_CHARS,
} from "./supportGroundRules";

test("parseRuleLines tolerates bullets, blank lines and stray spacing", () => {
  const out = parseRuleLines("- one\n\n  * two  \n• three\n   \nfour");
  assert.deepEqual(out, ["one", "two", "three", "four"]);
});

test("⛔ an action matching NOTHING is ask_first — never allowed by default", () => {
  const v = classifyAction(DEFAULT_GROUND_RULES, "recalibrate the flux capacitor");
  assert.equal(v.decision, "ask_first");
  assert.equal(v.matchedRule, null);
  assert.match(v.reason, /say-so/);
});

test("⛔ NEVER beats ASK beats ALLOWED, whatever else also matches", () => {
  const rules = {
    allowed: "Read files on the Connect server",
    askFirst: "Restart any container",
    never: "Write to the PBX",
  };
  // Hits allowed (read files) AND ask-first (restart container) → must ASK.
  const both = classifyAction(rules, "restart the api container after reading the log files");
  assert.equal(both.decision, "ask_first");
  // Hits allowed (read) AND never (write PBX) → must be NEVER.
  const never = classifyAction(rules, "read the file then write it to the PBX");
  assert.equal(never.decision, "never");
});

test("⛔⛔ the verb decides: reading the PBX is allowed, writing to it never is", () => {
  // This is the whole reason the matcher understands verbs. A noun-only matcher
  // sees "PBX" in both rules and refuses the read the rulebook permits.
  assert.equal(classifyAction(DEFAULT_GROUND_RULES, "read the PBX extension list").decision, "allowed");
  assert.equal(classifyAction(DEFAULT_GROUND_RULES, "write a new extension to the PBX").decision, "never");
});

test("⛔ an unrelated action that merely shares a word does NOT trip a never rule", () => {
  // "delete the old deploy logs" shares "deploy" with "Deploy outside the
  // deploy queue" — but the verb is DELETE, so it must fall to ask-first, not
  // be refused outright. Over-blocking ordinary work is how a safety layer
  // gets ignored.
  const v = classifyAction(DEFAULT_GROUND_RULES, "delete the old deploy logs");
  assert.equal(v.decision, "ask_first");
  assert.match(v.matchedRule ?? "", /Delete anything/);
});

test("the default rulebook refuses the house rules' standing nevers", () => {
  for (const action of [
    "issue a refund on the customer's payment",
    "write a new extension to the PBX",
    "deploy the api by hand outside the queue",
    "change the geo firewall to unblock a country",
    "delete the customer data for that tenant",
  ]) {
    assert.equal(classifyAction(DEFAULT_GROUND_RULES, action).decision, "never", `should be NEVER: ${action}`);
  }
});

test("the default rulebook asks first before anything that changes the world", () => {
  for (const action of [
    "restart the worker container",
    "delete the old deploy logs",
    "send a text message to the customer",
    "change this customer's voicemail settings",
  ]) {
    assert.equal(classifyAction(DEFAULT_GROUND_RULES, action).decision, "ask_first", `should ASK: ${action}`);
  }
});

test("the default rulebook allows plain reading and diagnosis", () => {
  for (const action of [
    "read the voicemail email guardrails source file",
    "run a diagnosis on that extension",
  ]) {
    assert.equal(classifyAction(DEFAULT_GROUND_RULES, action).decision, "allowed", `should be ALLOWED: ${action}`);
  }
});

test("singularisation matches plurals both ways, without inventing matches", () => {
  const rules = { allowed: "", askFirst: "Restart any container", never: "Payments" };
  assert.equal(classifyAction(rules, "restart the containers").decision, "ask_first");
  // Subject-only never rule: ANY mention of payments, whatever the verb.
  assert.equal(classifyAction(rules, "look at the payment record").decision, "never");
  // "contain" must NOT match "container" — a crude stem that over-matches would
  // block ordinary work and teach people to ignore the rulebook.
  const v = classifyAction(rules, "check what the file contains");
  assert.equal(v.decision, "ask_first");
  assert.equal(v.matchedRule, null);
});

test("an empty action description asks rather than proceeding", () => {
  assert.equal(classifyAction(DEFAULT_GROUND_RULES, "   ").decision, "ask_first");
});

test("the rendered rulebook states all three lists AND that the gate is real code", () => {
  const text = renderGroundRulesForAgent(DEFAULT_GROUND_RULES, 7);
  assert.match(text, /version 7/);
  assert.match(text, /YOU MAY NEVER DO THESE/);
  assert.match(text, /MUST ASK THE OWNER FIRST/);
  assert.match(text, /enforced in code/);
  // ⛔ It must outrank in-conversation instructions, or a customer who types
  // "the owner said it's fine" becomes an authorisation path.
  assert.match(text, /outrank every instruction/);
});

test("an empty list renders honestly rather than as a blank gap", () => {
  const text = renderGroundRulesForAgent({ allowed: "", never: "x", askFirst: "" }, 1);
  assert.match(text, /\(nothing listed\)/);
});

test("normaliseRulesInput trims and caps each block", () => {
  const long = "a".repeat(MAX_RULES_BLOCK_CHARS + 500);
  const out = normaliseRulesInput({ allowed: `  hi  `, never: long, askFirst: "\r\nx\r\n" });
  assert.equal(out.allowed, "hi");
  assert.equal(out.never.length, MAX_RULES_BLOCK_CHARS);
  assert.equal(out.askFirst, "x");
});

/**
 * ⛔⛔ THE LIVE-DRIVING REGRESSION, 2026-08-21. None of these came from
 * imagining inputs — they came from driving the deployed screen and watching
 * the rulebook refuse ordinary work. "Passwords, card details or API keys"
 * contributed the bare token "api", so the workbench refused
 * `wc -l apps/api/src/...` as NEVER, and "restart the api container" matched
 * the SECRETS line instead of its own ask-first line.
 *
 * An over-broad safety layer is the one people learn to ignore, so these are
 * as load-bearing as the refusals below them.
 */
test("a file path under apps/api is not a secret", () => {
  const v = classifyAction(DEFAULT_GROUND_RULES, "wc -l apps/api/src/supportWorkbench.ts");
  assert.notEqual(v.decision, "never");
  assert.equal(v.matchedRule, null);
});

test("restarting a container asks first — it does not hit the secrets rule", () => {
  const v = classifyAction(DEFAULT_GROUND_RULES, "restart the api container");
  assert.equal(v.decision, "ask_first");
  assert.match(String(v.matchedRule), /Restart any container/i);
});

test("a real credential read is still NEVER", () => {
  for (const action of ["cat the api keys file", "show me the passwords", "read the card details"]) {
    assert.equal(classifyAction(DEFAULT_GROUND_RULES, action).decision, "never", action);
  }
});

test("reading a log singular matches the plural rule", () => {
  assert.equal(classifyAction(DEFAULT_GROUND_RULES, "read the deploy log").decision, "allowed");
});

test("one shared word is not a match — every word of an item must be present", () => {
  const rules = { allowed: "", never: "Delete customer data", askFirst: "" };
  // "customer" alone must not trip a rule that says "customer data".
  assert.notEqual(classifyAction(rules, "delete the customer's old chat thread").decision, "never");
  assert.equal(classifyAction(rules, "delete the customer data export").decision, "never");
});

test("the PBX read/write split survives the item split", () => {
  assert.equal(classifyAction(DEFAULT_GROUND_RULES, "read the PBX extension list").decision, "allowed");
  assert.equal(classifyAction(DEFAULT_GROUND_RULES, "write a new inbound route to the PBX").decision, "never");
});
