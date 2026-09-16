/**
 * Yiddish Corpus — benchmark tests.
 *
 * Driven against a small in-memory store, so no database and no OpenAI call
 * happens. The four behaviours that cost money or credibility if they break:
 *
 *  1. Baseline v1 is frozen ONCE. A second one is refused.
 *  2. A run is RESUMABLE: a case that already has a result in the run is never
 *     re-generated, so re-running after a crash spends nothing on it again.
 *  3. The budget stops the run — paused, or the daily cap — and the run says
 *     which, instead of quietly spending.
 *  4. compareRuns refuses to call a regression below the sample floor, and
 *     never reports an "accuracy".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BaselineAlreadyExistsError,
  categorizeCaseText,
  compareRuns,
  estimateCaseCostCents,
  freezeBaseline,
  runBenchmark,
  seedBenchmarkCases,
  YC_RATING_MEANINGFUL_DELTA,
} from "./benchmark";
import { YC_MIN_SAMPLES_FOR_CONCLUSION } from "./contracts";

// ── a tiny in-memory Prisma-shaped store ────────────────────────────────────

function store(initial: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    ycVoiceProfileVersion: [],
    ycBenchmarkCase: [],
    ycBenchmarkRun: [],
    ycBenchmarkResult: [],
    ycBudget: [],
    agentTranslation: [],
    ...initial,
  };
  let seq = 0;
  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === "object" && "in" in v) return (v as any).in.includes(row[k]);
      if (v && typeof v === "object" && "gte" in v) return row[k] >= (v as any).gte;
      return row[k] === v;
    });
  };
  const model = (name: string) => ({
    async findMany({ where }: any = {}) {
      return tables[name].filter((r) => matches(r, where));
    },
    async findFirst({ where }: any = {}) {
      return tables[name].find((r) => matches(r, where)) ?? null;
    },
    async findUnique({ where }: any = {}) {
      return tables[name].find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
    },
    async count({ where }: any = {}) {
      return tables[name].filter((r) => matches(r, where)).length;
    },
    async create({ data }: any) {
      const row = { id: `${name}_${++seq}`, createdAt: new Date(), ...data };
      tables[name].push(row);
      return row;
    },
    async update({ where, data }: any) {
      const row = tables[name].find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (!row) throw new Error(`${name} row not found`);
      Object.assign(row, data);
      return row;
    },
  });
  const db: any = new Proxy({}, { get: (_t, name: string) => model(String(name)) });
  return { db, tables };
}

const PROFILE = {
  id: "pv_1",
  profileKey: "yiddish_baseline",
  version: 1,
  status: "BASELINE",
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "cedar",
  instructions: null,
  speed: null,
  responseFormat: "mp3",
};

const budget = (over: Partial<Record<string, any>> = {}) => ({
  scope: "global",
  apiCentsPerDay: 10_000,
  paused: false,
  spentCentsToday: 0,
  spendDate: null,
  ...over,
});

// A Yiddish string is never authored here: this is a placeholder marker only,
// and the real cases always come from an existing row (see seedBenchmarkCases).
const caseRow = (id: string, text: string, category = "sentence") => ({ id, text, category, active: true, createdAt: new Date() });

// ── 1. Baseline ─────────────────────────────────────────────────────────────

test("freezeBaseline creates v1 from the live configuration", async () => {
  const { db, tables } = store();
  const row = await freezeBaseline(db, { approvedBy: "izzy@loopcom.net" });
  assert.equal(row.status, "BASELINE");
  assert.equal(row.version, 1);
  assert.equal(row.model, "gpt-4o-mini-tts");
  assert.equal(row.voice, "cedar");
  assert.equal(row.approvedBy, "izzy@loopcom.net");
  assert.equal(tables.ycVoiceProfileVersion.length, 1);
});

test("freezeBaseline REFUSES a second baseline — the yardstick is frozen once", async () => {
  const { db, tables } = store({ ycVoiceProfileVersion: [{ ...PROFILE }] });
  await assert.rejects(() => freezeBaseline(db), (e: any) => {
    assert.ok(e instanceof BaselineAlreadyExistsError);
    assert.equal(e.code, "baseline_already_exists");
    assert.equal(e.existingId, "pv_1");
    return true;
  });
  assert.equal(tables.ycVoiceProfileVersion.length, 1, "a second baseline row was written");
});

// ── 2. Running: resumable ───────────────────────────────────────────────────

test("runBenchmark is resumable: a case that already has a result is never re-generated", async () => {
  const { db, tables } = store({
    ycVoiceProfileVersion: [{ ...PROFILE }],
    ycBenchmarkCase: [caseRow("c1", "aaa"), caseRow("c2", "bbb"), caseRow("c3", "ccc")],
    ycBudget: [budget()],
  });
  const spokenFor: string[] = [];
  const speak = async (args: any) => {
    spokenFor.push(args.text);
    return { bytes: 100, audio: null, latencyMs: 12 };
  };

  const first = await runBenchmark(db, "pv_1", { speak, resolveApiKey: async () => "sk-test" });
  assert.equal(first.generated, 3);
  assert.equal(first.skippedExisting, 0);
  assert.equal(first.stoppedReason, null);
  assert.equal(tables.ycBenchmarkResult.length, 3);

  // Re-run the SAME run id: nothing is spoken again.
  spokenFor.length = 0;
  const second = await runBenchmark(db, "pv_1", { speak, resolveApiKey: async () => "sk-test", runId: first.runId });
  assert.equal(spokenFor.length, 0, "a completed case was re-generated — that is money spent twice");
  assert.equal(second.generated, 0);
  assert.equal(second.skippedExisting, 3);
  assert.equal(tables.ycBenchmarkResult.length, 3);
});

test("runBenchmark leaves every rating to a human", async () => {
  const { db, tables } = store({
    ycVoiceProfileVersion: [{ ...PROFILE }],
    ycBenchmarkCase: [caseRow("c1", "aaa")],
    ycBudget: [budget()],
  });
  await runBenchmark(db, "pv_1", { speak: async () => ({ bytes: 9, audio: null, latencyMs: 5 }), resolveApiKey: async () => "sk-test" });
  const r = tables.ycBenchmarkResult[0];
  assert.equal(r.rating, undefined, "the engine rated its own output");
  assert.equal(r.ratedBy, undefined);
  assert.equal(r.latencyMs, 5);
  assert.equal(r.bytes, 9);
});

// ── 3. Running: the budget stops it ─────────────────────────────────────────

test("a paused budget stops the run before anything is spent, and says so", async () => {
  const { db, tables } = store({
    ycVoiceProfileVersion: [{ ...PROFILE }],
    ycBenchmarkCase: [caseRow("c1", "aaa"), caseRow("c2", "bbb")],
    ycBudget: [budget({ paused: true })],
  });
  let calls = 0;
  const out = await runBenchmark(db, "pv_1", {
    speak: async () => {
      calls += 1;
      return { bytes: 1, audio: null, latencyMs: 1 };
    },
    resolveApiKey: async () => "sk-test",
  });
  assert.equal(calls, 0, "a paused budget still spent money");
  assert.equal(out.generated, 0);
  assert.equal(out.stoppedReason, "budget_paused");
  assert.ok(out.note.includes("paused"));
  assert.equal(tables.ycBenchmarkResult.length, 0);
});

test("the daily cap stops the run mid-way, and the rest resumes later", async () => {
  const cases = [caseRow("c1", "a".repeat(2000)), caseRow("c2", "b".repeat(2000)), caseRow("c3", "c".repeat(2000))];
  const perCase = estimateCaseCostCents(cases[0].text);
  const { db, tables } = store({
    ycVoiceProfileVersion: [{ ...PROFILE }],
    ycBenchmarkCase: cases,
    // Room for exactly one case.
    ycBudget: [budget({ apiCentsPerDay: perCase })],
  });
  const out = await runBenchmark(db, "pv_1", { speak: async () => ({ bytes: 1, audio: null, latencyMs: 1 }), resolveApiKey: async () => "sk-test" });
  assert.equal(out.generated, 1, `expected exactly one case to fit the cap, got ${out.generated}`);
  assert.equal(out.stoppedReason, "daily_cap_reached");
  assert.ok(out.note.includes("cap"));
  assert.equal(tables.ycBenchmarkResult.length, 1);

  // Raising the cap and re-running resumes: the done case is not redone.
  tables.ycBudget[0].apiCentsPerDay = perCase * 10;
  const again = await runBenchmark(db, "pv_1", { speak: async () => ({ bytes: 1, audio: null, latencyMs: 1 }), resolveApiKey: async () => "sk-test", runId: out.runId });
  assert.equal(again.skippedExisting, 1);
  assert.equal(again.generated, 2);
  assert.equal(tables.ycBenchmarkResult.length, 3);
});

test("no API key means no audio and an honest reason, not a crash", async () => {
  const { db } = store({
    ycVoiceProfileVersion: [{ ...PROFILE }],
    ycBenchmarkCase: [caseRow("c1", "aaa")],
    ycBudget: [budget()],
  });
  const out = await runBenchmark(db, "pv_1", { speak: async () => ({ bytes: 1, audio: null, latencyMs: 1 }), resolveApiKey: async () => null });
  assert.equal(out.stoppedReason, "no_api_key");
  assert.equal(out.generated, 0);
});

test("an empty suite reports zero honestly instead of claiming a run", async () => {
  const { db } = store({ ycVoiceProfileVersion: [{ ...PROFILE }], ycBudget: [budget()] });
  const out = await runBenchmark(db, "pv_1", { speak: async () => ({ bytes: 1, audio: null, latencyMs: 1 }), resolveApiKey: async () => "sk-test" });
  assert.equal(out.caseCount, 0);
  assert.equal(out.generated, 0);
  assert.ok(out.note.includes("no active benchmark cases"));
});

// ── 4. Comparing ────────────────────────────────────────────────────────────

function ratedResults(runId: string, caseIdPrefix: string, ratings: number[]) {
  return ratings.map((rating, i) => ({ id: `${runId}_${i}`, runId, caseId: `${caseIdPrefix}${i}`, rating }));
}

test("compareRuns REFUSES to call a regression below the sample floor", async () => {
  const n = YC_MIN_SAMPLES_FOR_CONCLUSION - 1;
  const cases = Array.from({ length: n }, (_v, i) => ({ id: `k${i}`, category: "sentence" }));
  const { db } = store({
    ycBenchmarkCase: cases,
    ycBenchmarkResult: [
      ...ratedResults("run_new", "k", Array.from({ length: n }, () => 1)),
      ...ratedResults("run_base", "k", Array.from({ length: n }, () => 5)),
    ],
  });
  const out = await compareRuns(db, "run_new", "run_base");
  assert.equal(out.minSamples, YC_MIN_SAMPLES_FOR_CONCLUSION);
  assert.equal(out.overall.verdict, "insufficient_samples", "a 4-point gap was called a regression on too few ratings");
  assert.equal(out.categories[0].verdict, "insufficient_samples");
  assert.ok(out.categories[0].note.includes(String(YC_MIN_SAMPLES_FOR_CONCLUSION)));
  // The delta is still SHOWN — it is the verdict that is withheld.
  assert.equal(out.overall.delta, -4);
});

test("compareRuns calls a regression once both sides clear the floor", async () => {
  const n = YC_MIN_SAMPLES_FOR_CONCLUSION;
  const cases = Array.from({ length: n }, (_v, i) => ({ id: `k${i}`, category: "sentence" }));
  const { db } = store({
    ycBenchmarkCase: cases,
    ycBenchmarkResult: [
      ...ratedResults("run_new", "k", Array.from({ length: n }, () => 2)),
      ...ratedResults("run_base", "k", Array.from({ length: n }, () => 4)),
    ],
  });
  const out = await compareRuns(db, "run_new", "run_base");
  assert.equal(out.overall.verdict, "regression");
  assert.equal(out.categories[0].candidate.n, n);
  assert.equal(out.categories[0].baseline.n, n);
});

test("a delta inside the noise band is no change, not an improvement", async () => {
  const n = YC_MIN_SAMPLES_FOR_CONCLUSION;
  const cases = Array.from({ length: n }, (_v, i) => ({ id: `k${i}`, category: "sentence" }));
  const nudge = YC_RATING_MEANINGFUL_DELTA / 2;
  const { db } = store({
    ycBenchmarkCase: cases,
    ycBenchmarkResult: [
      ...ratedResults("run_new", "k", Array.from({ length: n }, () => 3 + nudge)),
      ...ratedResults("run_base", "k", Array.from({ length: n }, () => 3)),
    ],
  });
  const out = await compareRuns(db, "run_new", "run_base");
  assert.equal(out.overall.verdict, "no_change");
});

test("compareRuns never reports an accuracy", async () => {
  const { db } = store({ ycBenchmarkCase: [], ycBenchmarkResult: [] });
  const out = await compareRuns(db, "a", "b");
  const flat = JSON.stringify(out).toLowerCase();
  assert.ok(!flat.includes("\"accuracy\""), "an accuracy field appeared; there is no ground truth for pronunciation");
  assert.ok(out.note.includes("no accuracy figure"));
});

// ── 5. Seeding cases from safe text only ────────────────────────────────────

test("seedBenchmarkCases takes Yiddish Labs cache rows only, stamps SERVING_ONLY, and is idempotent", async () => {
  const yiddishFromCache = "א גוטן מארגן"; // verbatim-shaped cache output (Hebrew script)
  const { db, tables } = store({
    agentTranslation: [
      { id: "t1", action: "translate-yiddish", outText: yiddishFromCache, pinned: true, hits: 9 },
      { id: "t2", action: "translate-yiddish", outText: "plain english output", pinned: false, hits: 1 },
      { id: "t3", action: "translate-yiddish", outText: "", pinned: false, hits: 0 },
    ],
  });
  const first = await seedBenchmarkCases(db);
  assert.equal(first.created, 1, "only the Hebrew-script row is usable");
  assert.equal(first.skippedUnusable, 2);
  const row = tables.ycBenchmarkCase[0];
  assert.equal(row.trainingUse, "SERVING_ONLY");
  assert.equal(row.sourceRef, "AgentTranslation:t1");
  assert.ok(row.tags.includes("yiddishlabs"));

  const second = await seedBenchmarkCases(db);
  assert.equal(second.created, 0, "the seed duplicated a case");
  assert.equal(second.skippedExisting, 1);
  assert.equal(tables.ycBenchmarkCase.length, 1);
});

test("seedBenchmarkCases never reads a customer table", async () => {
  const touched: string[] = [];
  const base = store({ agentTranslation: [] });
  const guarded: any = new Proxy(
    {},
    {
      get(_t, name: string) {
        touched.push(String(name));
        return (base.db as any)[String(name)];
      },
    },
  );
  await seedBenchmarkCases(guarded);
  for (const t of touched) {
    assert.ok(
      !/voicemail|connectCdr|connectChat|supermarket|agentMessage|agentConversation/i.test(t),
      `the seed read ${t}, which is customer-private`,
    );
  }
});

test("the case category is derived from the text, deterministically", () => {
  assert.equal(categorizeCaseText("845-555-1212"), "numbers");
  assert.equal(categorizeCaseText("short one?"), "question");
  assert.equal(categorizeCaseText("short one"), "short_phrase");
  assert.equal(categorizeCaseText("x".repeat(60)), "sentence");
  assert.equal(categorizeCaseText("x".repeat(400)), "paragraph");
  assert.equal(categorizeCaseText("x".repeat(60)), categorizeCaseText("x".repeat(60)));
});

test("the cost estimate is at least a cent and grows with the text", () => {
  assert.ok(estimateCaseCostCents("hi") >= 1);
  assert.ok(estimateCaseCostCents("x".repeat(10_000)) > estimateCaseCostCents("x".repeat(100)));
});
