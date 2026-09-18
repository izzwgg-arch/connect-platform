/**
 * Alignment tests. Every case here is a shape the bulletin archive really has:
 * a small wording correction (the thing this whole source is FOR), a sentence
 * the reader skipped, a sentence the writer never wrote, and a pairing that is
 * simply the wrong article.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALIGN_OPTIONS,
  buildCorrectedSpans,
  findAnchors,
  lcsPairs,
  tokenAgreement,
  type TimedWord,
} from "./bulletinAlign";

// A short Yiddish sentence, token by token, so the tests read as words.
const W = {
  di: "\u05d3\u05d9",
  politsey: "\u05e4\u05d0\u05dc\u05d9\u05e6\u05d9\u05d9",
  hot: "\u05d4\u05d0\u05d8",
  gezogt: "\u05d2\u05e2\u05d6\u05d0\u05d2\u05d8",
  az: "\u05d0\u05d6",
  der: "\u05d3\u05e2\u05e8",
  man: "\u05de\u05d0\u05df",
  vet: "\u05d5\u05d5\u05e2\u05d8",
  optretn: "\u05d0\u05e4\u05d8\u05e8\u05e2\u05d8\u05df", // what was really said
  dosredn: "\u05d3\u05d0\u05e1", // what our ASR heard instead
  morgn: "\u05de\u05d0\u05e8\u05d2\u05df",
  inderfri: "\u05d0\u05d9\u05e0\u05d3\u05e2\u05e8\u05e4\u05e8\u05d9",
  aroys: "\u05d0\u05e8\u05d5\u05d9\u05e1",
};

/** Words at 400 ms each, so a 10-word span is 4 s — inside the default bounds. */
function timed(words: string[], msPerWord = 400): TimedWord[] {
  return words.map((word, i) => ({ word, startMs: i * msPerWord, endMs: (i + 1) * msPerWord }));
}

test("lcsPairs and tokenAgreement measure order-preserving overlap", () => {
  assert.deepEqual(lcsPairs(["a", "b", "c"], ["a", "x", "c"]), [[0, 0], [2, 2]]);
  assert.equal(tokenAgreement(["a", "b", "c", "d"], ["a", "b", "c", "d"]), 1);
  assert.equal(tokenAgreement(["a", "b"], ["b", "a"]), 0.5, "order matters — a bag of words would score 1");
  assert.equal(tokenAgreement([], ["a"]), 0);
});

test("findAnchors only trusts runs of consecutive matches", () => {
  const pairs: Array<[number, number]> = [[0, 0], [1, 1], [2, 2], [5, 9], [6, 10]];
  assert.deepEqual(findAnchors(pairs, 3), [{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 2 }]);
  assert.equal(findAnchors(pairs, 2).length, 2);
  assert.deepEqual(findAnchors([], 3), []);
});

test("a one-word ASR error inside matching speech is CORRECTED, with the audio's timing", () => {
  // This is the whole point of the source: the model mis-heard one word and
  // cannot learn that from its own output.
  const heard = [W.di, W.politsey, W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.dosredn, W.morgn, W.inderfri, W.aroys];
  const typed = [W.di, W.politsey, W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.optretn, W.morgn, W.inderfri, W.aroys].join(" ");
  const spans = buildCorrectedSpans(timed(heard), typed);
  assert.equal(spans.length, 1);
  const s = spans[0];
  assert.match(s.text, new RegExp(W.optretn), "the published wording replaces what was mis-heard");
  assert.match(s.heardText, new RegExp(W.dosredn), "and what we heard is kept for review");
  assert.equal(s.startMs, 0);
  assert.equal(s.endMs, 12 * 400, "timing comes from the audio, never from the text");
  assert.ok(s.divergence > 0 && s.divergence < DEFAULT_ALIGN_OPTIONS.maxSpanDivergence);
});

test("a paragraph the reader SKIPPED is dropped, never invented into the audio", () => {
  // The typed article carries a whole extra sentence that is not in the
  // recording. Emitting it would teach the model to hallucinate it.
  const heard = [W.di, W.politsey, W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.aroys];
  const extra = Array(18).fill(W.morgn).join(" ");
  const typed = [W.di, W.politsey, W.hot, W.gezogt, extra, W.az, W.der, W.man, W.vet, W.aroys].join(" ");
  const spans = buildCorrectedSpans(timed(heard), typed);
  for (const s of spans) {
    assert.ok(!s.text.includes(extra), "no span may carry the unspoken paragraph");
  }
});

test("a wrongly paired article produces nothing at all", () => {
  const heard = [W.di, W.politsey, W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.aroys];
  const typed = Array(12).fill(W.inderfri).join(" ");
  assert.ok(tokenAgreement(heard, typed.split(" ")) < 0.2);
  assert.deepEqual(buildCorrectedSpans(timed(heard), typed), []);
});

test("speech with no anchor at BOTH ends yields no span", () => {
  // Matching only at the very start gives one anchor; a span needs two, because
  // an open-ended span has no evidence of where the agreement stopped.
  const heard = [W.di, W.politsey, W.hot, W.aroys, W.aroys, W.aroys, W.aroys];
  const typed = [W.di, W.politsey, W.hot, W.morgn, W.morgn, W.morgn, W.morgn].join(" ");
  const spans = buildCorrectedSpans(timed(heard), typed);
  assert.deepEqual(spans, []);
});

test("spans shorter than the floor or longer than the ceiling are refused", () => {
  const heard = [W.di, W.politsey, W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.dosredn, W.morgn, W.inderfri, W.aroys];
  const typed = heard.join(" ");
  // 12 words x 100 ms = 1.2 s, under the 1.5 s floor.
  assert.deepEqual(buildCorrectedSpans(timed(heard, 100), typed), []);
  // 12 words x 4 s = 48 s, over the 30 s ceiling.
  assert.deepEqual(buildCorrectedSpans(timed(heard, 4000), typed), []);
});

test("niqqud differences alone never count as a divergence", () => {
  // The site points some words and not others; the same sentence must align.
  const plain = [W.di, W.politsey, W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.aroys, W.morgn];
  const pointed = ["\u05d3\u05b4\u05d9", "\u05e4\u05bc\u05d0\u05b8\u05dc\u05d9\u05e6\u05d9\u05d9", W.hot, W.gezogt, W.az, W.der, W.man, W.vet, W.aroys, W.morgn].join(" ");
  const spans = buildCorrectedSpans(timed(plain), pointed);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].divergence, 0, "pointing is not a difference in what was said");
});
