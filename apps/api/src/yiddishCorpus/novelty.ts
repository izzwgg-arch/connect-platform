/**
 * Yiddish corpus — novelty scoring.
 *
 * ⛔ WHAT THIS IS FOR: ORDERING THE QUEUE. Nothing is ever deleted, skipped or
 * excluded because of a novelty score. A low score means "later", never "no".
 * That is the whole guarantee, and `scoreNovelty` therefore has no branch that
 * can reject an item.
 *
 * Today the engine has no audio (the Yiddish24 rights gate refuses), so the
 * honest score is a METADATA score: a series, host or category we have not
 * seen before, and a duration unlike anything already in this source. When
 * audio features do exist they are folded in as extra components — the shape
 * does not change, the reasons just get longer.
 */

export interface NoveltyFeatures {
  /** From audioPipeline.detectSegments. */
  speechRatio?: number | null;
  /** From audioPipeline.extractFeatures. */
  speechRateEstimate?: number | null;
  pausesPerMinute?: number | null;
  rmsDb?: number | null;
  /** Share of transcript tokens not already in YcLexeme. 0..1. */
  outOfVocabularyRatio?: number | null;
  /** True when the speaker could not be matched to an existing cluster. */
  newSpeakerCluster?: boolean | null;
}

export interface NoveltyComponent {
  key: string;
  weight: number;
  value: number;
  reason: string;
}

export interface NoveltyResult {
  /** 0..1. Higher = look at this sooner. */
  score: number;
  reasons: string[];
  components: NoveltyComponent[];
  /** METADATA when no audio features were supplied, MIXED when they were. */
  basis: "METADATA" | "MIXED";
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Duration bands, in seconds. An item far outside the source's own bands is interesting. */
function durationBand(sec: number | null | undefined): string | null {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 60) return "under_1m";
  if (n < 300) return "1_5m";
  if (n < 900) return "5_15m";
  if (n < 1800) return "15_30m";
  if (n < 3600) return "30_60m";
  return "over_1h";
}

async function safeCount(db: any, where: Record<string, unknown>): Promise<number | null> {
  try {
    const n = await db.ycSourceItem.count({ where });
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Score one item. Reads only counts, never content, so it is safe to run
 * against a CUSTOMER_PRIVATE source as well.
 */
export async function scoreNovelty(
  db: any,
  item: {
    id?: string;
    sourceId?: string;
    seriesName?: string | null;
    host?: string | null;
    category?: string | null;
    durationSec?: number | null;
  },
  features: NoveltyFeatures | null = null,
): Promise<NoveltyResult> {
  const sourceId = item.sourceId;
  const components: NoveltyComponent[] = [];
  const reasons: string[] = [];

  const add = (key: string, weight: number, value: number, reason: string) => {
    const v = clamp01(value);
    components.push({ key, weight, value: v, reason });
    if (v > 0) reasons.push(reason);
  };

  // ── metadata novelty ─────────────────────────────────────────────────────
  if (item.seriesName && sourceId) {
    const seen = await safeCount(db, { sourceId, seriesName: item.seriesName, NOT: { id: item.id ?? "__none__" } });
    if (seen == null) add("series", 0.25, 0.5, "series history could not be read — scored as mildly novel");
    else if (seen === 0) add("series", 0.25, 1, `first item we have seen from the series "${item.seriesName}"`);
    else add("series", 0.25, 1 / (1 + Math.log10(1 + seen)) - 0.5 < 0 ? 0 : 1 / (1 + Math.log10(1 + seen)) - 0.5,
      `${seen} items already from "${item.seriesName}"`);
  } else {
    add("series", 0.25, 0.4, "no series name on this item");
  }

  if (item.host && sourceId) {
    const seen = await safeCount(db, { sourceId, host: item.host, NOT: { id: item.id ?? "__none__" } });
    if (seen === 0) add("host", 0.2, 1, `first item we have seen from "${item.host}"`);
    else if (seen != null && seen < 5) add("host", 0.2, 0.5, `only ${seen} items so far from "${item.host}"`);
    else add("host", 0.2, 0, `"${item.host}" is already well represented`);
  } else {
    // The source states no host. That is a fact about the source, not novelty.
    add("host", 0.1, 0, "the source publishes no host field");
  }

  if (item.category && sourceId) {
    const seen = await safeCount(db, { sourceId, category: item.category, NOT: { id: item.id ?? "__none__" } });
    if (seen === 0) add("category", 0.15, 1, `first item in category "${item.category}"`);
    else if (seen != null && seen < 10) add("category", 0.15, 0.5, `category "${item.category}" is thin (${seen} items)`);
    else add("category", 0.15, 0, `category "${item.category}" is well covered`);
  } else {
    add("category", 0.15, 0.3, "no category on this item");
  }

  const band = durationBand(item.durationSec);
  if (band && sourceId) {
    const total = await safeCount(db, { sourceId });
    const inBand = await safeCount(db, {
      sourceId,
      durationSec: durationWhereForBand(band),
      NOT: { id: item.id ?? "__none__" },
    });
    if (total != null && total > 20 && inBand != null) {
      const share = inBand / Math.max(total, 1);
      if (share < 0.02) add("duration", 0.15, 1, `an unusual length for this source (${band.replace(/_/g, " ")}, ${(share * 100).toFixed(1)}% of items)`);
      else if (share < 0.1) add("duration", 0.15, 0.5, `a less common length for this source (${band.replace(/_/g, " ")})`);
      else add("duration", 0.15, 0, `a typical length for this source (${band.replace(/_/g, " ")})`);
    } else {
      add("duration", 0.15, 0.4, "not enough items yet to know what a usual length is here");
    }
  } else {
    add("duration", 0.15, 0.4, "no duration on this item");
  }

  // ── acoustic / lexical novelty, only when audio actually exists ───────────
  let basis: NoveltyResult["basis"] = "METADATA";
  if (features) {
    basis = "MIXED";
    if (features.newSpeakerCluster) add("speaker", 0.35, 1, "a speaker we have not heard before");
    if (features.outOfVocabularyRatio != null) {
      const oov = clamp01(features.outOfVocabularyRatio);
      add("lexical", 0.3, oov, `${(oov * 100).toFixed(0)}% of the words are ones the lexicon has not seen`);
    }
    if (features.speechRateEstimate != null) {
      // Distance from the middle of the observed band, normalized. A rate we
      // rarely hear is worth listening to.
      const r = Number(features.speechRateEstimate);
      const dist = Math.min(1, Math.abs(r - 2.5) / 2.5);
      add("speech_rate", 0.2, dist, `speech-rate estimate ${r.toFixed(2)} bursts/s is ${dist > 0.5 ? "well" : "somewhat"} off the usual band`);
    }
    if (features.speechRatio != null) {
      const s = clamp01(features.speechRatio);
      // Mostly-music items are LOW value for pronunciation, so low novelty.
      add("speech_share", 0.2, s < 0.3 ? 0 : s, `${(s * 100).toFixed(0)}% of the audio measured as speech`);
    }
    if (features.pausesPerMinute != null) {
      const p = Number(features.pausesPerMinute);
      const dist = Math.min(1, Math.abs(p - 12) / 12);
      add("pause_pattern", 0.1, dist, `${p.toFixed(1)} pauses/min — ${dist > 0.5 ? "an unusual" : "a typical"} rhythm`);
    }
  }

  const totalWeight = components.reduce((a, c) => a + c.weight, 0) || 1;
  const score = Number(
    clamp01(components.reduce((a, c) => a + c.weight * c.value, 0) / totalWeight).toFixed(4),
  );

  return {
    score,
    reasons: reasons.length ? reasons : ["nothing about this item stands out yet"],
    components,
    basis,
  };
}

function durationWhereForBand(band: string): Record<string, number> {
  switch (band) {
    case "under_1m":
      return { lt: 60 };
    case "1_5m":
      return { gte: 60, lt: 300 };
    case "5_15m":
      return { gte: 300, lt: 900 };
    case "15_30m":
      return { gte: 900, lt: 1800 };
    case "30_60m":
      return { gte: 1800, lt: 3600 };
    default:
      return { gte: 3600 };
  }
}

/** Exported for the queue-ordering code and its test. */
export function noveltyToPriority(score: number): number {
  // YcSourceItem.priority: lower sorts first in the queue index.
  const s = clamp01(score);
  return Math.max(1, Math.min(99, Math.round(99 - s * 98)));
}
