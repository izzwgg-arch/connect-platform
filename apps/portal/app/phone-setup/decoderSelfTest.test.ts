/**
 * The decoder self-test canary — round 21 follow-up (2026-09-17).
 *
 * ⛔ Lives OUTSIDE the `[token]/` route folder on purpose: a `.test.ts` file inside a
 * bracket-named Next.js route directory is invisible to both `node --test` and `tsx
 * --test`, which treat `[token]` as a glob character class and match zero files —
 * proven while writing this file (a copy placed inside `[token]/` silently ran 0
 * tests, no error, nothing in `test`'s output to say why). A plain relative import
 * across that boundary has no such problem; only the test RUNNER's own file-discovery
 * glob does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runDecoderSelfTest, SELF_TEST_EXPECTED_TEXT, SELF_TEST_PNG,
  type ZxingReaderLike,
} from "./[token]/decoderSelfTest";

function readSource(relative: string): string {
  // PORTAL_GUARD_ROOT replays these against an export of HEAD, so they are PROVEN to
  // fail on the pre-change code rather than assumed to.
  const root = process.env.PORTAL_GUARD_ROOT || join(__dirname, "[token]");
  return readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

const fakeZxing = (impl: ZxingReaderLike["readBarcodes"]): ZxingReaderLike => ({ readBarcodes: impl });

/* ── the outcome logic, with a fake reader (no wasm, no DOM) ─────────────────────── */

test("the expected canary text reads as ok", async () => {
  const zxing = fakeZxing(async () => [{ text: SELF_TEST_EXPECTED_TEXT }]);
  assert.deepEqual(await runDecoderSelfTest(zxing), { ok: true, reason: "ok" });
});

test("whitespace around the expected text is trimmed before comparing", async () => {
  const zxing = fakeZxing(async () => [{ text: `  ${SELF_TEST_EXPECTED_TEXT}\n` }]);
  assert.deepEqual(await runDecoderSelfTest(zxing), { ok: true, reason: "ok" });
});

test("a wrong decode is a mismatch, not a pass", async () => {
  const zxing = fakeZxing(async () => [{ text: "SOMETHING ELSE" }]);
  assert.deepEqual(await runDecoderSelfTest(zxing), { ok: false, reason: "decode_mismatch" });
});

test("no symbol at all is a mismatch, never a throw", async () => {
  const zxing = fakeZxing(async () => []);
  assert.deepEqual(await runDecoderSelfTest(zxing), { ok: false, reason: "decode_mismatch" });
});

test("a throw from readBarcodes IS the round-21 failure mode: wasm_failed, not an unhandled rejection", async () => {
  // This is exactly what WebAssembly.instantiate() does under a CSP missing
  // 'wasm-unsafe-eval' — reject, not hang and not return a garbled result.
  const zxing = fakeZxing(async () => { throw new Error("CSP violation: script-src"); });
  assert.deepEqual(await runDecoderSelfTest(zxing), { ok: false, reason: "wasm_failed" });
});

test("a decoder that never resolves is timed out, not left hanging forever", async () => {
  const zxing = fakeZxing(() => new Promise(() => {}));
  const res = await runDecoderSelfTest(zxing, { timeoutMs: 30 });
  assert.deepEqual(res, { ok: false, reason: "timeout" });
});

test("the reader is called with the embedded canary's own bytes, not something else", async () => {
  let seen: unknown = null;
  const zxing = fakeZxing(async (input) => { seen = input; return [{ text: SELF_TEST_EXPECTED_TEXT }]; });
  await runDecoderSelfTest(zxing);
  assert.ok(seen instanceof Uint8Array, "readBarcodes gets bytes, not a data URI string");
  assert.ok((seen as Uint8Array).length > 0);
});

/* ── the embedded canary is a real, decodable image ──────────────────────────────── */

test("the embedded PNG really is a PNG data URI, not a placeholder", () => {
  assert.match(SELF_TEST_PNG, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  // Small on purpose (Izzy's brief: "a tiny known-good PNG") — this is telemetry
  // shipped in every page load, not a real label photo.
  assert.ok(SELF_TEST_PNG.length < 20_000, `canary should stay tiny, was ${SELF_TEST_PNG.length} chars`);
});

/**
 * The REAL zxing-wasm engine, not a fake — the one place this suite proves the
 * canary is actually decodable, mirroring labelBarcodes.test.ts's own real-engine
 * round-trips. If this ever fails, the canary PNG itself is bad, not the CSP.
 */
test("the real zxing-wasm engine decodes the embedded canary end to end", async () => {
  const zxing = await import("zxing-wasm/reader");
  const res = await runDecoderSelfTest(zxing);
  assert.deepEqual(res, { ok: true, reason: "ok" });
});

/* ── the page never hides the camera, whichever mode it lands in ────────────────── */

test("the scan page renders a Scan button in EVERY decoder mode, never only when device mode wins", () => {
  const src = readSource("page.tsx");
  assert.match(
    src,
    /Scan a phone|Scan another phone/,
    "round 19's rule: the camera control must render unconditionally on the list view",
  );
  // The self-test result may only ever choose which POST path is used, never whether
  // the button exists at all.
  const buttonBlock = src.slice(src.lastIndexOf("{view === \"list\""));
  assert.match(buttonBlock, /onClick=\{\(\) => \{ void startCamera\(\); \}\}/);
});

test("the honest mode chip uses plain customer words, never the jargon behind it", () => {
  const src = readSource("page.tsx");
  // Extract ONLY the two chip label strings themselves — not the whole file — so this
  // never false-positives on the surrounding code/comments (which freely say "wasm",
  // "CSP" and "zxing", as they must, to explain WHY the chip exists).
  const ternary = src.match(/decoderMode === "device"\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/);
  assert.ok(ternary, "the chip's device/photo labels must exist as a plain ternary");
  const [, deviceLabel, photoLabel] = ternary as RegExpMatchArray;
  assert.equal(deviceLabel, "Fast scanner ready");
  assert.match(photoLabel, /Slow mode/);
  for (const label of [deviceLabel, photoLabel]) {
    for (const jargon of ["CSP", "wasm", "WebAssembly", "zxing", "decoder"]) {
      assert.doesNotMatch(label, new RegExp(jargon, "i"), `"${jargon}" leaked into "${label}"`);
    }
  }
});
