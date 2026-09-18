/**
 * Loopcom Yiddish Corpus + Learning Engine — the shared contract.
 *
 * Every module in this folder, the portal pages and the tests are written
 * against THIS file. Route paths and payload shapes live here so the backend
 * and the UI can be built against one agreed surface.
 *
 * ⛔ GOVERNANCE IS THE SPINE OF THIS SYSTEM. Three rules are enforced in code,
 * not by convention, and each one has a guard test:
 *
 *  1. Yiddish Labs output is SERVING ONLY. It can inform spelling and meaning.
 *     It never enters a training export. (docs/ai-support-agent/YL_NO_TRAINING_POLICY.md)
 *  2. Customer voicemails, calls and chats are CUSTOMER_PRIVATE. The engine may
 *     count them. Their content never enters the corpus until the owner records
 *     a basis. Default: counted, never read.
 *  3. External audio is only fetched when the owner has recorded a rights grant
 *     AND set the source to OWNER_AUTHORIZED. No exceptions, no header forging.
 */

export const YC_API_PREFIX = "/admin/yiddish";

/**
 * Why a music item is excluded. ⛔ Also the exact marker the worker checks
 * (item.state SKIPPED + this error), so the wording must not drift.
 */
export const YC_MUSIC_EXCLUDED_MESSAGE =
  "Music, not speech. The engine only learns from people talking, so this episode is excluded before any stage runs.";

/** Governance class of a source. Inherited by everything beneath it. */
export type YcGovernanceClass = "PLATFORM" | "CUSTOMER_PRIVATE" | "EXTERNAL";

/** Whether rows from a source may ever leave in a training export. */
export type YcTrainingEligibility = "UNKNOWN" | "ALLOWED" | "RESTRICTED" | "EXCLUDED";

/** Audio-byte fetching. DISABLED is the default and refuses at the client. */
export type YcAudioFetchMode = "DISABLED" | "OWNER_AUTHORIZED";

/** What a rights record can grant. */
export type YcAllowedUse = "metadata_only" | "analysis" | "store_audio" | "training_export";

export type YcRightsState = "GRANTED" | "DENIED" | "UNKNOWN";

/** Item lifecycle. Mirrors the states shown on the queue screen. */
export type YcItemState =
  | "DISCOVERED"
  | "QUEUED"
  | "PROCESSING"
  | "AUDIO_ANALYZED"
  | "NEEDS_TRANSCRIPTION"
  | "TRANSCRIBED"
  | "ALIGNED"
  | "INDEXED"
  | "LEARNED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "SKIPPED"
  | "DUPLICATE";

/** How much of the pipeline may run. Budgets and rights narrow this further. */
export type YcRunMode = "METADATA_ONLY" | "AUDIO_ONLY" | "SELECTIVE" | "FULL";

/** Job stages, in pipeline order. */
export const YC_STAGES = [
  "discover",
  "fingerprint",
  "fetch_audio",
  "segment",
  "features",
  "cluster",
  "novelty",
  "transcribe",
  "align",
  "observe",
  "aggregate",
] as const;
export type YcStage = (typeof YC_STAGES)[number];

/** Stages that need audio bytes. Every one of these is gated by rights. */
export const YC_AUDIO_STAGES: YcStage[] = [
  "fetch_audio",
  "segment",
  "features",
  "cluster",
  "transcribe",
  "align",
];

export type YcEvidenceKind = "ACOUSTIC_ALIGNED" | "HUMAN" | "TTS_CORRECTION" | "LEXICAL_ONLY";

export type YcRuleStatus = "CANDIDATE" | "TESTING" | "APPROVED" | "PRODUCTION" | "RETIRED";

/** Lexeme origin — decides weighting and which review lane it lands in. */
export type YcLexemeOrigin =
  | "YI"
  | "HE"
  | "EN"
  | "NAME"
  | "PLACE"
  | "BUSINESS"
  | "TECH"
  | "PHONE"
  | "ACRONYM"
  | "NUMBER";

/**
 * Per-source evidence weights. Independence is what matters, not raw counts:
 * repeats from one speaker saturate at SPEAKER_SATURATION times the speaker
 * count, so one person's habit can never become "the accent".
 */
export const YC_SOURCE_WEIGHTS: Record<string, number> = {
  internal: 1,
  voicelab: 1,
  human: 5,
  yiddish24: 0.8,
  yiddishlabs: 0, // lexical identity only — never pronunciation evidence
};
export const YC_SPEAKER_SATURATION = 3;

/** A rule needs this score AND (for high-impact lexemes) a human approval. */
export const YC_RULE_SCORE_THRESHOLD = 0.7;
/** Origins that always require a named human approver, whatever the score. */
export const YC_HUMAN_REQUIRED_ORIGINS: YcLexemeOrigin[] = ["NAME", "BUSINESS", "PLACE"];
/** Below this many observations, analytics refuse to call a winner. */
export const YC_MIN_SAMPLES_FOR_CONCLUSION = 20;

export interface YcEvidenceSupport {
  /** observation count */
  obs: number;
  /** distinct speaker clusters */
  speakers: number;
  /** distinct source keys */
  sources: number;
}

export interface YcVariantScore {
  variantKey: string;
  realization: string | null;
  score: number;
  share: number;
  support: YcEvidenceSupport;
  effective: number;
  humanConfirmed: boolean;
  eligibleForRule: boolean;
  blockedReason: string | null;
}

/** Every API response that touches governance carries this, so the UI can
 *  never present a walled or serving-only row as usable. */
export interface YcGovernanceBadge {
  governanceClass: YcGovernanceClass;
  trainingExportEligibility: YcTrainingEligibility;
  contentAllowed: boolean;
  ylDerived: boolean;
  note?: string;
}

export interface YcSourceSummary {
  key: string;
  name: string;
  kind: string;
  adapterKey: string | null;
  governanceClass: YcGovernanceClass;
  trainingExportEligibility: YcTrainingEligibility;
  contentAllowed: boolean;
  audioFetchMode: YcAudioFetchMode;
  enabled: boolean;
  termsUrl: string | null;
  termsCheckedAt: string | null;
  rightsNote: string | null;
  itemCount: number;
  /** Audio we hold and have processed. 0 while the audio gate is shut. */
  audioHours: number;
  /** Duration the SOURCE published about files we may never have opened. */
  catalogDurationHours: number;
  transcriptCount: number;
  lastRunAt: string | null;
  budget: YcBudgetView | null;
  rights: { allowedUse: YcAllowedUse; state: YcRightsState; decidedBy: string | null; decidedAt: string }[];
  health: { probeKey: string; state: string; detail: string | null; checkedAt: string }[];
  /** Plain-English reason the audio stages cannot run, or null when they can. */
  audioBlockedReason: string | null;
}

export interface YcBudgetView {
  scope: string;
  apiCentsPerDay: number;
  transcriptionMinutesPerDay: number;
  storageBytesMax: string;
  concurrency: number;
  requestsPerMinute: number;
  mode: YcRunMode;
  paused: boolean;
  spentCentsToday: number;
  transcribedMinutesToday: number;
}

export interface YcDashboardView {
  corpus: {
    items: number;
    /** Audio actually held and processed. */
    audioHours: number;
    /** Published durations from catalogued items, not audio we hold. */
    catalogDurationHours: number;
    transcripts: number;
    translations: number;
    pairs: number;
    lexemes: number;
    observations: number;
    rules: number;
    openConflicts: number;
    speakerClusters: number;
    benchmarkCases: number;
    findings: number;
  };
  walled: { label: string; count: number; hours: number | null; note: string }[];
  sources: YcSourceSummary[];
  queue: { state: string; count: number }[];
  worker: { alive: boolean; lastTickAt: string | null; leasedJobs: number; note: string };
  profile: { key: string; version: number; status: string; meanRating: number | null; n: number } | null;
  series: { day: string; metric: string; value: number }[];
  recentFindings: { id: string; kind: string; statement: string; status: string; createdAt: string }[];
}

/**
 * ROUTES — all under YC_API_PREFIX, all SUPER_ADMIN only.
 *
 *  GET    /dashboard                      → YcDashboardView
 *  GET    /sources                        → YcSourceSummary[]
 *  POST   /sources/:key/enable            { enabled }
 *  POST   /sources/:key/rights            { allowedUse, state, evidence }  (human only)
 *  POST   /sources/:key/audio-mode        { mode, acknowledgement }        (human only)
 *  POST   /sources/:key/budget            partial YcBudgetView
 *  POST   /sources/:key/discover          → { discovered, duplicates, healthy }
 *  POST   /sources/:key/run               { action: start|pause|resume|stop }
 *  GET    /sources/:key/items             ?state&category&series&q&limit&cursor
 *  GET    /items/:id                      → item + assets + segments + transcripts
 *  GET    /corpus/search                  ?q&governance&tier&hasAudio&provider
 *  GET    /lexemes                        ?q&origin&minFrequency&limit
 *  GET    /lexemes/:id                    → lexeme + variants + observations + rules
 *  POST   /lexemes/:id/rules              { variantKey, realization, ipa, method } (creates CANDIDATE)
 *  POST   /rules/:id/status               { status, approvedBy }
 *  GET    /review                         ?state&limit
 *  POST   /review/:id/decide              { decision, realization?, note? }
 *  POST   /gold/sample                    { count?, sourceKeys?, minSec?, maxSec? } (creates gold review items)
 *  GET    /gold                           ?state&limit → gold review queue, walled per row
 *  POST   /gold/:reviewId/decide          { decision: correct|accept|reject|skip, text? }
 *  PUT    /gold/clips/:reviewId           raw audio/wav ≤3MB (the clip to review)
 *  GET    /gold/clips/:reviewId           → the clip, Range-aware (?token= accepted)
 *  GET    /gold/stats                     → open/decided counts, gold hours, latest fine-tune report
 *  POST   /finetune/report                Lane B's report.json, stored for /gold/stats to read back
 *  GET    /findings                       ?status
 *  POST   /findings/:id/status            { status }
 *  GET    /queue                          → job counts + recent failures
 *  POST   /queue/retry                    { jobId? | stage? }
 *  GET    /progress                       ?window=1h|24h|7d|30d
 *  GET    /benchmark                      → cases, profiles, runs
 *  POST   /benchmark/cases                { text, category, tags, sourceRef }
 *  POST   /benchmark/run                  { profileVersionId }
 *  POST   /benchmark/results/:id/rate     { rating, notes }
 *  GET    /export/preview                 → counts + exclusion breakdown (always honest)
 *  POST   /export/build                   → manifest file path + row count
 *  GET    /governance                     → walls, rights records, gaps
 *  POST   /internal/reindex               → re-count internal sources (counts only)
 *  GET    /pipeline                       → YcPipelineMonitorView (stages, corpus, per-source
 *                                            labelling coverage, budgets, spend, worker heartbeat,
 *                                            and the off-box processes table, in one payload)
 *  GET    /health                         → adapter probes + worker heartbeat
 */
export const YC_ROUTES = {
  dashboard: `${YC_API_PREFIX}/dashboard`,
  sources: `${YC_API_PREFIX}/sources`,
  corpusSearch: `${YC_API_PREFIX}/corpus/search`,
  lexemes: `${YC_API_PREFIX}/lexemes`,
  review: `${YC_API_PREFIX}/review`,
  findings: `${YC_API_PREFIX}/findings`,
  queue: `${YC_API_PREFIX}/queue`,
  progress: `${YC_API_PREFIX}/progress`,
  benchmark: `${YC_API_PREFIX}/benchmark`,
  exportPreview: `${YC_API_PREFIX}/export/preview`,
  governance: `${YC_API_PREFIX}/governance`,
  pipeline: `${YC_API_PREFIX}/pipeline`,
  health: `${YC_API_PREFIX}/health`,
} as const;

/** The one source key the Yiddish24 adapter registers under. */
export const YIDDISH24_SOURCE_KEY = "yiddish24";

/** Internal source keys. All CUSTOMER_PRIVATE except the two marked. */
export const YC_INTERNAL_SOURCES = [
  { key: "voicemail", name: "Voicemail transcripts", governanceClass: "CUSTOMER_PRIVATE" },
  { key: "call_recordings", name: "Call recordings", governanceClass: "CUSTOMER_PRIVATE" },
  { key: "supermarket_drafts", name: "Supermarket order drafts", governanceClass: "CUSTOMER_PRIVATE" },
  { key: "assistant_chat", name: "Assistant chat (Yiddish)", governanceClass: "CUSTOMER_PRIVATE" },
  { key: "connect_chat", name: "Connect chat messages", governanceClass: "CUSTOMER_PRIVATE" },
  { key: "yiddishlabs_cache", name: "Yiddish Labs translation cache", governanceClass: "PLATFORM" },
  { key: "voicelab", name: "Voice Lab generations", governanceClass: "PLATFORM" },
] as const;

/** Plain-English refusal used everywhere audio is blocked. */
export const YC_AUDIO_BLOCKED_MESSAGE =
  "Audio is not fetched from this source: the owner has not recorded a rights grant, " +
  "and the site's media server refuses requests that do not come from its own pages. " +
  "We do not work around that. Record a grant on the Governance screen to enable it.";

export const YC_CUSTOMER_WALL_MESSAGE =
  "Customer voicemails, calls and chats are counted, never read. Their content stays out " +
  "of the corpus, the review queue, benchmarks and every export until the owner records a basis.";

export const YC_YL_SERVING_ONLY_MESSAGE =
  "Yiddish Labs output is serving-only: it can inform spelling and meaning, and is excluded " +
  "from every training export.";

/**
 * `GET /pipeline` — the live monitor. The labelling loop, the training-clip
 * build and the fine-tune all run OFF this server (the owner's PC + Kaggle),
 * so `processes` is the ONLY window into them: each one writes its own row to
 * `YcPipelineState`, and this view hands those rows back exactly as stored.
 * Everything else here is on-box truth, assembled so the page needs one call.
 */
export interface YcPipelineMonitorView {
  checkedAt: string;
  /** One entry per `YC_STAGES` stage, zero-filled — a stage nothing has
   *  queued yet still appears, with an honest 0. */
  stages: { stage: YcStage; counts: Record<string, number>; total: number }[];
  // ⛔ FLAT keys, and these exact names: the Pipeline page is written against
  // this contract. Nesting these (audioAssets.stored, transcripts.total) or
  // renaming observations/rules silently renders blanks on the page.
  corpus: {
    itemsByState: { state: string; count: number }[];
    /** STORED audio assets held (not the catalog's published durations). */
    audioAssets: number;
    audioHours: number;
    transcripts: number;
    transcriptsTimed: number;
    segments: number;
    lexemes: number;
    observations: number;
    rules: number;
    findings: number;
  };
  sources: {
    key: string;
    governanceClass: YcGovernanceClass;
    contentAllowed: boolean;
    audioFetchMode: YcAudioFetchMode;
    trainingExportEligibility: YcTrainingEligibility;
    /** A GRANTED `training_export` rights record exists for this source. */
    trainingExportGranted: boolean;
    itemCount: number;
    /** A STORED audio asset with no transcript at all — what the labelling
     *  loop is meant to close. */
    unlabelledCount: number;
  }[];
  budgets: YcBudgetView[];
  spend: {
    today: { minutes: number; cents: number };
    allTime: { minutes: number; cents: number };
  };
  worker: { alive: boolean; lastSeenAt: string | null };
  /** The off-box half: every `YcPipelineState` row, newest first, exactly as
   *  its own process wrote it. */
  processes: {
    id: string;
    key: string;
    kind: string;
    status: string;
    headline: string | null;
    progress: unknown;
    detail: unknown;
    startedAt: string | Date | null;
    createdAt: string | Date;
    updatedAt: string | Date;
  }[];
  /** The 40 most recently updated jobs, so the page can show what it just did. */
  recent: { stage: string; state: string; sourceKey: string; error: string | null; updatedAt: string | null }[];
}
