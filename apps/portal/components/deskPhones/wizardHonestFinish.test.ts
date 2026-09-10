/**
 * The finish screen must not claim success it did not have.
 *
 * ⛔⛔ WHY THIS EXISTS. On 2026-09-10 Izzy's own screen showed a GREEN TICK above
 * "0 of your 1 phones are ready", with the words "Your office is working." beneath
 * it — while the only phone in the run had halted to Support without ever being
 * reset. The headline from `summarizeRun` was honest the whole time; the screen
 * drew the tick unconditionally and picked its sentence on `needsAttention` alone,
 * so "ready === 0" and "one of six still to do" rendered identically.
 *
 * ⛔ These read SOURCE. The defect was in JSX — a conditional that was missing, not
 * a function that was wrong — so nothing that exercises `summarizeRun` can see it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { summarizeRun, type PhoneState } from "@connect/shared";

function readSource(relative: string): string {
  // PORTAL_GUARD_ROOT replays this against an export of HEAD, so the guards can be
  // PROVEN to fail on the pre-change code rather than assumed to.
  const root = process.env.PORTAL_GUARD_ROOT || join(__dirname);
  return readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

/** Comment-stripped: this file documents the shape it forbids. */
function executableLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** The `done` step's body, which is the only part of the file under test. */
function doneStep(): string {
  const src = executableLines(readSource("DeskPhoneWizard.tsx"));
  const start = src.indexOf('step === "done"');
  assert.ok(start > 0, "the wizard must still have a done step");
  return src.slice(start, start + 3000);
}

test("the tick is conditional on something actually being ready", () => {
  const done = doneStep();
  // The mark's colour and its path both have to consult the count. A tick drawn
  // unconditionally is the exact bug.
  assert.match(
    done,
    /summary\.ready === 0[\s\S]*?var\(--warning/,
    "with nothing ready the mark must not be the success colour",
  );
  assert.match(
    done,
    /summary\.ready === 0[\s\S]*?var\(--dps-warn\)/,
    "the glyph itself takes the warning ink when nothing is ready",
  );
});

test('"working" is never said when nothing is connected', () => {
  const done = doneStep();
  // The old sentence. It reached a customer whose phones were all dead.
  assert.doesNotMatch(
    done,
    /Your office is working\. The rest can wait/,
    "this sentence was shown above a zero — it must not come back",
  );
  assert.match(done, /None of them are connected yet/, "say what actually happened");
});

test("the three outcomes are all distinguished", () => {
  const done = doneStep();
  // all ready / some ready / none ready — three branches, not two.
  assert.match(done, /summary\.needsAttention === 0/, "the all-ready case");
  assert.match(done, /summary\.ready === 0/, "the nothing-ready case");
  assert.match(done, /dial tone/, "the all-ready wording survives");
});

// ── the counts the screen renders are the ones the shared summary produces ──

test("Izzy's actual run summarises as nothing ready", () => {
  // One phone, halted to Support. This is run cmtvj71qu0ap9o213v8y8t1dj as it
  // stood when he opened the wizard.
  const s = summarizeRun(["NEEDS_ATTENTION"] as PhoneState[]);
  assert.equal(s.ready, 0);
  assert.equal(s.needsAttention, 1);
  assert.equal(s.finished, true);
  assert.equal(s.headline, "0 of your 1 phones are ready");
});

test("a partly-good run still counts the wins first", () => {
  const s = summarizeRun(["REGISTERED", "REGISTERED", "NEEDS_ATTENTION"] as PhoneState[]);
  assert.equal(s.ready, 2);
  assert.equal(s.headline, "2 of your 3 phones are ready");
});

test("an all-good run reads as done, not as a count", () => {
  const s = summarizeRun(["REGISTERED", "REGISTERED"] as PhoneState[]);
  assert.equal(s.needsAttention, 0);
  assert.equal(s.headline, "Your phones are ready");
});
