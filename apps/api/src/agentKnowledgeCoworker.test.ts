/**
 * The assistant must KNOW the Coworker bubble exists, and must know it cannot yet
 * act on the person's computer.
 *
 * 2026-09-02: the first question asked through the rebuilt bubble was "Can you
 * organize files on my computer?" and the assistant answered as if no such feature
 * existed. The desktop hands are genuinely not built, so the honest answer is "not
 * yet" — but the assistant has to know WHERE it is and WHAT the bubble is to say
 * that. The knowledge document is what the api publishes to it at boot
 * (agentKnowledgeSync.ts), so this test lives in apps/api: it also makes a
 * knowledge-doc edit an api-relevant change, which is what gets it deployed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const doc = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "docs", "agent-knowledge", "system.md"), "utf8").replace(/\r\n/g, "\n");
const internalAt = doc.indexOf("<!-- internal -->");
assert.ok(internalAt > 0, "the internal marker is gone");
const customerHalf = doc.slice(0, internalAt);
const staffHalf = doc.slice(internalAt);

test("the customer half tells the assistant the Coworker bubble exists and how it is switched on", () => {
  assert.match(customerHalf, /## The Loopcom Coworker/);
  assert.match(customerHalf, /Show Coworker Bubble/);
  assert.match(customerHalf, /one click opens this chat/);
});

test("the customer half says exactly what the Coworker can do on the computer, that nothing runs without the press, and that it never deletes", () => {
  assert.match(customerHalf, /short list of\n  things on the person's own computer/);
  assert.match(customerHalf, /Nothing runs until the\n  person presses that button/);
  assert.match(customerHalf, /It moves; it never deletes/);
  assert.match(customerHalf, /Everything else on the computer is not possible yet/);
  assert.match(customerHalf, /Never say a task on someone's computer was done unless the task record says\n  so/);
  assert.match(customerHalf, /pass the exact request to\s+the\s+Connect team/, "the request must be recorded, not dropped");
});

test("the customer half names nothing it should not", () => {
  for (const bad of [/\bpassword\b/i, /\bAMI\b/, /\bssh\b/i, /\/root\//, /policy core/, /mockup/i]) {
    assert.ok(!bad.test(customerHalf), `customer-facing knowledge mentions ${bad}`);
  }
});

test("the staff half records the true build state so the escalation report does not investigate a non-fault", () => {
  assert.match(staffHalf, /the FIRST hands exist/);
  assert.match(staffHalf, /coworker\.task\.v1/);
  assert.match(staffHalf, /feature request to record, not a fault to investigate/);
});
