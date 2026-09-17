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

// ── The one-time code call (2026-09-17) ───────────────────────────────────────
test("a code call is ten digits plus a sanitised say-list, and nothing else ever reaches Originate()", () => {
  const v = payIvrDialplanView(
    {
      prompts: ["31_code_call_sent"],
      gather: { maxDigits: 6 },
      transfer: false,
      done: false,
      dial: "(845) 782-3064",
      dialPrompts: ["28_code_call_intro", "num_4", "../etc/passwd", "num_0", "29_code_again", "10_thanks_bye"],
    },
    DIR,
  );
  assert.equal(v.dial, "8457823064");
  assert.equal(v.action, "gather");
  assert.equal(v.dialPlayback, "/sounds/pay/28_code_call_intro&/sounds/pay/num_4&/sounds/pay/etcpasswd&/sounds/pay/num_0&/sounds/pay/29_code_again&/sounds/pay/10_thanks_bye");
  assert.ok(!v.dialPlayback.includes(".."));
});

test("⛔ a dial that is not exactly ten digits, or has nothing to say, is dropped whole", () => {
  const short = payIvrDialplanView({ prompts: [], gather: { maxDigits: 6 }, transfer: false, done: false, dial: "12345", dialPrompts: ["num_1"] }, DIR);
  assert.equal(short.dial, "");
  assert.equal(short.dialPlayback, "");
  const mute = payIvrDialplanView({ prompts: [], gather: { maxDigits: 6 }, transfer: false, done: false, dial: "8457823064", dialPrompts: [] }, DIR);
  assert.equal(mute.dial, "");
  assert.equal(mute.dialPlayback, "");
  const none = payIvrDialplanView({ prompts: [], gather: null, transfer: false, done: false }, DIR);
  assert.equal(none.dial, "");
  assert.equal(none.dialPlayback, "");
});

test("⛔ the pay dialplan places the code call asynchronously, only from a tenant-set dial-out context, and never collects input on it", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const conf = fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "supermarket", "connect-supermarket-pay.conf"), "utf8")
    .replace(/\r\n/g, "\n");
  const lines = conf.split("\n").filter((l) => !l.trim().startsWith(";"));
  const originate = lines.filter((l) => l.includes("Originate("));
  assert.equal(originate.length, 1, "exactly one Originate() in the pay dialplan");
  const o = originate[0];
  assert.ok(o.includes("${PAY_DIAL}@${PAY_CODE_CTX}"), "the code call dials the api's number through the tenant's dial-out context");
  assert.ok(o.includes('"${PAY_CODE_CTX}" != ""'), "no dial-out context = no call");
  assert.ok(/,45,a/.test(o), "the code call is asynchronous (option a) with a bounded ring time");
  assert.ok(o.includes("connect-pay-code-say"), "the answered leg runs the say context");
  // The say context plays and hangs up — it never Read()s.
  const sayStart = lines.findIndex((l) => l.startsWith("[connect-pay-code-say]"));
  const sayEnd = lines.findIndex((l, i) => i > sayStart && l.startsWith("["));
  assert.ok(sayStart > 0 && sayEnd > sayStart, "say context present");
  const say = lines.slice(sayStart, sayEnd);
  assert.ok(say.some((l) => l.includes("Playback(${PAY_DIALPLAY})")));
  assert.ok(!say.some((l) => l.includes("Read(")), "the code call must never collect digits");
  assert.ok(say.some((l) => l.includes("Hangup()")));
  // The Gesheft dial-out leg dials the store's own trunk with the store's caller ID.
  const dialStart = lines.findIndex((l) => l.startsWith("[connect-pay-code-dial-gesheft]"));
  assert.ok(dialStart > 0, "Gesheft dial-out context present");
  const dialCtx = lines.slice(dialStart, dialStart + 8);
  assert.ok(dialCtx.some((l) => l.includes("Dial(PJSIP/${EXTEN}@344022_gesheft")));
  assert.ok(dialCtx.some((l) => l.includes("CALLERID(num)=")));
  assert.ok(lines.some((l) => l.includes("PAY_CODE_CTX=connect-pay-code-dial-gesheft")));
  assert.ok(lines.some((l) => l.includes("PAY_CODE_CID=8452449666")), "the code call shows the store's number");
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
