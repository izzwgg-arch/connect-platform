import test from "node:test";
import assert from "node:assert/strict";

import { formatDialDisplay } from "./dialDisplay";

// ── The reported bug (Izzy, 2026-08-23) ──────────────────────────────────────
// Every one of these rendered WRONG before the fix, because the old formatter
// built its output from `n.replace(/\D/g, '')`. A lone `*` or `#` produced an
// EMPTY field, which is why the key read as dead.

test("a lone * or # is visible on the keypad", () => {
  assert.equal(formatDialDisplay("*"), "*");
  assert.equal(formatDialDisplay("#"), "#");
});

test("feature codes render exactly as typed", () => {
  assert.equal(formatDialDisplay("*67"), "*67");
  assert.equal(formatDialDisplay("*97"), "*97");
  assert.equal(formatDialDisplay("*72"), "*72");
  assert.equal(formatDialDisplay("#123"), "#123");
});

test("post-dial digits after a full number survive", () => {
  // Old formatter showed "8005551212123" — the # silently gone.
  assert.equal(formatDialDisplay("8005551212#123"), "8005551212#123");
});

test("a long-pressed + is never swallowed", () => {
  // Same defect: the + vanished until the string passed 10 digits.
  assert.equal(formatDialDisplay("+"), "+");
  assert.equal(formatDialDisplay("+1"), "+1");
  assert.equal(formatDialDisplay("+1347978009"), "+1347978009");
  assert.equal(formatDialDisplay("+13479780090"), "+13479780090");
});

// ── Everything else must be byte-identical to the previous behaviour ─────────
// These are the cases the old formatter already got right. If any of them
// moves, the fix has changed how ordinary numbers look.

test("empty stays empty", () => {
  assert.equal(formatDialDisplay(""), "");
});

test("extensions are shown raw, never grouped", () => {
  assert.equal(formatDialDisplay("1"), "1");
  assert.equal(formatDialDisplay("101"), "101");
  assert.equal(formatDialDisplay("1002"), "1002");
  assert.equal(formatDialDisplay("10234"), "10234");
});

test("plain digit numbers keep their grouping", () => {
  assert.equal(formatDialDisplay("347978"), "347 978");
  assert.equal(formatDialDisplay("3479780"), "347 978 0");
  assert.equal(formatDialDisplay("3479780090"), "347 978 0090");
});

test("longer than a NANP number is shown raw rather than guessed at", () => {
  assert.equal(formatDialDisplay("13479780090"), "13479780090");
});

// ── The guard that keeps the defect from coming back ─────────────────────────

test("the formatter never strips non-digits on the way to the screen", () => {
  // The one line that caused the bug. A future 'tidy-up' that reintroduces a
  // digits-only projection would make * / # / + invisible again.
  const src = require("node:fs")
    .readFileSync(require("node:path").join(__dirname, "dialDisplay.ts"), "utf8")
    .replace(/\r\n/g, "\n")
    // Strip comments — the doc block deliberately QUOTES the bad pattern to
    // explain it, and a naive match would fire on correct code.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(
    !/replace\(\s*\/\D\/g/.test(src),
    "formatDialDisplay must not strip non-digits — that is the original bug",
  );
});

test("every dialable character the keypad can produce survives a round trip", () => {
  // Exhaustive over the sanitizer's own allowed set: digits, *, #, leading +.
  for (const ch of "0123456789*#") {
    assert.equal(formatDialDisplay(ch), ch, `single key '${ch}' must be visible`);
  }
});
