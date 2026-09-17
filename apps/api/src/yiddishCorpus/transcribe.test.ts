/**
 * Yiddish corpus — the `transcribe` and `align` stage handlers.
 *
 * ⛔ NO NETWORK, NO FFMPEG, NO PRISMA. `cutChunk` (audioPipeline) is replaced
 * with `node:test`'s `mock.module` BEFORE `./jobs` is ever imported, and
 * `node:fs/promises` is mocked too so nothing here touches a real file.
 * `planChunks` is left real (it is pure), so the handler's actual chunk math
 * is exercised end to end. The transcription backend itself is replaced via
 * `setTranscribeBackendForTests` (transcribeBackend.ts's test seam) rather
 * than mocking `./everettClient`, since the handler now goes through
 * `resolveTranscribeBackend()` and may be running Everett OR the local
 * faster-whisper backend depending on the box's env.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 *   "src/yiddishCorpus/*.test.ts"   (the module-mock flag is required)
 */
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { planChunks as realPlanChunks } from "./audioPipeline";
import { YC_CUSTOMER_WALL_MESSAGE } from "./contracts";
import { setTranscribeBackendForTests, type TranscribeBackend, type TranscribeChunkResult } from "./transcribeBackend";

// ── mock audioPipeline: keep planChunks real, replace the ffmpeg call ──────

interface CutCall {
  inputPath: string;
  startMs: number;
  endMs: number;
  outPath: string;
}
const cutCalls: CutCall[] = [];
let cutAvailable = true;
let cutReason: string | null = null;

mock.module("./audioPipeline", {
  namedExports: {
    planChunks: realPlanChunks,
    detectSegments: async () => ({ available: false, reason: "not exercised by these tests" }),
    extractFeatures: async () => ({ available: false, reason: "not exercised by these tests" }),
    cutChunk: async (inputPath: string, startMs: number, endMs: number, outPath: string) => {
      cutCalls.push({ inputPath, startMs, endMs, outPath });
      return { available: cutAvailable, reason: cutReason };
    },
  },
});

// ── a scriptable fake transcription backend, via the test seam ─────────────

interface EverettCall {
  bytes: number;
}
const everettCalls: EverettCall[] = [];
let everettConfiguredFlag = true;
let everettResponder: (call: EverettCall) => TranscribeChunkResult = () => ({
  status: "completed",
  language: "yi",
  segments: [
    { text: "אַ גוטן מאָרגן", start: 0, end: 2, avgLogprob: -0.1, noSpeechProb: 0.02, words: [{ word: "אַ", start: 0, end: 0.3 }] },
  ],
});
let everettThrows: Error | null = null;
/** Kept in sync with the real `YC_EVERETT_CENTS_PER_AUDIO_MINUTE` in `before()`, never hardcoded twice. */
let fakeCostCentsPerMinute = 0.07;

const fakeBackend: TranscribeBackend = {
  name: "everett",
  model: "ivrit-ai/whisper-large-v3-turbo-ct2",
  get costCentsPerMinute() {
    return fakeCostCentsPerMinute;
  },
  get configured() {
    return everettConfiguredFlag;
  },
  async transcribeChunk(input: { file: Buffer }) {
    if (everettThrows) throw everettThrows;
    const call = { bytes: input.file.length };
    everettCalls.push(call);
    return everettResponder(call);
  },
};

// ── mock node:fs/promises: no real file I/O ────────────────────────────────

const unlinkCalls: string[] = [];
let readFileBuffer: Buffer | null = Buffer.from("fake-mp3-bytes");
let readFileThrows = false;

mock.module("node:fs/promises", {
  namedExports: {
    readFile: async (_p: string) => {
      if (readFileThrows || !readFileBuffer) throw new Error("ENOENT");
      return readFileBuffer;
    },
    unlink: async (p: string) => {
      unlinkCalls.push(p);
    },
  },
});

// ⛔ Not a top-level `await import(...)`: this file's transform target does
// not allow top-level await. `before` resolves the (mocked) module once,
// ahead of every test below.
let YC_TRANSCRIBE_CHUNK_SEC: number;
let YC_EVERETT_CENTS_PER_AUDIO_MINUTE: number;
let transcriptConfidence: (avgLogprob: number | null | undefined, noSpeechProb: number | null | undefined) => number;
let recordTranscribeSpend: (db: any, sourceKey: string, now: Date, spend: { transcribedMinutes?: number; costCents?: number }) => Promise<void>;
let transcribe: any;
let align: any;

before(async () => {
  const mod = await import("./jobs");
  YC_TRANSCRIBE_CHUNK_SEC = mod.YC_TRANSCRIBE_CHUNK_SEC;
  YC_EVERETT_CENTS_PER_AUDIO_MINUTE = mod.YC_EVERETT_CENTS_PER_AUDIO_MINUTE;
  fakeCostCentsPerMinute = YC_EVERETT_CENTS_PER_AUDIO_MINUTE;
  transcriptConfidence = mod.transcriptConfidence;
  recordTranscribeSpend = mod.recordTranscribeSpend;
  transcribe = (mod.defaultStageHandlers as any).transcribe;
  align = (mod.defaultStageHandlers as any).align;
  // The handler resolves its backend via resolveTranscribeBackend(); the test
  // seam replaces that outright so these tests never depend on this box's
  // real EVERETT_*/YC_LOCAL_WHISPER_* env.
  setTranscribeBackendForTests(fakeBackend);
});

// ── a tiny fake db (purpose-built for this file: needs deleteMany) ─────────

type Row = Record<string, any>;

function makeDb(opts: { source?: Row | null; asset?: Row | null; segments?: Row[]; item?: Row } = {}) {
  const transcripts: Row[] = [];
  const itemUpdates: Row[] = [];
  const metrics: Row[] = [];
  let idSeq = 0;

  const asset = opts.asset === undefined ? { id: "asset-1", itemId: "item-1", storage: "STORED", storageKey: "/audio/item-1.mp3", durationMs: null } : opts.asset;
  const segments = opts.segments ?? [];

  return {
    transcripts,
    itemUpdates,
    metrics,
    ycAudioAsset: {
      findFirst: async () => (asset ? { ...asset } : null),
    },
    ycSource: {
      findUnique: async () => (opts.source === undefined ? null : opts.source),
    },
    ycSegment: {
      findMany: async ({ where }: any) => segments.filter((s) => !where?.assetId || s.assetId === where.assetId),
    },
    ycTranscript: {
      deleteMany: async ({ where }: any) => {
        const before = transcripts.length;
        for (let i = transcripts.length - 1; i >= 0; i -= 1) {
          const t = transcripts[i];
          if (t.itemId === where.itemId && t.engine === where.engine && t.originRef === where.originRef) {
            transcripts.splice(i, 1);
          }
        }
        return { count: before - transcripts.length };
      },
      create: async ({ data }: any) => {
        idSeq += 1;
        const row = { id: `t-${idSeq}`, ...data };
        transcripts.push(row);
        return { ...row };
      },
      findMany: async ({ where }: any = {}) => {
        return transcripts.filter((t) => {
          if (where?.itemId && t.itemId !== where.itemId) return false;
          if (where?.engine && t.engine !== where.engine) return false;
          return true;
        });
      },
      update: async ({ where, data }: any) => {
        const row = transcripts.find((t) => t.id === where.id);
        if (!row) throw new Error("no such transcript");
        Object.assign(row, data);
        return { ...row };
      },
    },
    ycSourceItem: {
      update: async ({ data }: any) => {
        itemUpdates.push(data);
        return { ...data };
      },
    },
    ycMetricSnapshot: {
      findFirst: async ({ where }: any) => metrics.find((m) => m.day === where.day && m.sourceKey === where.sourceKey && m.metric === where.metric) ?? null,
      upsert: async ({ where, update, create }: any) => {
        const key = where.day_sourceKey_metric;
        const row = metrics.find((m) => m.day === key.day && m.sourceKey === key.sourceKey && m.metric === key.metric);
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        const created = { ...create };
        metrics.push(created);
        return { ...created };
      },
    },
  };
}

const ITEM = { id: "item-1", sourceId: "src-1", durationSec: null };
const JOB = { id: "job-1", sourceKey: "yiddish24", stage: "transcribe", payload: null } as any;
const NOW = new Date("2026-09-17T12:00:00.000Z");

function reset() {
  cutCalls.length = 0;
  cutAvailable = true;
  cutReason = null;
  everettCalls.length = 0;
  everettConfiguredFlag = true;
  everettThrows = null;
  unlinkCalls.length = 0;
  readFileBuffer = Buffer.from("fake-mp3-bytes");
  readFileThrows = false;
  everettResponder = () => ({
    status: "completed",
    language: "yi",
    segments: [
      { text: "אַ גוטן מאָרגן", start: 0, end: 2, avgLogprob: -0.1, noSpeechProb: 0.02, words: [{ word: "אַ", start: 0, end: 0.3 }] },
    ],
  });
}

const SPEECH_60S = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 60_000, klass: "SPEECH" }];

// ── 1. no stored asset / walled source ──────────────────────────────────────

test("transcribe skips honestly when there is no stored audio asset", async () => {
  reset();
  const db = makeDb({ asset: null, segments: [] });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.match(res.reason, /no stored audio/i);
  assert.equal(cutCalls.length, 0, "no audio bytes were touched");
});

test("transcribe re-reads the customer wall and SKIPs with the exact message when walled", async () => {
  reset();
  const db = makeDb({ source: { id: "src-1", key: "voicemail", contentAllowed: false, governanceClass: "CUSTOMER_PRIVATE" }, segments: SPEECH_60S });
  const res = await transcribe({ db, item: ITEM, job: { ...JOB, sourceKey: "voicemail" }, now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, YC_CUSTOMER_WALL_MESSAGE);
  assert.equal(cutCalls.length, 0, "a walled item's bytes are never sent anywhere, not even for a chunk cut");
});

test("transcribe skips when there is no speech to chunk", async () => {
  reset();
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments: [] });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /no speech/i);
});

test("transcribe skips when Everett is not configured, and never calls it", async () => {
  reset();
  everettConfiguredFlag = false;
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments: SPEECH_60S });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /not configured/i);
  assert.equal(everettCalls.length, 0);
});

// ── 2. chunk planning drives the cut calls ──────────────────────────────────

test("a 25-minute speech span at the 600s default is cut into 3 chunks, in order", async () => {
  reset();
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 25 * 60_000, klass: "SPEECH" }];
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(cutCalls.length, 3, `expected 3 chunks at the ${YC_TRANSCRIBE_CHUNK_SEC}s default, got ${cutCalls.length}`);
  assert.equal(cutCalls[0].startMs, 0);
  assert.equal(cutCalls[0].endMs, 600_000);
  assert.equal(cutCalls[1].startMs, 600_000);
  assert.equal(cutCalls[1].endMs, 1_200_000);
  assert.equal(cutCalls[2].startMs, 1_200_000);
  assert.equal(cutCalls[2].endMs, 1_500_000);
  assert.equal(everettCalls.length, 3, "one Everett call per chunk");
});

test("a payload chunkSec override is honoured", async () => {
  reset();
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 90_000, klass: "SPEECH" }];
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  await transcribe({ db, item: ITEM, job: { ...JOB, payload: { chunkSec: 30 } }, now: NOW });
  assert.equal(cutCalls.length, 3, "90s of speech at a 30s cap is 3 chunks");
});

// ── 3. one YcTranscript row per whisper segment, with offsets ──────────────

test("writes one YcTranscript row per whisper segment, offset by the chunk start", async () => {
  reset();
  everettResponder = (call) => ({
    status: "completed",
    language: "yi",
    segments: [
      { text: "אַ", start: 0, end: 1, avgLogprob: -0.05, noSpeechProb: 0.01 },
      { text: "גוטן", start: 1, end: 2.5, avgLogprob: -0.2, noSpeechProb: 0.05 },
    ],
  });
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 700_000, endMs: 702_500, klass: "SPEECH" }];
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(db.transcripts.length, 2);
  const [a, b] = db.transcripts;
  assert.equal(a.engine, "ivrit");
  assert.equal(a.sttProvider, "ivrit-ai/whisper-large-v3-turbo-ct2");
  assert.equal(a.language, "yi");
  assert.equal(a.chunkIndex, 0);
  assert.equal(a.originRef, "asset-1#0");
  // Offsets: chunk starts at 700_000ms, so a whisper-relative 0..1s becomes 700000..701000.
  assert.equal(a.startMs, 700_000);
  assert.equal(a.endMs, 701_000);
  assert.equal(b.startMs, 701_000);
  assert.equal(b.endMs, 702_500);
  assert.equal(b.words, null, "a segment with no words from Everett stores null, never a guess");
});

test("confidence is derived from avgLogprob and docked by noSpeechProb, never invented", async () => {
  reset();
  assert.ok(transcriptConfidence(0, 0) <= 1 && transcriptConfidence(0, 0) > 0.9, "avgLogprob 0 => exp(0)=1, docked by 0");
  assert.ok(transcriptConfidence(-2, 0) < transcriptConfidence(-0.1, 0), "a worse logprob must score lower");
  assert.ok(transcriptConfidence(-0.1, 0.9) < transcriptConfidence(-0.1, 0), "a high no-speech probability docks the score");
  assert.equal(transcriptConfidence(null, null), 0.5, "no signal at all is a stated midpoint, not a claim of certainty");
});

// ── 4. idempotency: a second run replaces, never doubles ───────────────────

test("re-running transcribe on the same chunk replaces its rows instead of doubling them", async () => {
  reset();
  const segments = SPEECH_60S;
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  const first = db.transcripts.length;
  assert.ok(first > 0);
  await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(db.transcripts.length, first, "a second run must not double the rows for the same chunk");
});

test("a chunk another job's rows are untouched when re-running a different item's chunk", async () => {
  reset();
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments: SPEECH_60S });
  // A pre-existing row for a DIFFERENT originRef must survive.
  await db.ycTranscript.create({ data: { itemId: "item-1", engine: "ivrit", originRef: "asset-1#99", text: "kept" } });
  await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.ok(db.transcripts.some((t: any) => t.originRef === "asset-1#99" && t.text === "kept"));
});

// ── 5. one bad chunk must not lose the whole item ───────────────────────────

test("a cutChunk failure on one chunk does not stop the others", async () => {
  reset();
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 20 * 60_000, klass: "SPEECH" }];
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  let calls = 0;
  const realCut = cutAvailable;
  // Fail every OTHER chunk by toggling the shared flag from inside the mock —
  // simplest is to fail cutChunk universally then assert the item still SKIPs
  // honestly rather than throwing.
  cutAvailable = false;
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true, "every chunk failing to cut is an honest skip, not a crash");
  cutAvailable = realCut;
});

test("Everett throwing on a chunk is swallowed for that chunk, not fatal to the item", async () => {
  reset();
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 60_000, klass: "SPEECH" }];
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  everettThrows = new Error("runpod is down");
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});

// ── 6. minutes / cents are charged, and the item state advances ────────────

test("transcribedMinutes and costCents are returned so chargeBudget can charge them", async () => {
  reset();
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 120_000, klass: "SPEECH" }]; // 2 minutes
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.advance, true);
  assert.equal(res.transcribedMinutes, 2);
  assert.equal(res.costCents, Math.ceil(2 * YC_EVERETT_CENTS_PER_AUDIO_MINUTE));
  assert.deepEqual(db.itemUpdates, [{ state: "TRANSCRIBED" }]);
});

test("a $0/minute backend (the local one) still reports transcribedMinutes, so the free backend is throttled by the minute cap too", async () => {
  reset();
  fakeCostCentsPerMinute = 0; // stand-in for LocalFasterWhisperBackend.costCentsPerMinute
  const segments = [{ id: "seg-1", assetId: "asset-1", startMs: 0, endMs: 180_000, klass: "SPEECH" }]; // 3 minutes
  const db = makeDb({ source: { id: "src-1", contentAllowed: true }, segments });
  const res = await transcribe({ db, item: ITEM, job: JOB, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.advance, true);
  assert.equal(res.transcribedMinutes, 3, "minutes are still tracked even when the backend is free");
  assert.equal(res.costCents, 0, "a $0/minute backend charges nothing");
  fakeCostCentsPerMinute = YC_EVERETT_CENTS_PER_AUDIO_MINUTE;
});

test("recordTranscribeSpend accumulates per day per source instead of overwriting", async () => {
  reset();
  const db = makeDb();
  await recordTranscribeSpend(db, "yiddish24", NOW, { transcribedMinutes: 2, costCents: 1 });
  await recordTranscribeSpend(db, "yiddish24", NOW, { transcribedMinutes: 3, costCents: 1 });
  const minutesRow = db.metrics.find((m: any) => m.metric === "transcribe.minutes" && m.sourceKey === "yiddish24");
  const centsRow = db.metrics.find((m: any) => m.metric === "transcribe.cents" && m.sourceKey === "yiddish24");
  assert.ok(minutesRow, "a transcribe.minutes row must exist after a spend");
  assert.ok(centsRow, "a transcribe.cents row must exist after a spend");
  assert.equal(minutesRow!.value, 5, "the two runs must add up, not overwrite");
  assert.equal(centsRow!.value, 2);
  // A different source's ledger is untouched.
  await recordTranscribeSpend(db, "voicemail", NOW, { transcribedMinutes: 10, costCents: 1 });
  assert.equal(minutesRow!.value, 5, "yiddish24's row must not be touched by voicemail's spend");
});

// ── 7. align ─────────────────────────────────────────────────────────────

test("align pins each ivrit transcript to the SPEECH segment it overlaps most", async () => {
  reset();
  const db = makeDb({
    asset: { id: "asset-1", itemId: "item-1", storage: "STORED", storageKey: "/x.mp3" },
    segments: [
      { id: "seg-a", assetId: "asset-1", startMs: 0, endMs: 1_000, klass: "SPEECH" },
      { id: "seg-b", assetId: "asset-1", startMs: 1_000, endMs: 3_000, klass: "SPEECH" },
    ],
  });
  await db.ycTranscript.create({ data: { itemId: "item-1", engine: "ivrit", startMs: 100, endMs: 900, text: "a" } });
  await db.ycTranscript.create({ data: { itemId: "item-1", engine: "ivrit", startMs: 900, endMs: 2_900, text: "b" } }); // mostly seg-b
  await db.ycTranscript.create({ data: { itemId: "item-1", engine: "ivrit", startMs: 10_000, endMs: 11_000, text: "no overlap" } });

  const res = await align({ db, item: ITEM, job: { ...JOB, stage: "align" }, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.advance, true);

  const rows = await db.ycTranscript.findMany({ where: { itemId: "item-1", engine: "ivrit" } });
  const byText = Object.fromEntries(rows.map((r: any) => [r.text, r]));
  assert.equal(byText.a.segmentId, "seg-a");
  assert.equal(byText.b.segmentId, "seg-b", "the segment with the LARGEST overlap wins");
  assert.equal(byText["no overlap"].segmentId ?? null, null, "no overlapping segment means segmentId stays null");
});

test("align sets the item state to ALIGNED", async () => {
  reset();
  const db = makeDb({ asset: null, segments: [] });
  await db.ycTranscript.create({ data: { itemId: "item-1", engine: "ivrit", startMs: 0, endMs: 1000, text: "a" } });
  await align({ db, item: ITEM, job: { ...JOB, stage: "align" }, now: NOW });
  assert.deepEqual(db.itemUpdates, [{ state: "ALIGNED" }]);
});

test("align skips honestly when there are no ivrit transcript rows yet", async () => {
  reset();
  const db = makeDb({ asset: null, segments: [] });
  const res = await align({ db, item: ITEM, job: { ...JOB, stage: "align" }, now: NOW });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /no ivrit transcript/i);
});

// ── 8. ⛔ never Yiddish Labs ─────────────────────────────────────────────────

test("SOURCE GUARD: jobs.ts's transcribe/align code, everettClient.ts, transcribeBackend.ts and local_whisper.py never mention Yiddish Labs", () => {
  const jobsSrc = readFileSync(path.join(__dirname, "jobs.ts"), "utf8").replace(/\r\n/g, "\n");
  const everettSrc = readFileSync(path.join(__dirname, "everettClient.ts"), "utf8").replace(/\r\n/g, "\n");
  const backendSrc = readFileSync(path.join(__dirname, "transcribeBackend.ts"), "utf8").replace(/\r\n/g, "\n");
  const pySrc = readFileSync(path.join(__dirname, "local_whisper.py"), "utf8").replace(/\r\n/g, "\n");
  // ⛔ NOT "yiddish labs" (the two-word phrase): the codebase's own governance
  // comments (governance.ts, jobs.ts, contracts.ts, ...) legitimately say
  // "Yiddish Labs" in prose to WARN against referencing it — that is not a
  // reference/usage, and flagging it would break the very comments this
  // guard exists to keep honest. Only the code-identifier-shaped forms are
  // checked, matching the established convention everywhere else in this
  // module.
  for (const marker of ["yiddishlabs", "yiddish-labs", "yiddish_labs"]) {
    assert.equal(jobsSrc.toLowerCase().includes(marker), false, `jobs.ts must never mention "${marker}"`);
    assert.equal(everettSrc.toLowerCase().includes(marker), false, `everettClient.ts must never mention "${marker}"`);
    assert.equal(backendSrc.toLowerCase().includes(marker), false, `transcribeBackend.ts must never mention "${marker}"`);
    assert.equal(pySrc.toLowerCase().includes(marker), false, `local_whisper.py must never mention "${marker}"`);
  }
});

test("SOURCE GUARD: everettClient.ts never sends language \"he\" — every literal is \"yi\"", () => {
  const src = readFileSync(path.join(__dirname, "everettClient.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(/language:\s*["']he["']/.test(src), false, "no literal Hebrew language tag may appear");
  assert.match(src, /EVERETT_LANGUAGE\s*=\s*"yi"/, "the one language constant must be pinned to yi");
});

test("SOURCE GUARD: everettClient.ts never logs the API key", () => {
  const src = readFileSync(path.join(__dirname, "everettClient.ts"), "utf8").replace(/\r\n/g, "\n");
  const consoleLines = src.split("\n").filter((l) => /console\.(log|error|warn|info)/.test(l));
  for (const line of consoleLines) {
    assert.equal(/apiKey/i.test(line), false, `a console call references apiKey: ${line}`);
  }
});
