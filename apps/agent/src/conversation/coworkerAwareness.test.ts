/**
 * The assistant knows where it is when it is inside the Coworker bubble, and both
 * prompts know the Coworker exists and what it cannot do yet.
 *
 * 2026-09-02, the first live question through the bubble: "Can you organize files
 * on my computer?" — answered as if no such feature existed. The engine saw only
 * "the Desktop page" (the bubble's window loads /desktop/coworker), and neither
 * prompt mentioned the Coworker at all. These read the engine SOURCE because a
 * prompt sentence and a viewing-block branch are properties no unit test of a
 * helper can see.
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

test("the viewing block knows the bubble, for customers AND for staff", () => {
  const view = stripComments(code.slice(code.indexOf("const inCoworker ="), code.indexOf("const staffMode =")));
  assert.match(view, /ctx\.viewingPath\.startsWith\(COWORKER_CHAT_PATH\)/);
  assert.match(view, /talking to you through the Loopcom Coworker/);
  assert.match(view, /cannot yet do anything ON their computer/, "the customer branch must say what the bubble cannot do");
  assert.match(view, /desktop hands are not built yet/, "the staff branch must state the build fact");
  assert.match(view, /pass the exact request to the Connect team/, "a customer's computer task must be recorded");
  assert.ok(!/They have the "\$\{String\(ctx\.viewingPage\)[^`]*Loopcom Coworker/.test(view), "the page wording must not leak into the coworker branch");
});

test("the coworker branch is checked BEFORE the page branch, so the bubble is never described as 'the Desktop page'", () => {
  const view = code.slice(code.indexOf("const viewingBlock = inCoworker"), code.indexOf("const staffMode ="));
  assert.ok(view.indexOf("inCoworker") < view.indexOf("ctx.viewingPage\n") || view.indexOf("inCoworker") < view.indexOf(": ctx.viewingPage"), "page branch runs first");
});

test("the customer prompt says the Coworker exists and what it cannot do yet", () => {
  const p = promptBody("SYSTEM_PROMPT");
  assert.match(p, /THE LOOPCOM COWORKER/);
  assert.match(p, /Show Coworker Bubble/);
  assert.match(p, /CANNOT yet act on the person's\ncomputer/);
  assert.match(p, /Never claim a task on\ntheir computer was done, started, or scheduled/);
  assert.match(p, /pass the exact request to the Connect team/);
});

test("the staff prompt says the Coworker exists and states the build fact without the customer refusals", () => {
  const p = promptBody("STAFF_SYSTEM_PROMPT");
  assert.match(p, /THE LOOPCOM COWORKER/);
  assert.match(p, /desktop hands are NOT built/);
  assert.match(p, /approval screens .* still mockups/);
  assert.ok(!p.toLowerCase().includes("you cannot do it yet"), "the staff prompt must not regrow the customer refusal");
});

test("a request the prompt routes to the team is phrased so the escalation detector catches it", () => {
  // The prompt tells the model to "pass the exact request to the Connect team" —
  // the escalation regex accepts "pass … to the Connect team" (widened 2026-08-19).
  const esc = readFileSync(join(__dirname, "..", "escalation", "escalations.ts"), "utf8");
  assert.match(esc, /\(\?:\\w\+\[- \]\)\{0,2\}team/, "the detector no longer accepts a qualified team name like 'the Connect team'");
});
