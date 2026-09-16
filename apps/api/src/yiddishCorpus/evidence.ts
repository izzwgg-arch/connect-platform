/**
 * Loopcom Yiddish Corpus — EVIDENCE. Observations → scores. Never rules.
 *
 * The one idea this file exists to enforce: INDEPENDENCE, not raw counts.
 * 500 repeats from one radio host is one person's habit, not "the accent". So
 * each source's support saturates at YC_SPEAKER_SATURATION × the number of
 * distinct speaker clusters it contributed, and only then is it weighted by
 * YC_SOURCE_WEIGHTS. Yiddish Labs carries weight 0 here on purpose: it tells
 * us how a word is SPELLED, never how it is SAID.
 *
 * Scores come out as a Beta(1,1) posterior mean — (1 + a) / (2 + total) — so a
 * single observation never reads as certainty, and two variants with equal
 * support sit at 0.5 each instead of one of them "winning".
 *
 * ⛔ An observation is never a rule. `eligibleForRule` is the gate, and for
 * NAME / BUSINESS / PLACE it can only open with a human observation present,
 * whatever the score says.
 */
import {
  YC_HUMAN_REQUIRED_ORIGINS,
  YC_MIN_SAMPLES_FOR_CONCLUSION,
  YC_RULE_SCORE_THRESHOLD,
  YC_SOURCE_WEIGHTS,
  YC_SPEAKER_SATURATION,
  type YcEvidenceKind,
  type YcLexemeOrigin,
  type YcVariantScore,
} from "./contracts";

export interface YcObservationLike {
  variantKey: string;
  realization?: string | null;
  /** Which registered source this was heard in ("internal", "yiddish24", …). */
  sourceKey: string;
  /** Anonymous speaker cluster. null = unknown, and unknown speakers do NOT
   *  buy independence: they all share one bucket, so a pile of unattributed
   *  observations saturates at the same cap a single speaker would. */
  speakerClusterId?: string | null;
  confidence?: number | null;
  evidenceKind: YcEvidenceKind | string;
  itemId?: string | null;
}

export interface YcScoreOpts {
  /** The lexeme's origin — decides whether a human is mandatory for a rule. */
  origin?: YcLexemeOrigin | string | null;
  /** Source keys to leave out (the "recompute without Yiddish24" switch). */
  excludeSourceKeys?: string[];
  /** Override the rule threshold (calibration only; defaults to the contract). */
  ruleScoreThreshold?: number;
  /** Below this many observations the engine refuses to call a winner. */
  minSamplesForConclusion?: number;
}

const UNKNOWN_SPEAKER = "__unknown_speaker__";

/** A source key's weight. Unlisted keys are ordinary internal evidence (1). */
export function weightForSource(sourceKey: string, evidenceKind?: string | null): number {
  // A human confirmation dominates whatever source it arrived through.
  if (String(evidenceKind ?? "").toUpperCase() === "HUMAN") return YC_SOURCE_WEIGHTS.human ?? 5;
  // Lexical-only evidence (the YL translation cache) is spelling, not sound.
  if (String(evidenceKind ?? "").toUpperCase() === "LEXICAL_ONLY") return 0;
  const exact = YC_SOURCE_WEIGHTS[sourceKey];
  if (typeof exact === "number") return exact;
  if (sourceKey.includes("yiddishlabs")) return YC_SOURCE_WEIGHTS.yiddishlabs ?? 0;
  return YC_SOURCE_WEIGHTS.internal ?? 1;
}

/** Drop whole sources from a set of observations, so the UI can recompute. */
export function excludeSources<T extends YcObservationLike>(observations: T[], keys: string[]): T[] {
  if (!keys || keys.length === 0) return [...observations];
  const drop = new Set(keys);
  return observations.filter((o) => !drop.has(o.sourceKey));
}

function clampConfidence(v: number | null | undefined): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}

interface BucketAccum {
  raw: number;
  speakers: Set<string>;
  weight: number;
}

/**
 * Score every variant of one lexeme.
 *
 * Per variant, per (source × weight class):
 *   raw       = Σ confidence of its observations
 *   cap       = YC_SPEAKER_SATURATION × distinct speaker clusters in that bucket
 *   effective = weight × min(raw, cap)
 *
 * The cap is the anti-flood rule: with saturation 3, one speaker can contribute
 * at most 3 units no matter how many times they say the word.
 */
export function scoreVariants(observations: YcObservationLike[], opts: YcScoreOpts = {}): YcVariantScore[] {
  const rows = excludeSources(observations ?? [], opts.excludeSourceKeys ?? []);
  const threshold = opts.ruleScoreThreshold ?? YC_RULE_SCORE_THRESHOLD;
  const minSamples = opts.minSamplesForConclusion ?? YC_MIN_SAMPLES_FOR_CONCLUSION;
  const origin = (opts.origin ?? null) as YcLexemeOrigin | null;
  const humanRequired = origin !== null && YC_HUMAN_REQUIRED_ORIGINS.includes(origin);

  interface VariantAccum {
    variantKey: string;
    realization: string | null;
    obs: number;
    speakers: Set<string>;
    sources: Set<string>;
    humanConfirmed: boolean;
    buckets: Map<string, BucketAccum>;
  }

  const variants = new Map<string, VariantAccum>();
  for (const o of rows) {
    if (!o || typeof o.variantKey !== "string" || o.variantKey.length === 0) continue;
    let v = variants.get(o.variantKey);
    if (!v) {
      v = {
        variantKey: o.variantKey,
        realization: o.realization ?? null,
        obs: 0,
        speakers: new Set<string>(),
        sources: new Set<string>(),
        humanConfirmed: false,
        buckets: new Map<string, BucketAccum>(),
      };
      variants.set(o.variantKey, v);
    }
    if (v.realization === null && o.realization) v.realization = o.realization;
    const kind = String(o.evidenceKind ?? "").toUpperCase();
    const weight = weightForSource(o.sourceKey, kind);
    const speaker = o.speakerClusterId ?? UNKNOWN_SPEAKER;
    const bucketKey = `${o.sourceKey}::${weight}`;
    let b = v.buckets.get(bucketKey);
    if (!b) {
      b = { raw: 0, speakers: new Set<string>(), weight };
      v.buckets.set(bucketKey, b);
    }
    b.raw += clampConfidence(o.confidence);
    b.speakers.add(speaker);
    v.obs += 1;
    v.speakers.add(speaker);
    v.sources.add(o.sourceKey);
    if (kind === "HUMAN") v.humanConfirmed = true;
  }

  const scored = [...variants.values()].map((v) => {
    let effective = 0;
    for (const b of v.buckets.values()) {
      const cap = YC_SPEAKER_SATURATION * Math.max(1, b.speakers.size);
      effective += b.weight * Math.min(b.raw, cap);
    }
    return { v, effective };
  });

  const totalEffective = scored.reduce((sum, s) => sum + s.effective, 0);
  const totalObs = scored.reduce((sum, s) => sum + s.v.obs, 0);

  const out: YcVariantScore[] = scored.map(({ v, effective }) => {
    // Beta(1,1) posterior mean. With no weighted evidence at all this is 0.5,
    // which is the honest answer: we have spellings, not pronunciations.
    const score = (1 + effective) / (2 + totalEffective);
    const share = totalEffective > 0 ? effective / totalEffective : 0;

    let blockedReason: string | null = null;
    if (humanRequired && !v.humanConfirmed) {
      blockedReason =
        `This is a ${origin} and no person has confirmed it. Names, businesses and places ` +
        `always need a human approval before they become a rule, whatever the score is.`;
    } else if (score < threshold) {
      blockedReason =
        `Not enough independent support yet: score ${score.toFixed(2)} is below the ` +
        `${threshold} needed for a rule (${v.obs} observations, ${v.speakers.size} speaker` +
        `${v.speakers.size === 1 ? "" : "s"}, ${v.sources.size} source${v.sources.size === 1 ? "" : "s"}).`;
    } else if (totalObs < minSamples) {
      blockedReason =
        `Only ${totalObs} observation${totalObs === 1 ? "" : "s"} for this word in total; ` +
        `the engine does not call a winner below ${minSamples}.`;
    }

    return {
      variantKey: v.variantKey,
      realization: v.realization,
      score,
      share,
      support: { obs: v.obs, speakers: v.speakers.size, sources: v.sources.size },
      effective,
      humanConfirmed: v.humanConfirmed,
      eligibleForRule: blockedReason === null,
      blockedReason,
    };
  });

  out.sort((a, b) => b.score - a.score || b.support.obs - a.support.obs || a.variantKey.localeCompare(b.variantKey));
  return out;
}

/** Two variants both carrying a real share = a live disagreement, not noise. */
export const YC_CONFLICT_SHARE_FLOOR = 0.2;

export interface YcConflict {
  open: boolean;
  shareFloor: number;
  variantKeys: string[];
  note: string;
}

/**
 * An open conflict is two or more variants above the share floor. We never
 * force a single spelling: the conflict is surfaced for a person to decide.
 */
export function conflictsFor(variants: YcVariantScore[], shareFloor = YC_CONFLICT_SHARE_FLOOR): YcConflict {
  const contenders = (variants ?? []).filter((v) => v.share >= shareFloor);
  const open = contenders.length >= 2;
  return {
    open,
    shareFloor,
    variantKeys: contenders.map((v) => v.variantKey),
    note: open
      ? `${contenders.length} pronunciations are each used at least ${Math.round(shareFloor * 100)}% of the time. ` +
        `Both are real; a person decides which one the voice uses, or whether it depends on context.`
      : "No competing pronunciation carries a meaningful share.",
  };
}
