/**
 * The assistant knows where it is when it is inside the Coworker bubble, and both
 * prompts know the Coworker exists and — since 2026-09-09 — that it has HANDS when
 * the person's Loopcom Windows app is linked (apps/agent/src/coworker).
 *
 * 2026-09-02, the first live question through the bubble: "Can you organize files
 * on my computer?" — answered as if no such feature existed. The engine saw only
 * "the Desktop page" (the bubble's window loads /desktop/coworker), and neither
 * prompt mentioned the Coworker at all. 2026-09-09: the prompts still said the
 * Coworker "cannot do it yet" while the computer_* tools were on the table — a
 * capability the prompt denies is not a capability. These read the engine SOURCE
 * because a prompt sentence and a viewing-block branch are properties no unit test
 * of a helper can see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COWORKER_CHAT_PATH } from "./engine";

const code = readFileSync(join(__dirname, "engine.ts"), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function promptBody(name: string): string {
  const i = code.indexOf(`const ${name} = \``);
  assert.ok(i >= 0, `${name} not found`);
  return code.slice(i, code.indexOf("`;", i));
}

test("the coworker chat path matches what the desktop app loads", () => {
  assert.equal(COWORKER_CHAT_PATH, "/desktop/coworker");
  const desktop = readFileSync(join(__dirname, "..", "..", "..", "desktop", "src", "coworkerWidget", "widgetWindow.ts"), "utf8");
  assert.match(desktop, /export const CHAT_ROUTE = "\/desktop\/coworker"/);
});

test("the viewing block knows the bubble, and tells the truth for BOTH link states", () => {
  const view = stripComments(code.slice(code.indexOf("const inCoworker ="), code.indexOf("const staffMode =")));
  assert.match(view, /ctx\.viewingPath\.startsWith\(COWORKER_CHAT_PATH\)/);
  assert.match(view, /talking to you through the Loopcom Coworker/);
  assert.match(view, /\? handsOn\s*\?/, "the bubble branch forks on whether the desktop is linked");
  assert.match(view, /Their Loopcom app is CONNECTED and the computer_\* tools below run on that computer/, "linked: act");
  assert.match(view, /Their Loopcom app is NOT connected to this chat right now/, "not linked: say so");
  assert.match(view, /Do not offer scripts or manual steps unless they ask/);
  assert.doesNotMatch(view, /coworker_task/, "the card-era tool is no longer what the bubble offers");
  assert.doesNotMatch(view, /not built yet|cannot do yet/, "no branch may deny a capability the tools provide");
  assert.ok(!/They have the "\$\{String\(ctx\.viewingPage\)[^`]*Loopcom Coworker/.test(view), "the page wording must not leak into the coworker branch");
});

test("the coworker branch is checked BEFORE the page branch, so the bubble is never described as 'the Desktop page'", () => {
  const view = code.slice(code.indexOf("const viewingBlock = inCoworker"), code.indexOf("const staffMode ="));
  assert.ok(view.indexOf("inCoworker") < view.indexOf("ctx.viewingPage\n") || view.indexOf("inCoworker") < view.indexOf(": ctx.viewingPage"), "page branch runs first");
});

test("the customer prompt says the Coworker exists, has hands when linked, and acts instead of instructing", () => {
  const p = promptBody("SYSTEM_PROMPT");
  assert.match(p, /THE LOOPCOM COWORKER/);
  assert.match(p, /Show Coworker Bubble/);
  assert.match(p, /you have HANDS on their\ncomputer: tools named computer_\*/);
  assert.match(p, /never answered with instructions for the person to do it\nthemselves/);
  assert.match(p, /the app is not connected: say the Coworker's hands are\nnot connected right now/);
  assert.match(p, /Never claim a task on their computer was done\nunless a tool result shows it/);
  assert.doesNotMatch(p, /coworker_task|my_computer_tasks/, "the card-era tools are not what the prompt teaches any more");
  assert.doesNotMatch(p, /cannot do\s+yet/);
});

test("the staff prompt says the Coworker has hands and that the server-side 'cannot write files' rule is about the SERVER", () => {
  const p = promptBody("STAFF_SYSTEM_PROMPT");
  assert.match(p, /THE LOOPCOM COWORKER/);
  assert.match(p, /you have HANDS on that computer: computer_\* tools/);
  assert.match(p, /is about the SERVER and the codebase; on the owner's own computer/);
  assert.match(p, /do the work and report the results/);
  assert.ok(!p.toLowerCase().includes("you cannot do it yet"), "the staff prompt must not regrow the customer refusal");
  assert.doesNotMatch(p, /Nothing else on the computer is possible yet/);
});

test("a request the prompt routes to the team is phrased so the escalation detector catches it", () => {
  // The prompt tells the model to "pass the exact request to the Connect team" —
  // the escalation regex accepts "pass … to the Connect team" (widened 2026-08-19).
  const esc = readFileSync(join(__dirname, "..", "escalation", "escalations.ts"), "utf8");
  assert.match(esc, /\(\?:\\w\+\[- \]\)\{0,2\}team/, "the detector no longer accepts a qualified team name like 'the Connect team'");
});
