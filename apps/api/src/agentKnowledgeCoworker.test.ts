/**
 * The assistant must KNOW what the Coworker is, and the document must say what is
 * TRUE TODAY — not what was true when it was written.
 *
 * 2026-09-02: the first question through the rebuilt bubble ("Can you organize files
 * on my computer?") was answered as if no such feature existed, so this document
 * gained a Coworker section. 2026-09-15: the opposite failure appeared the first time
 * the rebuilt workspace was used on a real screen — the assistant described the
 * CARD-era Coworker ("nothing runs until you press the button", "everything else is
 * not possible yet") months after the hands and the workspace shipped. A capability
 * the knowledge denies is a capability the customer never gets. The api publishes this
 * document at boot (agentKnowledgeSync.ts), which is also what gets it deployed.
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
  assert.match(customerHalf, /Workspace → Coworker/, "the full page exists for accounts that have it");
});

test("the customer half says what the Coworker really does on the computer today", () => {
  assert.match(customerHalf, /works ON that computer/);
  assert.match(customerHalf, /Find, read and organize their files/);
  assert.match(customerHalf, /Make and read spreadsheets/);
  assert.match(customerHalf, /Use its own browser window/);
  assert.match(customerHalf, /Work with code projects/);
  assert.match(customerHalf, /Read the files they attach/);
  assert.match(customerHalf, /watches every step happen in plain\n  English/);
});

test("⛔ the card-era wording can never come back: it is the capability the knowledge denies", () => {
  for (const gone of [
    /Nothing runs until the\n  person presses that button/,
    /press the button to run it/,
    /Everything else on the computer is not possible yet/,
    /cannot do it yet/,
    /short list of\n  things on the person's own computer/,
  ]) {
    assert.ok(!gone.test(customerHalf), `the customer half still carries the card-era wording ${gone}`);
  }
});

test("the customer half states the permission rules honestly: it asks first, some things always ask, and a refusal is final", () => {
  assert.match(customerHalf, /by default it ASKS before it changes\n  anything/);
  assert.match(customerHalf, /a small Loopcom box appears on their screen/);
  assert.match(customerHalf, /Full access/);
  assert.match(customerHalf, /always ask,\n  whatever they choose: deleting anything/);
  assert.match(customerHalf, /anything at all while they are on a phone call/);
  assert.match(customerHalf, /never switches off their\n  security, never opens remote access/);
  assert.match(customerHalf, /Never say a task on someone's computer was done unless the results show it/);
  assert.match(customerHalf, /refused, stopped, or they said no/);
});

test("the customer half says what to do when the app is NOT connected, and still records what it cannot do", () => {
  assert.match(customerHalf, /When the app is not connected/);
  assert.match(customerHalf, /needs to be open and signed in/);
  assert.match(customerHalf, /Do not hand them scripts or commands/);
  assert.match(customerHalf, /pass the exact request to the Connect team/, "the request must be recorded, not dropped");
});

test("the customer half names nothing it should not", () => {
  for (const bad of [/\bpassword\b(?!es and sign-ins)/i, /\bAMI\b/, /\bssh\b/i, /\/root\//, /policy core/, /mockup/i]) {
    assert.ok(!bad.test(customerHalf), `customer-facing knowledge mentions ${bad}`);
  }
});

test("the staff half records the true build state so the escalation report does not investigate a non-fault", () => {
  assert.match(staffHalf, /the desktop HANDS/);
  assert.match(staffHalf, /the WORKSPACE/);
  assert.match(staffHalf, /can_view_workspace_coworker/);
  assert.match(staffHalf, /Approvals are answered in the\n  desktop's own window, never in the chat page/);
  assert.match(staffHalf, /feature request to record, not a fault to investigate/);
  assert.ok(!/the FIRST hands exist/.test(staffHalf), "the 2026-09-02 build state is stale");
});
