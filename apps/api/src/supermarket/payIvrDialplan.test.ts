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
