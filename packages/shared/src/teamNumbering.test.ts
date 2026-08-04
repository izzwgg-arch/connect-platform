// Numbering for new ring groups (800s) and queues (900s). The fixture is A
// plus center's real dial plan, because that tenant is exactly the awkward
// case: 900 is a RING GROUP there, so the two series overlap.
import test from "node:test";
import assert from "node:assert/strict";
import { nextTeamNumber, explainChosenNumber, candidateNumbers, type UsedNumbers } from "./teamNumbering";

// Real rows from tenant 2 (read off the PBX 2026-08-03).
const APLUS: UsedNumbers = {
  extensions: ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "502", "503"],
  ringGroups: ["800", "810", "802", "900", "508", "1010"],
  queues: ["600"],
};

test("an empty tenant gets the first number in the series", () => {
  const empty: UsedNumbers = { extensions: [], ringGroups: [], queues: [] };
  assert.equal(nextTeamNumber("ring_group", empty), "800");
  assert.equal(nextTeamNumber("queue", empty), "900");
});

test("A plus center: 800 and 802 are taken, so a ring group gets 801", () => {
  assert.equal(nextTeamNumber("ring_group", APLUS), "801");
});

test("A plus center: 900 is taken BY A RING GROUP, so a queue gets 901", () => {
  // The whole reason this module exists. A queue allocator that only looked at
  // queues would hand out 900 and collide with the "Intercom" ring group.
  assert.equal(nextTeamNumber("queue", APLUS), "901");
});

test("a number used by an extension is never reused", () => {
  const used: UsedNumbers = { extensions: ["800", "801"], ringGroups: [], queues: [] };
  assert.equal(nextTeamNumber("ring_group", used), "802");
});

test("when 800-809 are all gone it adds a digit rather than leaving the series", () => {
  const used: UsedNumbers = {
    extensions: [],
    ringGroups: ["800", "801", "802", "803", "804", "805", "806", "807", "808", "809"],
    queues: [],
  };
  assert.equal(nextTeamNumber("ring_group", used), "8000");
});

test("and keeps going into the next band when that fills too", () => {
  const ring: string[] = [];
  for (let i = 0; i <= 9; i++) ring.push(`80${i}`);
  for (let i = 0; i <= 99; i++) ring.push(`80${String(i).padStart(2, "0")}`);
  assert.equal(nextTeamNumber("ring_group", { extensions: [], ringGroups: ring, queues: [] }), "80000");
});

test("queues follow the identical shape in the 900s", () => {
  const used: UsedNumbers = { extensions: [], ringGroups: [], queues: ["900", "901", "902", "903", "904", "905", "906", "907", "908", "909"] };
  assert.equal(nextTeamNumber("queue", used), "9000");
});

test("candidates come out shortest-first, never skipping a band", () => {
  const got: string[] = [];
  for (const n of candidateNumbers("ring_group", 4)) { got.push(n); if (got.length >= 12) break; }
  assert.deepEqual(got.slice(0, 11), ["800","801","802","803","804","805","806","807","808","809","8000"]);
});

test("blank and whitespace entries don't block a number", () => {
  const used: UsedNumbers = { extensions: ["", "  "], ringGroups: [], queues: [] };
  assert.equal(nextTeamNumber("ring_group", used), "800");
});

test("the explanation says why the number isn't the obvious one", () => {
  assert.match(explainChosenNumber("queue", "901", APLUS), /900 is already taken/);
  assert.match(explainChosenNumber("ring_group", "800", { extensions: [], ringGroups: [], queues: [] }), /start at 800/);
});
