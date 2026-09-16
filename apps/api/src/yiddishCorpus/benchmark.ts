/**
 * Yiddish Corpus — the permanent regression suite and Baseline v1.
 *
 * The point of this file is that a voice change can be MEASURED instead of
 * argued about: the same fixed phrases are re-spoken on every configuration
 * change, humans rate them, and two runs are compared.
 *
 * ⛔ FOUR RULES THIS FILE ENFORCES IN CODE:
 *
 *  1. **We never write Yiddish ourselves.** Every benchmark case's text comes
 *     verbatim from a row that already exists — today the Yiddish Labs
 *     translation cache (`AgentTranslation`). No case text is authored here,
 *     and `sourceRef` points at the row it came from.
 *  2. **No customer text, ever.** Voicemail, call, chat and supermarket rows
 *     are CUSTOMER_PRIVATE; `seedBenchmarkCases` does not read them.
 *  3. **Yiddish Labs text is SERVING_ONLY.** Every case is stamped
 *     `trainingUse: "SERVING_ONLY"`, so a benchmark case can never be
 *     mistaken for training material.
 *  4. **There is no "accuracy" number.** There is no ground truth for how a
 *     word should sound, so `compareRuns` reports human rating deltas with
 *     their sample counts and REFUSES to call a regression below
 *     YC_MIN_SAMPLES_FOR_CONCLUSION on either side.
 */

import { YC_MIN_SAMPLES_FOR_CONCLUSION } from "./contracts";

export const YC_BASELINE_PROFILE_KEY = "yiddish_baseline";
export const YC_BASELINE_STATUS = "BASELINE";

/** Today's live configuration (the Voice Lab's first sent clips, 2026-09-15). */
export const YC_DEFAULT_BASELINE_CONFIG = {
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "cedar",
  responseFormat: "mp3",
  dictionaryVersion: 1,
} as const;

/**
 * Cost ESTIMATE per case, used only to respect the daily cap before spending.
 * It is deliberately pessimistic and is never reported as a real bill: the
 * run's `costCents` is an estimate and the UI labels it as one.
 * ~14 characters of speech per second; gpt-4o-mini-tts ≈ 1.5¢ per audio minute.
 */
export function estimateCaseCostCents(text: string): number {
  const seconds = Math.max(1, Math.ceil(String(text || "").length / 14));
  return Math.max(1, Math.ceil((seconds / 60) * 1.5));
}

// ── 1. Cases ────────────────────────────────────────────────────────────────

const HEBREW_SCRIPT = /[֐-׿]/;

/** Deterministic, content-derived category. Nothing invented, nothing random. */
export function categorizeCaseText(text: string): string {
  const t = String(text || "").trim();
  if (/[0-9٠-٩]/.test(t)) return "numbers";
  if (/[?？]/.test(t)) return "question";
  if (t.length <= 24) return "short_phrase";
  if (t.length <= 120) return "sentence";
  return "paragraph";
}

export interface SeedCasesOptions {
  /** Hard ceiling so one seed run cannot create thousands of cases. */
  limit?: number;
}

export interface SeedCasesResult {
  scanned: number;
  created: number;
  skippedExisting: number;
  skippedUnusable: number;
}

/**
 * Seeds the regression suite from SAFE text only: the Yiddish Labs cached
 * translations. Idempotent — a row already represented by `sourceRef` is
 * never duplicated.
 */
export async function seedBenchmarkCases(db: any, options: SeedCasesOptions = {}): Promise<SeedCasesResult> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 120));
  const result: SeedCasesResult = { scanned: 0, created: 0, skippedExisting: 0, skippedUnusable: 0 };

  // Pinned rows first: those are the pre-warmed UI/template strings, the most
  // representative of what the product actually says out loud.
  const rows: any[] = await db.agentTranslation.findMany({
    where: { action: "translate-yiddish" },
    orderBy: [{ pinned: "desc" }, { hits: "desc" }, { createdAt: "asc" }],
    take: limit,
  });

  for (const row of rows ?? []) {
    result.scanned += 1;
    const text = String(row?.outText ?? "").trim();
    // The cached OUTPUT of translate-yiddish is the Yiddish. If it is not in
    // Hebrew script, the row is not what we think it is — skip it rather than
    // guess.
    if (!text || text.length < 2 || text.length > 600 || !HEBREW_SCRIPT.test(text)) {
      result.skippedUnusable += 1;
      continue;
    }
    const sourceRef = `AgentTranslation:${row.id}`;
    const existing = await db.ycBenchmarkCase.findFirst({ where: { sourceRef } });
    if (existing) {
      result.skippedExisting += 1;
      continue;
    }
    await db.ycBenchmarkCase.create({
      data: {
        text,
        sourceRef,
        category: categorizeCaseText(text),
        tags: ["yiddishlabs", "serving_only"],
        active: true,
        // ⛔ Yiddish Labs text never trains anything.
        trainingUse: "SERVING_ONLY",
      },
    });
    result.created += 1;
  }

  return result;
}

// ── 2. Baseline v1 ──────────────────────────────────────────────────────────

export interface FreezeBaselineConfig {
  profileKey?: string;
  provider?: string;
  model?: string;
  voice?: string;
  instructions?: string | null;
  speed?: number | null;
  responseFormat?: string;
  dictionaryVersion?: number;
  approvedBy?: string | null;
}

export class BaselineAlreadyExistsError extends Error {
  readonly code = "baseline_already_exists";
  readonly existingId: string;
  constructor(existingId: string) {
    super(
      "Baseline v1 already exists. A baseline is frozen once, on purpose: every later run is " +
        "compared against it, so replacing it would silently redefine what \"no change\" means. " +
        "Create a CANDIDATE profile version instead.",
    );
    this.existingId = existingId;
  }
}

/**
 * Freezes today's live configuration as Baseline v1.
 * ⛔ Refuses to create a second BASELINE — that is the whole guarantee.
 */
export async function freezeBaseline(db: any, cfg: FreezeBaselineConfig = {}): Promise<any> {
  const existing = await db.ycVoiceProfileVersion.findFirst({ where: { status: YC_BASELINE_STATUS } });
  if (existing) throw new BaselineAlreadyExistsError(String(existing.id));

  return db.ycVoiceProfileVersion.create({
    data: {
      profileKey: cfg.profileKey ?? YC_BASELINE_PROFILE_KEY,
      version: 1,
      status: YC_BASELINE_STATUS,
      provider: cfg.provider ?? YC_DEFAULT_BASELINE_CONFIG.provider,
      model: cfg.model ?? YC_DEFAULT_BASELINE_CONFIG.model,
      voice: cfg.voice ?? YC_DEFAULT_BASELINE_CONFIG.voice,
      instructions: cfg.instructions ?? null,
      speed: cfg.speed ?? null,
      responseFormat: cfg.responseFormat ?? YC_DEFAULT_BASELINE_CONFIG.responseFormat,
      dictionaryVersion: cfg.dictionaryVersion ?? YC_DEFAULT_BASELINE_CONFIG.dictionaryVersion,
      internalMeta: { frozenFrom: "live configuration", frozenAt: new Date().toISOString() },
      approvedBy: cfg.approvedBy ?? null,
      approvedAt: cfg.approvedBy ? new Date() : null,
    },
  });
}

// ── 3. Running a benchmark ──────────────────────────────────────────────────

export interface SpeakArgs {
  text: string;
  model: string;
  voice: string;
  instructions: string | null;
  speed: number | null;
  responseFormat: string;
  apiKey: string;
}
export interface SpeakResult {
  bytes: number;
  audio: Buffer | Uint8Array | null;
  latencyMs: number;
}

export interface RunBenchmarkDeps {
  /** Injected so tests (and a dry run) never touch the network. */
  speak?: (args: SpeakArgs) => Promise<SpeakResult>;
  /** Returns the stored key/path for the audio, or null when not stored. */
  storeAudio?: (args: { runId: string; caseId: string; audio: Buffer | Uint8Array | null; format: string }) => Promise<string | null>;
  resolveApiKey?: (db: any) => Promise<string | null>;
  /** Budget scope to charge. Defaults to the global budget. */
  budgetScope?: string;
  /** Resume an existing run instead of creating one. */
  runId?: string;
  now?: () => Date;
  log?: { warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

export interface RunBenchmarkResult {
  runId: string;
  caseCount: number;
  generated: number;
  /** Already had a result in this run — resumability, not a failure. */
  skippedExisting: number;
  failed: number;
  estimatedCostCents: number;
  /** null = the whole suite ran. Otherwise the honest reason it stopped. */
  stoppedReason: string | null;
  note: string;
}

const DEFAULT_BUDGET_SCOPE = "global";

async function defaultSpeak(args: SpeakArgs): Promise<SpeakResult> {
  const startedAt = Date.now();
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: args.apiKey });
  const res = await client.audio.speech.create({
    model: args.model,
    voice: args.voice as any,
    input: args.text,
    ...(args.instructions ? { instructions: args.instructions } : {}),
    ...(args.speed ? { speed: args.speed } : {}),
    response_format: args.responseFormat as any,
  } as any);
  const audio = Buffer.from(await res.arrayBuffer());
  return { bytes: audio.byteLength, audio, latencyMs: Date.now() - startedAt };
}

async function defaultResolveApiKey(db: any): Promise<string | null> {
  // Same door the rest of the platform uses: the real key lives encrypted in
  // AgentSecret; the container's OPENAI_API_KEY is a placeholder.
  const mod = await import("../support/customerUpdate");
  return mod.resolveOpenAiKey(db);
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Generates audio for every active case through the profile version's
 * configuration, stores the result, and leaves the RATING to humans.
 *
 * ⛔ RESUMABLE BY CONSTRUCTION: a case that already has a YcBenchmarkResult in
 * this run is never re-generated (the DB's @@unique([runId, caseId]) is the
 * backstop). Re-calling after a crash, a deploy or a budget stop picks up
 * exactly where it left off and spends nothing on what is already done.
 * ⛔ BUDGET IS CHECKED BEFORE EVERY CASE, not once at the top: a paused budget
 * or an exhausted daily cap stops the run and says so.
 */
export async function runBenchmark(
  db: any,
  profileVersionId: string,
  deps: RunBenchmarkDeps = {},
): Promise<RunBenchmarkResult> {
  const now = deps.now ?? (() => new Date());
  const speak = deps.speak ?? defaultSpeak;
  const resolveApiKey = deps.resolveApiKey ?? defaultResolveApiKey;
  const budgetScope = deps.budgetScope ?? DEFAULT_BUDGET_SCOPE;

  const profile = await db.ycVoiceProfileVersion.findUnique({ where: { id: profileVersionId } });
  if (!profile) throw new Error("profile_version_not_found");

  const cases: any[] = await db.ycBenchmarkCase.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } });

  // Resume an existing unfinished run for this profile before creating one.
  let run = deps.runId
    ? await db.ycBenchmarkRun.findUnique({ where: { id: deps.runId } })
    : await db.ycBenchmarkRun.findFirst({
        where: { profileVersionId, state: { in: ["QUEUED", "RUNNING"] } },
        orderBy: { startedAt: "desc" },
      });
  if (!run) {
    run = await db.ycBenchmarkRun.create({
      data: { profileVersionId, state: "RUNNING", caseCount: cases.length },
    });
  } else if (run.state !== "RUNNING") {
    await db.ycBenchmarkRun.update({ where: { id: run.id }, data: { state: "RUNNING", caseCount: cases.length } });
  }
  const runId = String(run.id);

  const out: RunBenchmarkResult = {
    runId,
    caseCount: cases.length,
    generated: 0,
    skippedExisting: 0,
    failed: 0,
    estimatedCostCents: 0,
    stoppedReason: null,
    note: "",
  };

  if (cases.length === 0) {
    await db.ycBenchmarkRun.update({ where: { id: runId }, data: { state: "DONE", finishedAt: now() } });
    out.note = "There are no active benchmark cases yet, so nothing was generated.";
    return out;
  }

  let apiKey: string | null = null;

  for (const c of cases) {
    // ── resumability: never re-generate a case this run already has ────────
    const already = await db.ycBenchmarkResult.findFirst({ where: { runId, caseId: c.id } });
    if (already) {
      out.skippedExisting += 1;
      continue;
    }

    // ── budget, re-read before EVERY case ──────────────────────────────────
    const budget = await db.ycBudget.findUnique({ where: { scope: budgetScope } });
    if (!budget) {
      out.stoppedReason = "no_budget_row";
      out.note = `No budget row exists for scope "${budgetScope}", so nothing was spent.`;
      break;
    }
    if (budget.paused) {
      out.stoppedReason = "budget_paused";
      out.note = "The budget is paused, so the run stopped before spending anything further.";
      break;
    }
    const spentToday = todayKey(now()) === String(budget.spendDate ?? "") ? Number(budget.spentCentsToday ?? 0) : 0;
    const estimate = estimateCaseCostCents(c.text);
    if (Number(budget.apiCentsPerDay ?? 0) <= 0 || spentToday + estimate > Number(budget.apiCentsPerDay ?? 0)) {
      out.stoppedReason = "daily_cap_reached";
      out.note =
        `The daily spend cap for "${budgetScope}" (${Number(budget.apiCentsPerDay ?? 0)}¢) would be exceeded by the ` +
        `next case, so the run stopped. Re-run it to continue where it left off.`;
      break;
    }

    if (!apiKey) {
      apiKey = await resolveApiKey(db);
      if (!apiKey) {
        out.stoppedReason = "no_api_key";
        out.note = "No OpenAI key is configured, so no audio was generated.";
        break;
      }
    }

    try {
      const spoken = await speak({
        text: String(c.text),
        model: String(profile.model),
        voice: String(profile.voice),
        instructions: profile.instructions ?? null,
        speed: profile.speed ?? null,
        responseFormat: String(profile.responseFormat ?? "mp3"),
        apiKey,
      });
      const audioKey = deps.storeAudio
        ? await deps.storeAudio({ runId, caseId: String(c.id), audio: spoken.audio, format: String(profile.responseFormat ?? "mp3") })
        : null;
      await db.ycBenchmarkResult.create({
        data: {
          runId,
          caseId: String(c.id),
          audioKey,
          latencyMs: spoken.latencyMs,
          bytes: spoken.bytes,
          // rating / ratedBy stay null: a human rates it, never the engine.
        },
      });
      out.generated += 1;
      out.estimatedCostCents += estimate;
      await db.ycBudget.update({
        where: { scope: budgetScope },
        data: { spentCentsToday: spentToday + estimate, spendDate: todayKey(now()) },
      });
    } catch (e: any) {
      out.failed += 1;
      deps.log?.warn?.({ err: e, caseId: c.id, runId }, "yiddish benchmark case failed");
      await db.ycBenchmarkResult
        .create({ data: { runId, caseId: String(c.id), error: String(e?.message ?? e).slice(0, 500) } })
        .catch(() => undefined);
    }
  }

  const finished = out.stoppedReason === null;
  await db.ycBenchmarkRun.update({
    where: { id: runId },
    data: {
      state: finished ? "RATING" : "RUNNING",
      caseCount: cases.length,
      costCents: Number(run.costCents ?? 0) + out.estimatedCostCents,
      ...(finished ? { finishedAt: now() } : {}),
    },
  });

  if (!out.note) {
    out.note =
      out.generated > 0
        ? `${out.generated} clip(s) generated and waiting for human ratings. Nothing is rated automatically — there is no ground truth for how a word should sound.`
        : "Everything in this run was already generated; nothing was re-spent.";
  }
  return out;
}

// ── 4. Comparing two runs ───────────────────────────────────────────────────

export interface CategoryDelta {
  category: string;
  candidate: { n: number; mean: number | null };
  baseline: { n: number; mean: number | null };
  delta: number | null;
  /** "regression" | "improvement" | "no_change" | "insufficient_samples" */
  verdict: "regression" | "improvement" | "no_change" | "insufficient_samples";
  note: string;
}

export interface CompareRunsResult {
  runId: string;
  baselineRunId: string;
  minSamples: number;
  overall: { candidate: { n: number; mean: number | null }; baseline: { n: number; mean: number | null }; delta: number | null; verdict: CategoryDelta["verdict"] };
  categories: CategoryDelta[];
  note: string;
}

/** A rating delta smaller than this is noise, not a change. */
export const YC_RATING_MEANINGFUL_DELTA = 0.3;

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 1000) / 1000;
}

async function ratingsByCategory(db: any, runId: string): Promise<Map<string, number[]>> {
  const results: any[] = await db.ycBenchmarkResult.findMany({ where: { runId } });
  const byCategory = new Map<string, number[]>();
  for (const r of results ?? []) {
    if (r.rating === null || r.rating === undefined) continue;
    const c = await db.ycBenchmarkCase.findUnique({ where: { id: r.caseId } });
    const category = String(c?.category ?? "uncategorized");
    const list = byCategory.get(category) ?? [];
    list.push(Number(r.rating));
    byCategory.set(category, list);
  }
  return byCategory;
}

/**
 * Per-category human-rating deltas with their sample counts.
 *
 * ⛔ NEVER REPORTS AN "ACCURACY" NUMBER. There is no ground truth for
 * pronunciation, so the only honest signals are human ratings and how many of
 * them there are. A category is called a regression ONLY when BOTH sides have
 * at least YC_MIN_SAMPLES_FOR_CONCLUSION ratings — below that the verdict is
 * "insufficient_samples", never a winner.
 */
export async function compareRuns(db: any, runId: string, baselineRunId: string): Promise<CompareRunsResult> {
  const minSamples = YC_MIN_SAMPLES_FOR_CONCLUSION;
  const candidateByCat = await ratingsByCategory(db, runId);
  const baselineByCat = await ratingsByCategory(db, baselineRunId);

  const categories = [...new Set([...candidateByCat.keys(), ...baselineByCat.keys()])].sort();
  const rows: CategoryDelta[] = categories.map((category) => {
    const cand = candidateByCat.get(category) ?? [];
    const base = baselineByCat.get(category) ?? [];
    const candMean = meanOf(cand);
    const baseMean = meanOf(base);
    const enough = cand.length >= minSamples && base.length >= minSamples;
    const delta = candMean !== null && baseMean !== null ? Math.round((candMean - baseMean) * 1000) / 1000 : null;

    let verdict: CategoryDelta["verdict"] = "insufficient_samples";
    let note = `Not enough ratings to call anything: ${cand.length} vs ${base.length}, and ${minSamples} on each side is the floor.`;
    if (enough && delta !== null) {
      if (delta <= -YC_RATING_MEANINGFUL_DELTA) {
        verdict = "regression";
        note = `Rated ${Math.abs(delta)} lower than the baseline over ${cand.length} vs ${base.length} ratings.`;
      } else if (delta >= YC_RATING_MEANINGFUL_DELTA) {
        verdict = "improvement";
        note = `Rated ${delta} higher than the baseline over ${cand.length} vs ${base.length} ratings.`;
      } else {
        verdict = "no_change";
        note = `Within noise (${delta}) over ${cand.length} vs ${base.length} ratings.`;
      }
    }
    return { category, candidate: { n: cand.length, mean: candMean }, baseline: { n: base.length, mean: baseMean }, delta, verdict, note };
  });

  const allCand = [...candidateByCat.values()].flat();
  const allBase = [...baselineByCat.values()].flat();
  const candMean = meanOf(allCand);
  const baseMean = meanOf(allBase);
  const overallDelta = candMean !== null && baseMean !== null ? Math.round((candMean - baseMean) * 1000) / 1000 : null;
  let overallVerdict: CategoryDelta["verdict"] = "insufficient_samples";
  if (allCand.length >= minSamples && allBase.length >= minSamples && overallDelta !== null) {
    overallVerdict =
      overallDelta <= -YC_RATING_MEANINGFUL_DELTA ? "regression" : overallDelta >= YC_RATING_MEANINGFUL_DELTA ? "improvement" : "no_change";
  }

  return {
    runId,
    baselineRunId,
    minSamples,
    overall: { candidate: { n: allCand.length, mean: candMean }, baseline: { n: allBase.length, mean: baseMean }, delta: overallDelta, verdict: overallVerdict },
    categories: rows,
    note:
      "Human rating deltas only. There is no ground truth for how a word should sound, so no " +
      "accuracy figure is produced and no category is called below the sample floor.",
  };
}
