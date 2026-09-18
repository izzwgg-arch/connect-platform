/**
 * Align a bulletin's PUBLISHER text against our own ASR of the same recording,
 * and keep only the parts that provably describe the same speech.
 *
 * Why this is not just "use the typed text as the label":
 *
 *   Izzy, 2026-09-18: "It's not 100% word for word, but it is, I would say,
 *   97%, so the agent is going to have to use common sense here too."
 *
 * A 97%-accurate label is worse than useless if the missing 3% is handed to the
 * trainer as truth — the model would be taught to hallucinate the sentences the
 * reader skipped and the words the writer added. So nothing here trusts the
 * typed text on its own. It is only ever used to CORRECT a span our ASR already
 * heard in the same order: the ASR supplies the timing and the evidence that
 * the words were spoken, the publisher supplies the correct spelling of them.
 *
 * The evidence this is worth doing (same item, 166573): our ASR heard
 * `\u05d3\u05d0\u05e1 \u05e8\u05e2\u05d3\u05df` where the typed text reads
 * `\u05d0\u05e4\u05d8\u05e8\u05e2\u05d8\u05df` ("resign"), and dropped
 * `\u05e7\u05d9\u05e8` entirely. Those are exactly the errors a model cannot
 * fix from its own output, which is all it has been trained on so far.
 *
 * ⛔ Nothing in this module writes to the database or decides policy. It is
 * pure: text in, spans out, so the thresholds can be set from a measured
 * distribution rather than from a number somebody liked the look of.
 */
import { compareTokens } from "./bulletinText";

/** One ASR word with its timing, flattened out of `YcTranscript.words`. */
export interface TimedWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface AlignOptions {
  /** Consecutive exactly-equal tokens needed to trust a join point. */
  minAnchorTokens: number;
  /** A corrected span may differ from what was heard by at most this share of
   * its tokens. Above it, the two are describing different speech and the span
   * is dropped rather than "corrected". */
  maxSpanDivergence: number;
  /** Publisher runs longer than this multiple of the heard run are text that
   * was never read aloud (a sign-off, an ad, a paragraph the reader skipped). */
  maxLengthRatio: number;
  /** Longest unmatched stretch that can still be called a wording difference. */
  maxBridgeGapTokens: number;
  /** Longest stretch one side may have entirely to itself (an ASR deletion, or
   * a word the writer left out) before the span is broken instead. */
  maxOneSidedGapTokens: number;
  /** Never emit a clip shorter/longer than these, in ms. */
  minSpanMs: number;
  maxSpanMs: number;
}

export const DEFAULT_ALIGN_OPTIONS: AlignOptions = {
  minAnchorTokens: 3,
  maxSpanDivergence: 0.34,
  maxLengthRatio: 1.6,
  maxBridgeGapTokens: 4,
  maxOneSidedGapTokens: 2,
  minSpanMs: 1_500,
  maxSpanMs: 30_000,
};

/** Longest common subsequence of two token arrays, as index pairs.
 * O(n*m) — fine for a bulletin (a few hundred tokens), and deliberately NOT
 * used on anything longer without chunking first. */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i += 1;
    else j += 1;
  }
  return pairs;
}

/** Share of the HEARD tokens that the publisher text also contains, in order.
 * This is the number that says whether a typed article really is a reading of
 * this recording — a mismatched pairing scores near zero. */
export function tokenAgreement(heard: string[], typed: string[]): number {
  if (heard.length === 0) return 0;
  return lcsPairs(heard, typed).length / heard.length;
}

/** Runs of ≥minAnchorTokens consecutive matches in both streams at once. */
export function findAnchors(pairs: Array<[number, number]>, minAnchorTokens: number): Array<{ aStart: number; aEnd: number; bStart: number; bEnd: number }> {
  const out: Array<{ aStart: number; aEnd: number; bStart: number; bEnd: number }> = [];
  let run: Array<[number, number]> = [];
  const flush = () => {
    if (run.length >= minAnchorTokens) {
      out.push({ aStart: run[0][0], aEnd: run[run.length - 1][0], bStart: run[0][1], bEnd: run[run.length - 1][1] });
    }
    run = [];
  };
  for (const p of pairs) {
    const last = run[run.length - 1];
    if (last && p[0] === last[0] + 1 && p[1] === last[1] + 1) run.push(p);
    else {
      flush();
      run = [p];
    }
  }
  flush();
  return out;
}

export interface CorrectedSpan {
  startMs: number;
  endMs: number;
  /** The PUBLISHER's wording for this stretch of audio. */
  text: string;
  /** What our ASR heard here — kept so a reviewer can see the correction. */
  heardText: string;
  /** 0 = identical to what was heard, 1 = nothing in common. */
  divergence: number;
  anchorTokensBefore: number;
  anchorTokensAfter: number;
}

/**
 * Grow spans over the anchors, breaking wherever the two texts stop describing
 * the same speech.
 *
 * A span starts at an anchor and extends through the next anchor whenever the
 * GAP between them is a small wording difference. It closes when the gap is
 * not: that is where the reader skipped a line, the writer added one, or the
 * pairing is simply wrong. Material outside a span is never emitted — there is
 * no evidence of what was said there, and inventing it is precisely the failure
 * this source is supposed to fix.
 *
 * ⛔ An earlier version only ever emitted anchor-PAIR spans, which meant a
 * recording that matched its article perfectly — the best possible case —
 * produced nothing at all. Growing from a single anchor is what makes a clean
 * item usable.
 */
export function buildCorrectedSpans(
  words: TimedWord[],
  typedText: string,
  opts: AlignOptions = DEFAULT_ALIGN_OPTIONS,
): CorrectedSpan[] {
  const heardTokens = words.map((w) => compareTokens(w.word)[0] ?? "");
  const typedRaw = typedText.split(/\s+/).filter(Boolean);
  const typedTokens = typedRaw.map((t) => compareTokens(t)[0] ?? "");
  const anchors = findAnchors(lcsPairs(heardTokens, typedTokens), opts.minAnchorTokens);
  if (anchors.length === 0) return [];

  /** Is the unmatched stretch between two anchors a wording difference, or is
   * it one side saying something the other never says?
   *
   * ⛔ Judge a gap by its SIZE, not by how much of it matches. A gap is
   * unmatched by definition, so a one-word substitution — the single most
   * valuable correction this source offers — scores 100% divergent and an
   * earlier version refused every one of them. What separates a correction
   * from invented text is length: a couple of tokens is a misspelling or a
   * word our ASR dropped (Izzy's own example: it lost קיר entirely);
   * a clause is a sentence one side never had.
   */
  const gapIsBridgeable = (prev: (typeof anchors)[number], next: (typeof anchors)[number]): boolean => {
    const heardGap = heardTokens.slice(prev.aEnd + 1, next.aStart);
    const typedGap = typedTokens.slice(prev.bEnd + 1, next.bStart);
    const longer = Math.max(heardGap.length, typedGap.length);
    const shorter = Math.min(heardGap.length, typedGap.length);
    if (longer === 0) return true;
    if (longer > opts.maxBridgeGapTokens) return false;
    // One side empty: either our ASR dropped a word that was said, or the
    // writer left out a word that was. Both are fine at a word or two and
    // neither is at a clause.
    if (shorter === 0) return longer <= opts.maxOneSidedGapTokens;
    return longer / shorter <= opts.maxLengthRatio;
  };

  const finish = (from: (typeof anchors)[number], to: (typeof anchors)[number]): CorrectedSpan | null => {
    const aFrom = from.aStart;
    const aTo = to.aEnd;
    const bFrom = from.bStart;
    const bTo = to.bEnd;
    const durationMs = words[aTo].endMs - words[aFrom].startMs;
    if (durationMs < opts.minSpanMs || durationMs > opts.maxSpanMs) return null;
    const heardSlice = heardTokens.slice(aFrom, aTo + 1);
    const typedSlice = typedTokens.slice(bFrom, bTo + 1);
    const longest = Math.max(heardSlice.length, typedSlice.length);
    const divergence = longest === 0 ? 1 : 1 - lcsPairs(heardSlice, typedSlice).length / longest;
    if (divergence > opts.maxSpanDivergence) return null;
    return {
      startMs: words[aFrom].startMs,
      endMs: words[aTo].endMs,
      text: typedRaw.slice(bFrom, bTo + 1).join(" "),
      heardText: words.slice(aFrom, aTo + 1).map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(),
      divergence: Number(divergence.toFixed(4)),
      anchorTokensBefore: from.aEnd - from.aStart + 1,
      anchorTokensAfter: to.aEnd - to.aStart + 1,
    };
  };

  const spans: CorrectedSpan[] = [];
  let start = anchors[0];
  let end = anchors[0];
  for (let k = 1; k <= anchors.length; k += 1) {
    const next = anchors[k];
    const tooLong = next ? words[next.aEnd].endMs - words[start.aStart].startMs > opts.maxSpanMs : false;
    if (next && !tooLong && gapIsBridgeable(end, next)) {
      end = next;
      continue;
    }
    const span = finish(start, end);
    if (span) spans.push(span);
    if (!next) break;
    start = next;
    end = next;
  }
  return spans;
}
