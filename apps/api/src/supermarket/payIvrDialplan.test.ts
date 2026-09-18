/**
 * The dialplan view: what the PBX is handed, and what it must never be handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { payIvrDialplanView, safePromptRef } from "./payIvrDialplan";

const DIR = "/sounds/pay";

test("prompts become one &-joined absolute playback string", () => {
  const v = payIvrDialplanView(
    { prompts: ["04_balance_intro", "num_20", "num_5", "16_dollars"], gather: null, transfer: false, done: false },
    DIR,
  );
  assert.equal(v.playback, "/sounds/pay/04_balance_intro&/sounds/pay/num_20&/sounds/pay/num_5&/sounds/pay/16_dollars");
  assert.equal(v.action, "continue");
  assert.equal(v.maxDigits, 0);
});

test("⛔ a prompt ref can never escape the prompt directory", () => {
  const v = payIvrDialplanView(
    { prompts: ["../../../etc/passwd", "/etc/shadow", "ok_one", "..", "a/b", ""], gather: null, transfer: false, done: false },
    DIR,
  );
  assert.ok(!v.playback.includes(".."), "path traversal reached a live Playback()");
  for (const part of v.playback.split("&")) {
    assert.match(part, /^\/sounds\/pay\/[A-Za-z0-9_]+$/, `unsafe playback element: ${part}`);
  }
  assert.equal(safePromptRef("../x"), "x");
  assert.equal(safePromptRef("!!"), null);
  assert.equal(safePromptRef("a".repeat(80)), null);
});

test("⛔ transfer beats done beats gather — a finished call never collects digits", () => {
  const both = payIvrDialplanView(
    { prompts: [], gather: { maxDigits: 8 }, transfer: true, done: true },
    DIR,
  );
  assert.equal(both.action, "transfer");
  assert.equal(both.maxDigits, 0);
  const finished = payIvrDialplanView({ prompts: [], gather: { maxDigits: 8 }, transfer: false, done: true }, DIR);
  assert.equal(finished.action, "hangup");
  assert.equal(finished.maxDigits, 0);
});

// ── Keyed card hand-off (2026-09-17 night) ────────────────────────────────
test("a \"card\" gather becomes action \"card\" with maxDigits 0 — the dialplan hands off to the AGI, it never Read()s digits itself", () => {
  const v = payIvrDialplanView(
    { prompts: [], gather: { maxDigits: 0, what: "card" }, transfer: false, done: false },
    DIR,
  );
  assert.equal(v.action, "card");
  assert.equal(v.maxDigits, 0);
  // a normal digit gather stays "gather", never "card"
  const menu = payIvrDialplanView({ prompts: [], gather: { maxDigits: 1, what: "menu" }, transfer: false, done: false }, DIR);
  assert.equal(menu.action, "gather");
});

test("gather reports a bounded digit count", () => {
  assert.equal(payIvrDialplanView({ prompts: [], gather: { maxDigits: 8 }, transfer: false, done: false }, DIR).maxDigits, 8);
  assert.equal(payIvrDialplanView({ prompts: [], gather: { maxDigits: 0 }, transfer: false, done: false }, DIR).maxDigits, 1);
  assert.equal(payIvrDialplanView({ prompts: [], gather: { maxDigits: 9999 }, transfer: false, done: false }, DIR).maxDigits, 32);
});

test("silence is expressible — an empty prompt list is an empty string, not a stray separator", () => {
  const v = payIvrDialplanView({ prompts: [], gather: null, transfer: false, done: true }, DIR);
  assert.equal(v.playback, "");
});

test("a trailing slash on the directory never doubles up", () => {
  const v = payIvrDialplanView({ prompts: ["x"], gather: null, transfer: false, done: false }, "/sounds/pay///");
  assert.equal(v.playback, "/sounds/pay/x");
});

// ── The pay dialplan never dials OUT (2026-09-17 evening, final) ──────────────
// The one-time code by phone call was built and removed the same day (Izzy:
// every caller keys the PIN instead). The PBX side of this feature is an
// inbound conversation only: nothing in the conf may Originate() or Dial().
test("⛔ the pay dialplan never Originate()s or Dial()s — it is an inbound conversation only", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const conf = fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "supermarket", "connect-supermarket-pay.conf"), "utf8")
    .replace(/\r\n/g, "\n");
  const lines = conf.split("\n").filter((l) => !l.trim().startsWith(";"));
  assert.equal(lines.filter((l) => /\bOriginate\(/.test(l)).length, 0, "an Originate() crept back into the pay dialplan");
  assert.equal(lines.filter((l) => /\bDial\(/.test(l)).length, 0, "a Dial() crept back into the pay dialplan");
  assert.ok(!lines.some((l) => l.startsWith("[connect-pay-code-")), "the code-call contexts were removed");
});

// ── The dialplan file itself: the header trap (2026-09-08) ────────────────
// Asterisk's CURLOPT(httpheader) ADDS a header on the channel every time it is
// set ("Multiple calls add multiple headers"). With the two Set()s inside the
// step loop, the second request of every call carried the secret twice, the
// api read "S, S", answered 403, and the caller was handed to a person the
// moment their first Read() timed out. A unit test of the api cannot see this
// — the defect is in the PBX file — so this reads the shipped dialplan.
test("⛔ the pay dialplan sets its HTTP headers exactly once per channel, before the step loop, never in h", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const conf = fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "supermarket", "connect-supermarket-pay.conf"), "utf8")
    .replace(/\r\n/g, "\n");
  const lines = conf.split("\n").filter((l) => !l.trim().startsWith(";"));
  const headerLines = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes("Set(CURLOPT(httpheader)"));
  assert.equal(headerLines.length, 2, `expected exactly two header Set() lines, found ${headerLines.length}`);
  const stepIdx = lines.findIndex((l) => l.includes("n(step)"));
  const hIdx = lines.findIndex((l) => l.startsWith("exten => h,"));
  assert.ok(stepIdx > 0 && hIdx > stepIdx, "dialplan shape changed — re-check this guard");
  for (const [, i] of headerLines) {
    assert.ok(i < stepIdx, "a header Set() sits inside the step loop — it will stack on the channel and 403 the second step");
    assert.ok(i < hIdx, "a header Set() sits in the h extension — it stacks on the channel");
  }
  const secretLine = headerLines.find(([l]) => l.includes("x-cdr-secret"));
  assert.ok(secretLine, "the shared-secret header is not set at all");
});

// ── The card block hands off to the AGI, never Read()s a card (2026-09-17) ──
// The card digits must never pass through a dialplan Read() or channel
// variable (the full-log-of-every-step trap this file already guards for the
// PIN/amount/lookup steps applies just as much to a card number). The AGI is
// the only thing that ever touches the digits, over its own pipe.
test("⛔ the pay dialplan's card block hands off to the AGI card collector and never Read()s a card itself", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const conf = fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "supermarket", "connect-supermarket-pay.conf"), "utf8")
    .replace(/\r\n/g, "\n");
  const lines = conf.split("\n").filter((l) => !l.trim().startsWith(";"));
  const cardIdx = lines.findIndex((l) => l.includes("n(card)"));
  const humanIdx = lines.findIndex((l) => l.startsWith("exten => h,") || l.includes("n(human)"));
  assert.ok(cardIdx >= 0, "the card extension/label is missing from the dialplan");
  const cardBlock = lines.slice(cardIdx, humanIdx > cardIdx ? humanIdx : lines.length);
  assert.ok(
    cardBlock.some((l) => /\bAGI\(connect-pay-card\.py,/.test(l)),
    "the card block never hands off to the AGI collector (connect-pay-card.py)",
  );
  assert.equal(
    cardBlock.filter((l) => /\bRead\(/.test(l)).length,
    0,
    "the card block Read()s a channel variable — card digits must never travel through one",
  );
  // the whole file, not just the card block: no Originate()/Dial() (the
  // existing guard, restated here so this test alone still catches it).
  assert.equal(lines.filter((l) => /\bOriginate\(/.test(l)).length, 0);
  assert.equal(lines.filter((l) => /\bDial\(/.test(l)).length, 0);
});

// ── The stray pound (2026-09-18) ──────────────────────────────────────────────
// Every prompt says "followed by the pound key", but a fixed-length gather
// (10-digit phone, 1-digit menu) closes Read() on its last digit; the pound
// the caller then keys lands on the NEXT Read() as its terminator and returns
// it empty at once — the api heard "invalid PIN" before anything was keyed
// (3 of the last 4 real calls). The dialplan re-asks an EARLY empty answer
// locally, once, before it ever becomes a step. A real timeout is the prompt
// plus 10 s, so the 6-second window cannot swallow one.
function readPayConf(): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  return fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "supermarket", "connect-supermarket-pay.conf"), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !l.trim().startsWith(";"));
}

test("⛔ the gather block re-asks an EARLY empty Read() once, locally — a stray pound never becomes a step, and a real timeout still does", () => {
  const lines = readPayConf();
  const gatherIdx = lines.findIndex((l) => l.includes("n(gather)"));
  const cardIdx = lines.findIndex((l) => l.includes("n(card)"));
  assert.ok(gatherIdx >= 0 && cardIdx > gatherIdx, "dialplan shape changed — re-check this guard");
  const block = lines.slice(gatherIdx, cardIdx);
  // exactly one Read(), under a re-entrant label, timed from a stamp taken right before it
  const readLines = block.filter((l) => /\bRead\(/.test(l));
  assert.equal(readLines.length, 1, "the gather block must hold exactly one Read()");
  assert.ok(block.some((l) => l.includes("n(read)")), "the Read() needs its own label to be re-entered");
  assert.ok(block.some((l) => /Set\(PAY_T0=\$\{EPOCH\}\)/.test(l)), "the Read() is not timed — an early empty cannot be told from a timeout");
  // the decision: empty AND not yet re-asked AND inside the window → stray
  const decision = block.find((l) => l.includes("?stray"));
  assert.ok(decision, "no stray-terminator branch");
  assert.ok(decision!.includes('"${PAY_DIGITS}" = ""'), "the stray branch must key on an EMPTY answer only");
  assert.ok(decision!.includes("${PAY_REREAD} = 0"), "the stray branch must be bounded to one re-ask");
  const window = decision!.match(/\$\[\$\{EPOCH\} - \$\{PAY_T0\}\] < (\d+)/);
  assert.ok(window, "the stray branch must be bounded by elapsed time");
  const seconds = Number(window![1]);
  // shortest prompt (01_welcome 2.3 s) + Read()'s 10 s first-digit wait ≈ 12 s: the window must sit well under it
  assert.ok(seconds >= 3 && seconds <= 8, `stray window ${seconds}s is outside [3, 8] — a real timeout could be mistaken for a stray pound`);
  const readTimeout = readLines[0].match(/Read\(PAY_DIGITS,\$\{PAY_PLAY\},\$\{PAY_MAX\},,1,(\d+)\)/);
  assert.ok(readTimeout && Number(readTimeout[1]) > seconds, "Read()'s timeout must exceed the stray window");
  // the stray label flips the flag and goes back to the Read(), never to the api
  const strayIdx = block.findIndex((l) => l.includes("n(stray)"));
  assert.ok(strayIdx >= 0);
  const strayTail = block.slice(strayIdx);
  assert.ok(strayTail.some((l) => /Set\(PAY_REREAD=1\)/.test(l)), "the re-ask must mark itself so a second empty goes to the api");
  assert.ok(strayTail.some((l) => /Goto\(read\)/.test(l)), "the re-ask must return to the Read(), not to step");
  assert.ok(!strayTail.some((l) => /\bCURL\(/.test(l)), "the re-ask must not call the api");
  // the flag is reset on every fresh gather, so each prompt gets its own one re-ask
  assert.ok(block.slice(0, block.findIndex((l) => l.includes("n(read)"))).some((l) => /Set\(PAY_REREAD=0\)/.test(l)));
});

test("the card block posts the collector's outcome word as the next step's digits — the post-AGI step never looks like an empty answer", () => {
  const lines = readPayConf();
  const cardIdx = lines.findIndex((l) => l.includes("n(card)"));
  const humanIdx = lines.findIndex((l) => l.includes("n(human)"));
  const block = lines.slice(cardIdx, humanIdx);
  const agiIdx = block.findIndex((l) => /\bAGI\(connect-pay-card\.py,/.test(l));
  assert.ok(agiIdx >= 0);
  const after = block.slice(agiIdx);
  assert.ok(after.some((l) => /Set\(PAY_DIGITS=\$\{PAY_CARD\}\)/.test(l)), "after the AGI the step must carry PAY_CARD, not an empty PAY_DIGITS");
  assert.ok(!after.some((l) => /Set\(PAY_DIGITS=\)/.test(l)), "an empty Set(PAY_DIGITS=) after the AGI would read as 'no input' to the api");
});

// ── The AGI collector carries the same two rules (2026-09-18) ────────────────
test("⛔ the AGI card collector re-asks an early empty GET DATA once, treats a silence as a replay (never 'that does not look right'), and waits 10 s not 15", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const src = fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "supermarket", "connect-pay-card.py"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(src, /^GET_TIMEOUT_MS = 10000$/m, "GET DATA's one timeout is first-digit AND inter-digit: 15 s made a 3-digit code with no pound a 15-second silence");
  assert.match(src, /^STRAY_WINDOW_S = 6\.0$/m);
  const collect = src.slice(src.indexOf("def collect("), src.indexOf("def main("));
  assert.ok(/if v == "":/.test(collect), "collect() must branch on an empty answer");
  assert.ok(/time\.monotonic\(\) - started < STRAY_WINDOW_S/.test(collect), "the early-empty re-ask is not time-bounded");
  assert.ok(/reasked = True/.test(collect), "the re-ask must be once per field");
  // an empty answer never plays 45_card_invalid: the only stream() sits under the wrong-answer branch
  const emptyBranch = collect.slice(collect.indexOf('if v == "":'), collect.indexOf("if check(v):"));
  assert.ok(!emptyBranch.includes("45_card_invalid"), "a silence must not be told it looks wrong");
  assert.ok(/empty \+= 1/.test(emptyBranch) && /wrong < TRIES and empty < TRIES/.test(collect), "silences need their own bounded count");
});
