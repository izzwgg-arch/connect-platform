/**
 * Loopcom Yiddish Corpus — the GOLD SET.
 *
 * A native ear corrects a few hundred machine transcripts. Those corrections
 * become (a) the eval set that proves a fine-tuned model actually improved,
 * and (b) the highest-weight rows in the training set (Lane B's
 * `build-dataset.ts` always keeps gold in eval and duplicates it into train).
 *
 * Everything in this file is a PURE function: no `db`, no `fetch`, no `fs`.
 * The routes in `routes.ts` call these and do the I/O; that split is what
 * makes the sampling math and the upload guards testable without booting
 * Fastify or a database (see `gold.test.ts`).
 *
 * ⛔ Nothing here ever calls Yiddish Labs, and nothing here mutates a
 * machine-produced transcript's TEXT — `decide()`'s "reject" path only ever
 * asks the caller to zero the row's confidence, and "correct"/"accept" only
 * ever produce a NEW row (`engine: "human"`). The machine row is evidence of
 * what the model got wrong; overwriting it would erase that evidence.
 */
import { join as pathJoin } from "node:path";

// ── storage layout ───────────────────────────────────────────────────────────

/** Root directory for everything this file writes. One env var, one root. */
export function goldStorageRoot(): string {
  return String(process.env.YIDDISH_CORPUS_STORAGE_DIR || "/var/lib/connect/yiddish-corpus").replace(/\/+$/, "");
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/** Where a gold clip's WAV bytes live. Throws on anything that isn't a plain id
 *  (cuids are, always) — a review id never carries a path separator. */
export function goldClipPath(reviewId: string): string {
  const id = String(reviewId || "").trim();
  if (!SAFE_ID.test(id)) throw new Error("invalid_review_id");
  return pathJoin(goldStorageRoot(), "gold", `${id}.wav`);
}

/** Where the fine-tune report (Lane B's `report.json`) is kept: one "latest"
 *  file `GET /gold/stats` reads, plus a timestamped copy for history. A JSON
 *  file under the same storage root — no new table, and the shape is Lane B's
 *  to define, so a fixed schema here would just drift. */
export function finetuneReportPaths(now: Date = new Date()): { latest: string; history: string; dir: string } {
  const dir = pathJoin(goldStorageRoot(), "finetune");
  return {
    dir,
    latest: pathJoin(dir, "latest-report.json"),
    history: pathJoin(dir, `report-${now.toISOString().replace(/[:.]/g, "-")}.json`),
  };
}

// ── sampling ──────────────────────────────────────────────────────────────────

export interface GoldCandidate {
  transcriptId: string;
  itemId: string;
  assetId: string;
  sourceKey: string;
  /** null reads as 0 — an unscored row is treated as "the model is unsure",
   *  which is exactly the row we most want a human ear on. */
  confidence: number | null;
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
  segmentId: string | null;
}

/**
 * Stratify by confidence (50% lowest quartile / 30% middle / 20% top — "where
 * the model struggles" gets the most attention, but the eval set still needs
 * some easy rows too), and within each stratum spread round-robin across
 * distinct (sourceKey, itemId) pairs so one long episode or one chatty source
 * cannot fill the set by itself.
 */
export function stratifiedGoldSample(candidates: GoldCandidate[], count: number): GoldCandidate[] {
  const wanted = Math.max(0, Math.floor(count));
  if (wanted === 0 || candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
  const n = sorted.length;
  const lowEnd = Math.ceil(n * 0.5);
  const midEnd = Math.ceil(n * 0.8);
  const strata = [sorted.slice(0, lowEnd), sorted.slice(lowEnd, midEnd), sorted.slice(midEnd)];
  const quotas = splitQuota(wanted, [0.5, 0.3, 0.2]);

  const picked: GoldCandidate[] = [];
  const pickedIds = new Set<string>();
  for (let i = 0; i < strata.length; i++) {
    for (const c of spreadPick(strata[i], quotas[i])) {
      if (pickedIds.has(c.transcriptId)) continue;
      picked.push(c);
      pickedIds.add(c.transcriptId);
    }
  }
  // Strata can run dry (e.g. count > candidates in the low bucket). Top up
  // from whatever is left, still spread, so the caller always gets as close
  // to `count` as the pool allows.
  if (picked.length < wanted) {
    const remaining = sorted.filter((c) => !pickedIds.has(c.transcriptId));
    for (const c of spreadPick(remaining, wanted - picked.length)) {
      if (pickedIds.has(c.transcriptId)) continue;
      picked.push(c);
      pickedIds.add(c.transcriptId);
    }
  }
  return picked.slice(0, wanted);
}

/** Whole-number quotas from a set of shares that sum to ~1, with the rounding
 *  remainder handed to the first (lowest-confidence, highest-priority) share. */
function splitQuota(total: number, shares: number[]): number[] {
  const raw = shares.map((s) => Math.floor(total * s));
  let used = raw.reduce((a, b) => a + b, 0);
  let i = 0;
  while (used < total) {
    raw[i % raw.length] += 1;
    used += 1;
    i += 1;
  }
  return raw;
}

/** Round-robin across distinct (sourceKey, itemId) groups until `quota` rows
 *  are picked or every group is exhausted. */
function spreadPick(pool: GoldCandidate[], quota: number): GoldCandidate[] {
  if (quota <= 0 || pool.length === 0) return [];
  const groups = new Map<string, GoldCandidate[]>();
  for (const c of pool) {
    const key = `${c.sourceKey}::${c.itemId}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }
  const groupArrays = [...groups.values()];
  const picked: GoldCandidate[] = [];
  let round = 0;
  while (picked.length < quota) {
    let addedThisRound = false;
    for (const arr of groupArrays) {
      if (picked.length >= quota) break;
      if (arr.length > round) {
        picked.push(arr[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round++;
  }
  return picked;
}

// ── decide ────────────────────────────────────────────────────────────────────

export const GOLD_DECISIONS = ["correct", "accept", "reject", "skip"] as const;
export type GoldDecision = (typeof GOLD_DECISIONS)[number];

/** The YcReviewItem.state each decision lands in. */
export const GOLD_DECISION_STATE: Record<GoldDecision, string> = {
  correct: "EDITED",
  accept: "APPROVED",
  reject: "REJECTED",
  skip: "DEFERRED",
};

/**
 * The new `engine: "human"` transcript row a "correct" or "accept" decision
 * writes. ⛔ Never the machine row, and never an update to it — a new row,
 * always, so the machine's original guess stays intact as evidence.
 */
export function buildGoldHumanRow(input: {
  reviewId: string;
  itemId: string;
  segmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  language: string | null;
  text: string;
  actor: string;
}): {
  itemId: string;
  segmentId: string | null;
  engine: "human";
  sttProvider: string;
  text: string;
  language: string | null;
  confidence: number;
  isConsensus: boolean;
  originRef: string;
  startMs: number | null;
  endMs: number | null;
} {
  return {
    itemId: input.itemId,
    segmentId: input.segmentId,
    engine: "human",
    sttProvider: input.actor,
    text: input.text,
    language: input.language ?? "yi",
    confidence: 1,
    isConsensus: false,
    originRef: `gold:${input.reviewId}`,
    startMs: input.startMs,
    endMs: input.endMs,
  };
}

// ── clip upload ───────────────────────────────────────────────────────────────

export const YC_GOLD_CLIP_MAX_BYTES = 3 * 1024 * 1024;
const WAV_CONTENT_TYPES = new Set(["audio/wav", "audio/wave", "audio/x-wav"]);

export interface GoldClipRejection {
  ok: false;
  status: number;
  error: string;
  message: string;
}

/** Refuses anything that isn't a small WAV. Pure — the route calls this
 *  before it ever opens a file handle. */
export function validateGoldClipUpload(contentType: string | null | undefined, byteLength: number): { ok: true } | GoldClipRejection {
  const ct = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!WAV_CONTENT_TYPES.has(ct)) {
    return {
      ok: false,
      status: 415,
      error: "unsupported_media_type",
      message: `Gold clips must be uploaded as audio/wav (got "${ct || "no content-type"}").`,
    };
  }
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return { ok: false, status: 400, error: "empty_body", message: "The clip body was empty." };
  }
  if (byteLength > YC_GOLD_CLIP_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: "clip_too_large",
      message: `Gold clips must be ${YC_GOLD_CLIP_MAX_BYTES} bytes or smaller (got ${byteLength}).`,
    };
  }
  return { ok: true };
}

// ── range requests ────────────────────────────────────────────────────────────

export interface ParsedRange {
  start: number;
  end: number;
}

/** A minimal single-range `Range: bytes=start-end` parser — enough for an
 *  <audio> element's seek bar. Anything it doesn't understand returns null,
 *  which the route treats as "send the whole file". */
export function parseRangeHeader(rangeHeader: string | null | undefined, fileSize: number): ParsedRange | null {
  if (!rangeHeader || fileSize <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    const suffixLen = Number(endStr);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    start = Math.max(0, fileSize - suffixLen);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? fileSize - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}
