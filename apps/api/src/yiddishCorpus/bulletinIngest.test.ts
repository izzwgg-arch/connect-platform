/**
 * Ingest shaping. The property these tests exist to hold: raw publisher text
 * can never reach the trainer, and aligned text can never carry the article's
 * timing instead of the audio's.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PUBLISHER_ENGINE } from "./bulletinText";
import {
  MIN_ITEM_AGREEMENT,
  PUBLISHER_ALIGNED_ENGINE,
  alignItem,
  alignedOriginRef,
  timedWordsFrom,
  transcriptRowsFor,
} from "./bulletinIngest";

const A = "\u05d3\u05d9";
const B = "\u05e4\u05d0\u05dc\u05d9\u05e6\u05d9\u05d9";
const C = "\u05d4\u05d0\u05d8";
const D = "\u05d2\u05e2\u05d6\u05d0\u05d2\u05d8";
const E = "\u05d0\u05d6";
const F = "\u05d3\u05e2\u05e8";
const G = "\u05de\u05d0\u05df";
const H = "\u05d5\u05d5\u05e2\u05d8";
const WRONG = "\u05d3\u05d0\u05e1";
const RIGHT = "\u05d0\u05e4\u05d8\u05e8\u05e2\u05d8\u05df";
const WORDS = [A, B, C, D, E, F, G, H, WRONG, "\u05de\u05d0\u05e8\u05d2\u05df", "\u05d0\u05e8\u05d5\u05d9\u05e1", "\u05d0\u05d9\u05e6\u05d8"];

test("timedWordsFrom turns whisper seconds + the chunk offset into absolute ms", () => {
  // ⛔ Whisper word times are SECONDS inside the chunk; the row carries the
  // chunk's offset. Forgetting either produces timing that looks plausible and
  // points at the wrong audio.
  const words = timedWordsFrom([
    { startMs: 0, words: [{ word: A, start: 0.5, end: 0.9 }] },
    { startMs: 600_000, words: [{ word: B, start: 1.25, end: 1.75 }] },
  ]);
  assert.deepEqual(words, [
    { word: A, startMs: 500, endMs: 900 },
    { word: B, startMs: 601_250, endMs: 601_750 },
  ]);
});

test("timedWordsFrom skips rows with no usable word timing instead of inventing it", () => {
  assert.deepEqual(timedWordsFrom([{ startMs: 0, words: null }]), []);
  assert.deepEqual(timedWordsFrom([{ startMs: 0, words: [{ word: A }] }]), []);
  assert.deepEqual(timedWordsFrom([{ startMs: 0, words: [{ word: "  ", start: 1, end: 2 }] }]), []);
});

function asrRows(words: string[]) {
  return [{ startMs: 0, words: words.map((w, i) => ({ word: w, start: i * 0.4, end: (i + 1) * 0.4 })) }];
}

test("an article that matches its recording yields aligned spans with the site's wording", () => {
  const typed = WORDS.map((w) => (w === WRONG ? RIGHT : w)).join(" ");
  const got = alignItem({ externalId: "1", fullText: typed }, timedWordsFrom(asrRows(WORDS)));
  assert.ok(got.agreement > 0.9);
  assert.equal(got.rejected, null);
  assert.ok(got.spans.length >= 1);
  assert.match(got.spans[0].text, new RegExp(RIGHT));
});

test("an article that is NOT this recording is rejected before any span is built", () => {
  const other = Array(14).fill("\u05d0\u05d9\u05e0\u05d3\u05e2\u05e8\u05e4\u05e8\u05d9").join(" ");
  const got = alignItem({ externalId: "2", fullText: other }, timedWordsFrom(asrRows(WORDS)));
  assert.ok(got.agreement < MIN_ITEM_AGREEMENT);
  assert.deepEqual(got.spans, []);
  assert.match(got.rejected || "", /not the same speech/);
});

test("an item with no word timing says so rather than aligning against nothing", () => {
  const got = alignItem({ externalId: "3", fullText: WORDS.join(" ") }, []);
  assert.deepEqual(got.spans, []);
  assert.match(got.rejected || "", /no word-level ASR timing/);
});

test("the raw article is stored UNUSABLE and only aligned spans carry timing", () => {
  const typed = WORDS.map((w) => (w === WRONG ? RIGHT : w)).join(" ");
  const alignment = alignItem({ externalId: "167484", fullText: typed }, timedWordsFrom(asrRows(WORDS)));
  const rows = transcriptRowsFor("item-1", { externalId: "167484", fullText: typed }, alignment);

  const raw = rows.filter((r) => r.engine === PUBLISHER_ENGINE);
  assert.equal(raw.length, 1, "exactly one row records what the site published");
  assert.equal(raw[0].startMs, null, "the raw article has no timing, so nothing can clip audio with it");
  assert.equal(raw[0].endMs, null);
  assert.equal(raw[0].originRef, "bulletin:167484");

  const aligned = rows.filter((r) => r.engine === PUBLISHER_ALIGNED_ENGINE);
  assert.ok(aligned.length >= 1);
  for (const r of aligned) {
    assert.equal(typeof r.startMs, "number");
    assert.equal(typeof r.endMs, "number");
    assert.ok((r.endMs as number) > (r.startMs as number));
  }
  assert.equal(aligned[0].originRef, alignedOriginRef("167484", 0));

  // The engines the dataset builder trains on must not appear here at all.
  assert.ok(!rows.some((r) => r.engine === "ivrit" || r.engine === "human"));
});

test("a rejected item stores the article and NOTHING trainable", () => {
  const other = Array(14).fill("\u05d0\u05d9\u05e0\u05d3\u05e2\u05e8\u05e4\u05e8\u05d9").join(" ");
  const alignment = alignItem({ externalId: "9", fullText: other }, timedWordsFrom(asrRows(WORDS)));
  const rows = transcriptRowsFor("item-9", { externalId: "9", fullText: other }, alignment);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, PUBLISHER_ENGINE);
});
