import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QUEUE_STRATEGIES, QUEUE_STRATEGIES_PROVEN } from "./teamBuilder";

/**
 * The queue-save form has two field kinds that look identical in the captured
 * request and behave in opposite ways. Getting them the wrong way round stores
 * the OPPOSITE of what the customer chose, with a 200 and no error anywhere —
 * so each rule gets a test.
 */

const source = readFileSync(join(__dirname, "teamBuilder.ts"), "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⛔ autofill and autopause are CHECKBOXES — never sent as yes/no", () => {
  // Proven by a real create against the panel: sending `autofill=no` stored
  // **yes**, because the form reads "field present" as "box ticked" whatever
  // the value is. An unchecked box must be absent from the request entirely.
  assert.doesNotMatch(code, /\["autofill",/, "autofill must go through checkbox(), not a literal value");
  assert.doesNotMatch(code, /\["autopause",/, "autopause must go through checkbox(), not a literal value");
  assert.match(code, /checkbox\("autofill",/);
  assert.match(code, /checkbox\("autopause",/);
});

test("joinempty and leavewhenempty ARE selects and DO carry yes/no", () => {
  // The counterpart to the rule above: these two round-tripped correctly in
  // the same request that got autofill wrong, which is what proves the
  // difference is real and not a theory.
  assert.match(code, /\["joinempty",[^\]]*"no"[^\]]*"yes"\]|\["joinempty",[^\]]*\?[^\]]*\]/);
  assert.match(code, /\["leavewhenempty",/);
});

test("checkbox() emits nothing when off", () => {
  // The whole mechanism in one line — if this ever returns [name, "no"], every
  // "off" setting on the form silently turns itself on.
  const fn = source.match(/function checkbox\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /on \? \[\[name, "yes"\]\] : \[\]/);
});

test("a blank numeric field is \"\", never \"0\"", () => {
  // servicelevel=0 and servicelevel= mean different things to VitalPBX, and 0
  // is a legitimate value for several of these fields.
  const fn = source.match(/function numField\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /v == null \? "" : String\(v\)/);
});

test("the queue strategy list is offered in full, with the proven ones named", () => {
  assert.ok(QUEUE_STRATEGIES.includes("ringall"));
  assert.ok(QUEUE_STRATEGIES.includes("linear"));
  assert.ok(QUEUE_STRATEGIES.includes("rrmemory"));
  // ringall and linear are the two observed live in the generated queues.conf;
  // rrmemory was additionally proven by a real create during this work.
  assert.deepEqual([...QUEUE_STRATEGIES_PROVEN], ["ringall", "linear"]);
  for (const s of QUEUE_STRATEGIES_PROVEN) assert.ok(QUEUE_STRATEGIES.includes(s));
});

test("strategy is taken from the spec, not hardcoded to ringall", () => {
  assert.doesNotMatch(code, /\["strategy", "ringall"\]/);
  assert.match(code, /\["strategy", spec\.strategy \?\? "ringall"\]/);
});

test("⛔ Apply Changes is never fired from the team builder", () => {
  // The standing rule for every PBX write in this codebase.
  assert.doesNotMatch(code, /generateConfigurations|apply_changes/i);
});

test("queue_callback_id stays empty — its panel screen was never captured", () => {
  assert.match(code, /\["queue_callback_id", ""\]/);
});
