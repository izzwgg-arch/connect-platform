/**
 * Loopcom Yiddish Corpus — GOVERNANCE. The enforcement layer.
 *
 * Every other module in this folder calls into here before it reads content,
 * fetches a byte of audio, or lets a row into an export. Nothing bypasses it:
 * the rules live in code with guard tests, not in a comment somebody remembers.
 *
 * The three walls (contracts.ts, §governance):
 *
 *   1. CUSTOMER WALL — customer voicemails, calls and chats are COUNTED,
 *      never READ. `assertContentReadable` throws for them unless the owner
 *      has recorded a basis (`contentAllowed = true` on the source row).
 *      Counting a private source is always allowed; that is the whole point.
 *
 *   2. YIDDISH LABS IS SERVING-ONLY — YL output can inform spelling and
 *      meaning, never a training export. And an UNPROVABLE provider counts
 *      as YL: the legacy `stt-yi` voicemail rows were "YL-first, ivrit
 *      fallback in a bare catch", so per-row provenance cannot be recovered.
 *      We cannot prove those rows are not YL, so they are treated as YL.
 *
 *   3. EXTERNAL AUDIO NEEDS BOTH GATES — the owner must have flipped the
 *      source to OWNER_AUTHORIZED *and* recorded a GRANTED rights record.
 *      One without the other refuses. No header forging, ever.
 *
 * Style: plain functions, `db: any` where a Prisma client is needed (it is not
 * needed here — governance is pure, which is what makes it testable).
 */
import {
  YC_AUDIO_BLOCKED_MESSAGE,
  YC_CUSTOMER_WALL_MESSAGE,
  YC_YL_SERVING_ONLY_MESSAGE,
  type YcAllowedUse,
  type YcEvidenceKind,
  type YcGovernanceBadge,
  type YcGovernanceClass,
  type YcRightsState,
  type YcTrainingEligibility,
} from "./contracts";

// ── Shapes ───────────────────────────────────────────────────────────────────
// Deliberately structural, not Prisma types: a YcSource row satisfies them, and
// so does a literal in a test. Governance must be checkable without a database.

export interface YcSourceLike {
  key: string;
  name?: string | null;
  governanceClass: YcGovernanceClass | string;
  /** Owner-set: may content from this source be read into the corpus at all. */
  contentAllowed: boolean;
  /** "DISABLED" | "OWNER_AUTHORIZED" */
  audioFetchMode: string;
  /** "UNKNOWN" | "ALLOWED" | "RESTRICTED" | "EXCLUDED" — the owner's ceiling. */
  trainingExportEligibility?: string | null;
  rightsNote?: string | null;
}

export interface YcRightsLike {
  allowedUse: YcAllowedUse | string;
  state: YcRightsState | string;
  decidedBy?: string | null;
  evidence?: string | null;
}

/**
 * Anything that can be asked "may you leave in a training export?" — a
 * transcript row, an observation, a lexeme sighting. Every field is optional
 * because provenance is often partial; partial provenance never means "fine".
 */
export interface YcRowProvenance {
  id?: string;
  sourceKey?: string | null;
  /** YcTranscript.engine: yiddishlabs | ivrit | openai | human | unknown | stt-yi */
  engine?: string | null;
  /** YcTranscript.sttProvider — null/"unknown" on a legacy row is NOT proof of anything. */
  sttProvider?: string | null;
  evidenceKind?: YcEvidenceKind | string | null;
  /** An explicit, recorded human consent for this row (not a guess). */
  consented?: boolean | null;
  /** Free-text provenance note, scanned for a YL marker as a last resort. */
  originRef?: string | null;
}

export class YcGovernanceError extends Error {
  readonly code: string;
  readonly sourceKey: string | null;
  constructor(code: string, message: string, sourceKey?: string | null) {
    super(message);
    this.name = "YcGovernanceError";
    this.code = code;
    this.sourceKey = sourceKey ?? null;
  }
}

// ── The Yiddish Labs markers ─────────────────────────────────────────────────
// Mirrors apps/agent/src/corpus/corpus.ts (TRAINING_FORBIDDEN_MODELS), which is
// the existing, deployed enforcement for the same policy. Kept as a substring
// match here because engine strings in this folder carry suffixes ("yl-sync").

const YL_MARKERS = ["yiddishlabs", "yiddish-labs", "yiddish_labs", "yiddish labs"];

/** Legacy engine tags whose per-row provider was never recorded. */
const UNPROVABLE_PROVIDER_ENGINES = ["stt-yi", "stt_yi", "sttyi"];

/** A provider string that proves nothing. Anything here is "we do not know". */
const NON_PROOF_PROVIDERS = ["", "unknown", "null", "undefined", "n/a", "-"];

function lower(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function hasYlMarker(v: unknown): boolean {
  const s = lower(v);
  if (!s) return false;
  if (s === "yl") return true; // exact only: "yl" as a substring hits "only", "openly", …
  return YL_MARKERS.some((m) => s.includes(m));
}

/**
 * Is this row Yiddish-Labs-derived — including "we cannot prove it is not"?
 *
 * ⛔ The second half is the load-bearing half. 3,510 voicemail transcripts
 * carry engine `stt-yi`, produced by a YL-first path with an ivrit fallback in
 * a bare catch. Nothing per row says which one answered. An unprovable
 * provider is treated as YL, because the alternative is exporting YL output.
 */
export function isYlDerived(row: YcRowProvenance | null | undefined): boolean {
  if (!row) return false;
  if (hasYlMarker(row.engine) || hasYlMarker(row.sttProvider) || hasYlMarker(row.sourceKey)) return true;
  if (hasYlMarker(row.originRef)) return true;
  const engine = lower(row.engine);
  if (UNPROVABLE_PROVIDER_ENGINES.includes(engine)) {
    const provider = lower(row.sttProvider);
    // A named, non-YL provider on a legacy row IS proof (somebody backfilled it).
    if (NON_PROOF_PROVIDERS.includes(provider)) return true;
    return hasYlMarker(provider);
  }
  return false;
}

// ── Wall 1: content ──────────────────────────────────────────────────────────

/**
 * Counting is always allowed. Reading content is the thing that is gated.
 *
 * Only CUSTOMER_PRIVATE is walled. PLATFORM and EXTERNAL content is readable
 * (whether it may be EXPORTED is a separate question — `trainingEligibilityOf`),
 * which is why the schema's `contentAllowed` default of false does not wall the
 * platform's own translation cache.
 */
export function canReadContent(source: YcSourceLike): boolean {
  if (source.governanceClass === "CUSTOMER_PRIVATE") return source.contentAllowed === true;
  return true;
}

/**
 * Throws unless the source's content may be read into the corpus.
 * CUSTOMER_PRIVATE sources refuse until the owner records a basis.
 */
export function assertContentReadable(source: YcSourceLike): void {
  if (source.governanceClass === "CUSTOMER_PRIVATE" && source.contentAllowed !== true) {
    throw new YcGovernanceError("CUSTOMER_WALL", YC_CUSTOMER_WALL_MESSAGE, source.key);
  }
}

// ── Wall 3: audio bytes ──────────────────────────────────────────────────────

export interface YcAudioDecision {
  ok: boolean;
  reason: string | null;
}

/**
 * Audio bytes may be fetched only when BOTH gates are open:
 *   • the source is set to OWNER_AUTHORIZED (a human flipped it), and
 *   • a rights record for `analysis` (or `store_audio`) is GRANTED.
 * Either one alone refuses, with the plain-English message the UI shows.
 */
export function assertAudioFetchAllowed(
  source: YcSourceLike,
  rights: YcRightsLike[] | null | undefined,
): YcAudioDecision {
  const list = Array.isArray(rights) ? rights : [];
  const modeOk = source.audioFetchMode === "OWNER_AUTHORIZED";
  const grantOk = list.some(
    (r) => (r.allowedUse === "analysis" || r.allowedUse === "store_audio") && r.state === "GRANTED",
  );
  if (modeOk && grantOk) return { ok: true, reason: null };
  return { ok: false, reason: YC_AUDIO_BLOCKED_MESSAGE };
}

// ── Wall 2 + the export filter ───────────────────────────────────────────────

export type YcExclusionReason =
  | "CUSTOMER_PRIVATE"
  | "YL_DERIVED"
  | "SOURCE_MARKED_EXCLUDED"
  | "NO_EXTERNAL_RIGHTS"
  | "NOT_HUMAN_OR_CONSENTED";

/** Plain English for each reason — the export screen prints these verbatim. */
export const YC_EXCLUSION_TEXT: Record<YcExclusionReason, string> = {
  CUSTOMER_PRIVATE: YC_CUSTOMER_WALL_MESSAGE,
  YL_DERIVED: YC_YL_SERVING_ONLY_MESSAGE,
  SOURCE_MARKED_EXCLUDED: "The owner has marked this source excluded from every training export.",
  NO_EXTERNAL_RIGHTS:
    "This is an external source and the owner has not recorded a GRANTED rights record for training_export.",
  NOT_HUMAN_OR_CONSENTED:
    "Kept in the corpus, but not exported: the row is machine-produced and nobody has recorded a consent or a human confirmation for it.",
};

export interface YcTrainingVerdict {
  eligibility: YcTrainingEligibility;
  /** Every reason that applies, in ladder order. `reasons[0]` is the primary. */
  reasons: YcExclusionReason[];
  /** The one reason a breakdown counts this row under (null when ALLOWED). */
  primaryReason: YcExclusionReason | null;
  note: string;
}

export interface YcTrainingOpts {
  /** The rights records for the row's source (used for EXTERNAL sources). */
  rights?: YcRightsLike[] | null;
  /** Row-level provenance. Absent provenance never upgrades a verdict. */
  row?: YcRowProvenance | null;
}

/**
 * The ladder. Order matters: the first rung that fires is the primary reason,
 * so a row excluded for several reasons is counted exactly once in a breakdown.
 *
 *   1. CUSTOMER_PRIVATE, unconsented            → EXCLUDED
 *   2. YL-derived (or unprovably not-YL)       → EXCLUDED
 *   3. owner marked the source EXCLUDED        → EXCLUDED
 *   4. EXTERNAL without a training_export grant→ EXCLUDED
 *   5. human / consented                       → ALLOWED
 *   6. anything else                           → RESTRICTED (kept, never exported)
 *
 * ALLOWED is reached only by a human or explicitly consented row on a PLATFORM
 * source, or by an EXTERNAL/CUSTOMER_PRIVATE source the owner has granted
 * training_export on — that recorded grant IS the consent, and it is the only
 * thing that makes the Governance screen's grant meaningful.
 *
 * ⛔ Rung 1 is no longer an unconditional wall. A CUSTOMER_PRIVATE source is
 * treated as consented — and so does NOT trip rung 1 — ONLY when BOTH hold:
 *   • the owner has recorded a basis to read it at all (`contentAllowed === true`), AND
 *   • a `training_export` right for it is GRANTED (`opts.rights`).
 * Either alone still refuses. This is the code path behind Izzy's "I have
 * already cleared it with them… do what I tell you" consent for voicemail and
 * call recordings — a recorded, checkable basis, never a code default.
 */
export function trainingEligibilityOf(source: YcSourceLike, opts: YcTrainingOpts = {}): YcTrainingVerdict {
  const row = opts.row ?? null;
  const rights = Array.isArray(opts.rights) ? opts.rights : [];
  const reasons: YcExclusionReason[] = [];

  const trainingGrant = rights.some((r) => r.allowedUse === "training_export" && r.state === "GRANTED");
  const privateConsented =
    source.governanceClass === "CUSTOMER_PRIVATE" && source.contentAllowed === true && trainingGrant;

  if (source.governanceClass === "CUSTOMER_PRIVATE" && !privateConsented) reasons.push("CUSTOMER_PRIVATE");
  if (isYlDerived(row) || hasYlMarker(source.key)) reasons.push("YL_DERIVED");
  if (source.trainingExportEligibility === "EXCLUDED") reasons.push("SOURCE_MARKED_EXCLUDED");
  if (source.governanceClass === "EXTERNAL" && !trainingGrant) reasons.push("NO_EXTERNAL_RIGHTS");

  if (reasons.length > 0) {
    const primary = reasons[0]!;
    return {
      eligibility: "EXCLUDED",
      reasons,
      primaryReason: primary,
      note: YC_EXCLUSION_TEXT[primary],
    };
  }

  const evidenceKind = lower(row?.evidenceKind);
  const engine = lower(row?.engine);
  const human = evidenceKind === "human" || engine === "human" || row?.consented === true;
  if (human || trainingGrant) {
    return {
      eligibility: "ALLOWED",
      reasons: [],
      primaryReason: null,
      note: human
        ? "A human produced or confirmed this row."
        : "The owner has recorded a GRANTED training_export right for this source.",
    };
  }

  return {
    eligibility: "RESTRICTED",
    reasons: ["NOT_HUMAN_OR_CONSENTED"],
    primaryReason: "NOT_HUMAN_OR_CONSENTED",
    note: YC_EXCLUSION_TEXT.NOT_HUMAN_OR_CONSENTED,
  };
}

export interface YcExportCandidate<T = unknown> {
  row: T;
  source: YcSourceLike;
  provenance?: YcRowProvenance | null;
  rights?: YcRightsLike[] | null;
}

/** The export filter. ONLY `ALLOWED` leaves. RESTRICTED is kept, never exported. */
export function filterExportable<T>(rows: YcExportCandidate<T>[]): T[] {
  const out: T[] = [];
  for (const c of rows) {
    const verdict = trainingEligibilityOf(c.source, { rights: c.rights, row: c.provenance ?? null });
    if (verdict.eligibility === "ALLOWED") out.push(c.row);
  }
  return out;
}

export interface YcExclusionBreakdown {
  total: number;
  exportable: number;
  excluded: number;
  /** One entry per reason that actually fired; each row counted exactly once. */
  byReason: { reason: YcExclusionReason; count: number; note: string }[];
}

/**
 * The honest count behind the export-preview screen. A row excluded for three
 * reasons is counted ONCE, under its primary (ladder-first) reason — so the
 * numbers add up to the total and nobody can read a bigger corpus into them.
 */
export function exclusionBreakdown<T>(rows: YcExportCandidate<T>[]): YcExclusionBreakdown {
  const counts = new Map<YcExclusionReason, number>();
  let exportable = 0;
  for (const c of rows) {
    const verdict = trainingEligibilityOf(c.source, { rights: c.rights, row: c.provenance ?? null });
    if (verdict.eligibility === "ALLOWED") {
      exportable += 1;
      continue;
    }
    const reason = verdict.primaryReason ?? "NOT_HUMAN_OR_CONSENTED";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const byReason = [...counts.entries()].map(([reason, count]) => ({
    reason,
    count,
    note: YC_EXCLUSION_TEXT[reason],
  }));
  byReason.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { total: rows.length, exportable, excluded: rows.length - exportable, byReason };
}

/**
 * The badge every governance-touching API response carries, so no screen can
 * present a walled or serving-only row as usable.
 */
export function governanceBadge(
  source: YcSourceLike,
  row?: YcRowProvenance | null,
  rights?: YcRightsLike[] | null,
): YcGovernanceBadge {
  const verdict = trainingEligibilityOf(source, { rights: rights ?? null, row: row ?? null });
  const ylDerived = isYlDerived(row ?? null) || hasYlMarker(source.key);
  const contentAllowed = canReadContent(source);
  const notes: string[] = [];
  if (!contentAllowed) notes.push(YC_CUSTOMER_WALL_MESSAGE);
  if (ylDerived) notes.push(YC_YL_SERVING_ONLY_MESSAGE);
  if (!notes.length && verdict.eligibility !== "ALLOWED") notes.push(verdict.note);
  return {
    governanceClass: (source.governanceClass as YcGovernanceClass) ?? "PLATFORM",
    trainingExportEligibility: verdict.eligibility,
    contentAllowed,
    ylDerived,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
