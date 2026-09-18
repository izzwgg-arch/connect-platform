/**
 * Store harvested bulletin text and the spans that survive alignment.
 *
 * Two kinds of row, both on `YcTranscript`, both deliberately distinct from
 * `ivrit` (our ASR) and `human` (a reviewer's correction):
 *
 *   `publisher`         — the typed article, whole, with NO timing. A record of
 *                         what the site published. Inert: the dataset builder
 *                         filters on an exact engine string, so nothing trains
 *                         on it.
 *   `publisher_aligned` — one row per span that our own ASR heard in the same
 *                         order, carrying the PUBLISHER's wording and the
 *                         AUDIO's timing. This is the only bulletin text that
 *                         may ever become training data.
 *
 * ⛔ The split is the safety property. The typed article is ~97% of what was
 * said (Izzy, 2026-09-18), so storing it as a transcript and letting anything
 * downstream pick it up by accident would teach the model to produce sentences
 * that were never spoken. Keeping the raw text unusable by default, and making
 * the usable rows a strict subset that alignment produced, means a mistake
 * downstream reads as "no data" rather than as "wrong data".
 */
import { PUBLISHER_ENGINE, publisherOriginRef, type BulletinArticle } from "./bulletinText";
import { buildCorrectedSpans, tokenAgreement, DEFAULT_ALIGN_OPTIONS, type AlignOptions, type TimedWord } from "./bulletinAlign";
import { compareTokens } from "./bulletinText";

/** Engine for a span that alignment proved against the audio. */
export const PUBLISHER_ALIGNED_ENGINE = "publisher_aligned";

export function alignedOriginRef(externalId: string, index: number): string {
  return `bulletin:${externalId}#${index}`;
}

/**
 * An item whose typed article and our ASR disagree this much are not the same
 * speech: a mis-paired article, a recording replaced after publication, or a
 * summary rather than a reading. Measured, not guessed — see the README's
 * agreement distribution.
 */
export const MIN_ITEM_AGREEMENT = 0.45;

/** Flatten `YcTranscript.words` (whisper word timestamps) into one stream. */
export function timedWordsFrom(rows: Array<{ startMs: number | null; words: unknown }>): TimedWord[] {
  const out: TimedWord[] = [];
  for (const row of rows) {
    const words = Array.isArray(row.words) ? row.words : [];
    for (const w of words as Array<Record<string, unknown>>) {
      const word = String(w.word ?? w.text ?? "").trim();
      if (!word) continue;
      // Whisper reports word times in SECONDS, relative to the chunk; the row's
      // startMs is the chunk's own offset. Dropping either turns every span's
      // timing into nonsense that still looks plausible.
      const start = Number(w.start);
      const end = Number(w.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const base = Number(row.startMs) || 0;
      out.push({ word, startMs: Math.round(base + start * 1000), endMs: Math.round(base + end * 1000) });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export interface ItemAlignment {
  externalId: string;
  agreement: number;
  heardWords: number;
  typedTokens: number;
  spans: ReturnType<typeof buildCorrectedSpans>;
  /** Why nothing was produced, when nothing was. */
  rejected: string | null;
}

/** Pure: decide what this item contributes, without touching the database. */
export function alignItem(
  article: Pick<BulletinArticle, "externalId" | "fullText">,
  words: TimedWord[],
  opts: AlignOptions = DEFAULT_ALIGN_OPTIONS,
  minAgreement: number = MIN_ITEM_AGREEMENT,
): ItemAlignment {
  const heard = words.map((w) => compareTokens(w.word)[0] ?? "");
  const typed = compareTokens(article.fullText);
  const agreement = tokenAgreement(heard, typed);
  const base = { externalId: article.externalId, agreement: Number(agreement.toFixed(4)), heardWords: heard.length, typedTokens: typed.length };
  if (words.length === 0) return { ...base, spans: [], rejected: "no word-level ASR timing for this item" };
  if (agreement < minAgreement) {
    return { ...base, spans: [], rejected: `agreement ${agreement.toFixed(2)} is below ${minAgreement} — the article and the recording are not the same speech` };
  }
  const spans = buildCorrectedSpans(words, article.fullText, opts);
  return { ...base, spans, rejected: spans.length === 0 ? "no span was anchored at both ends" : null };
}

/** Rows to write for one article. Callers do the DB work; this stays pure so
 * the shape is a test, not a promise. */
export function transcriptRowsFor(
  itemId: string,
  article: Pick<BulletinArticle, "externalId" | "fullText">,
  alignment: ItemAlignment,
  language = "yi",
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [
    {
      itemId,
      engine: PUBLISHER_ENGINE,
      sttProvider: "yiddish24-bulletin",
      text: article.fullText,
      language,
      confidence: null,
      originRef: publisherOriginRef(article.externalId),
      startMs: null,
      endMs: null,
    },
  ];
  alignment.spans.forEach((s, i) => {
    rows.push({
      itemId,
      engine: PUBLISHER_ALIGNED_ENGINE,
      sttProvider: "yiddish24-bulletin",
      text: s.text,
      language,
      // Agreement with the audio, not a model's own confidence in itself.
      confidence: Number((1 - s.divergence).toFixed(4)),
      originRef: alignedOriginRef(article.externalId, i),
      startMs: s.startMs,
      endMs: s.endMs,
    });
  });
  return rows;
}
