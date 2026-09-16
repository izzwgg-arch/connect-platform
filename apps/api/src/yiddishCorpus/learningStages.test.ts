/**
 * The two stages that turn an item into knowledge: `observe` and `aggregate`.
 *
 * These exist because of a real defect. Both stages were DECLARED in
 * `YC_STAGES` and neither had a handler, so `runDueJobs` fell through to
 * `no handler for stage "observe"` and marked the job SKIPPED. On the queue
 * screen a SKIP is a lawful outcome with a reason — the pipeline looked
 * healthy while the last two steps did not exist. 20 jobs had already been
 * "skipped" that way in production before anyone read the reason text.
 *
 * So the first test here is the coverage guard, not a behaviour test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { defaultStageHandlers } from "./jobs";
import { YC_STAGES, YC_AUDIO_STAGES } from "./contracts";

type Row = Record<string, any>;

// ── 1. the guard that would have caught it ──────────────────────────────────

test("every declared stage either has a handler or is gated by audio rights", () => {
  const missing = YC_STAGES.filter(
    (stage) => !(defaultStageHandlers as any)[stage] && !YC_AUDIO_STAGES.includes(stage),
  );
  assert.deepEqual(
    missing,
    [],
    `these stages would be SKIPPED with "no handler", which reads like a lawful refusal: ${missing.join(", ")}`,
  );
});

test("the audio stages are the only ones allowed to have no handler", () => {
  // They never reach the handler lookup: runDueJobs checks the rights gate
  // first and skips with the gate's own reason. If one ever grows a handler
  // that is fine too — what must not happen is a NON-audio stage without one.
  for (const stage of YC_AUDIO_STAGES) {
    assert.ok(YC_STAGES.includes(stage), `${stage} is not a declared stage`);
  }
});

// ── a tiny db double ────────────────────────────────────────────────────────

function fakeDb(opts: {
  source?: Row | null;
  transcripts?: Row[];
  segments?: Row[];
  lexemes?: Row[];
  observations?: Row[];
} = {}) {
  const lexemes: Row[] = [...(opts.lexemes ?? [])];
  const observations: Row[] = [...(opts.observations ?? [])];
  const rules: Row[] = [];
  const findings: Row[] = [];
  const snapshots: Row[] = [];
  const itemUpdates: Row[] = [];

  return {
    lexemes,
    observations,
    rules,
    findings,
    itemUpdates,
    ycSource: { findUnique: async () => opts.source ?? null },
    ycTranscript: { findMany: async () => opts.transcripts ?? [] },
    ycSegment: {
      findUnique: async ({ where }: any) => (opts.segments ?? []).find((s) => s.id === where.id) ?? null,
    },
    ycSourceItem: {
      update: async ({ data }: any) => {
        itemUpdates.push(data);
        return data;
      },
    },
    ycMetricSnapshot: {
      create: async ({ data }: any) => {
        if (snapshots.some((s) => s.metric === data.metric && s.sourceKey === data.sourceKey)) {
          const err: any = new Error("unique");
          err.code = "P2002";
          throw err;
        }
        snapshots.push(data);
        return data;
      },
    },
    ycLexeme: {
      upsert: async ({ where, create }: any) => {
        const found = lexemes.find((l) => l.writtenForm === where.writtenForm);
        if (found) return found;
        const row = { id: `lex-${lexemes.length + 1}`, ...create };
        lexemes.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => lexemes.find((l) => l.id === where.id) ?? null,
    },
    ycPronunciationObservation: {
      create: async ({ data }: any) => {
        observations.push(data);
        return data;
      },
      findMany: async ({ where, distinct }: any) => {
        let out = observations.filter((o) => (where?.itemId ? o.itemId === where.itemId : true));
        if (where?.lexemeId) out = out.filter((o) => o.lexemeId === where.lexemeId);
        if (distinct?.includes("lexemeId")) {
          const seen = new Set<string>();
          out = out.filter((o) => (seen.has(o.lexemeId) ? false : (seen.add(o.lexemeId), true)));
        }
        return out;
      },
    },
    ycPronunciationRule: {
      upsert: async ({ create }: any) => {
        rules.push(create);
        return create;
      },
    },
    ycFinding: {
      create: async ({ data }: any) => {
        findings.push(data);
        return data;
      },
    },
  } as any;
}

const EXTERNAL_SOURCE = { id: "src-1", key: "yiddish24", contentAllowed: true, governanceClass: "EXTERNAL" };
const ITEM = { id: "item-1", sourceId: "src-1" };
const JOB = { id: "job-1", sourceKey: "yiddish24", stage: "observe", payload: null } as any;

const observe = (defaultStageHandlers as any).observe;
const aggregate = (defaultStageHandlers as any).aggregate;

// ── 2. observe ──────────────────────────────────────────────────────────────

test("observe on an item with no transcript skips, and says why in plain words", async () => {
  const db = fakeDb({ source: EXTERNAL_SOURCE, transcripts: [] });
  const res = await observe({ db, item: ITEM, job: JOB });
  assert.equal(res.ok, true, "a missing transcript is a lawful outcome, not a failure");
  assert.equal(res.skipped, true);
  assert.match(res.reason, /nothing to observe/i);
  assert.doesNotMatch(res.reason, /no handler/i);
  assert.equal(db.lexemes.length, 0);
});

test("observe refuses a walled source and reads nothing", async () => {
  const db = fakeDb({
    source: { id: "src-2", key: "voicemail", contentAllowed: false, governanceClass: "CUSTOMER_PRIVATE" },
    transcripts: [{ id: "t1", text: "אַ גוטן מאָרגן", segmentId: null }],
  });
  const res = await observe({ db, item: { id: "i2", sourceId: "src-2" }, job: { ...JOB, sourceKey: "voicemail" } });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /counted, never read|never read/i);
  assert.equal(db.lexemes.length, 0, "a walled transcript must not become vocabulary");
  assert.equal(db.observations.length, 0);
});

test("observe learns vocabulary from a transcript", async () => {
  const db = fakeDb({
    source: EXTERNAL_SOURCE,
    transcripts: [{ id: "t1", text: "אַ גוטן מאָרגן", segmentId: null, isConsensus: false }],
  });
  const res = await observe({ db, item: ITEM, job: JOB });
  assert.equal(res.ok, true);
  assert.ok(db.lexemes.length >= 2, `expected lexemes, got ${db.lexemes.length}`);
  assert.deepEqual(db.itemUpdates, [{ state: "INDEXED" }]);
});

test("observe NEVER invents a pronunciation observation without an aligned segment", async () => {
  // This is the line between "we heard it" and "we guessed". Text alone can
  // teach spelling and frequency; it cannot teach sound.
  const db = fakeDb({
    source: EXTERNAL_SOURCE,
    transcripts: [{ id: "t1", text: "אַ גוטן מאָרגן", segmentId: null, isConsensus: false }],
  });
  await observe({ db, item: ITEM, job: JOB });
  assert.equal(db.observations.length, 0, "no segment means no acoustic evidence, so no observation");
});

test("observe records ACOUSTIC_ALIGNED evidence when the text is pinned to a segment", async () => {
  const db = fakeDb({
    source: EXTERNAL_SOURCE,
    transcripts: [{ id: "t1", text: "מאָרגן", segmentId: "seg-1", isConsensus: true, confidence: 0.8 }],
    segments: [{ id: "seg-1", speakerClusterId: "spk-1" }],
  });
  await observe({ db, item: ITEM, job: JOB });
  assert.ok(db.observations.length >= 1, "an aligned segment is real evidence");
  for (const o of db.observations) {
    assert.equal(o.evidenceKind, "ACOUSTIC_ALIGNED");
    assert.equal(o.speakerClusterId, "spk-1");
    assert.equal(o.realization, null, "we do not have a phonetic realization, so we do not claim one");
  }
});

test("observe is idempotent — a second run does not re-observe the same text", async () => {
  const db = fakeDb({
    source: EXTERNAL_SOURCE,
    transcripts: [{ id: "t1", text: "מאָרגן", segmentId: "seg-1", isConsensus: true, confidence: 0.8 }],
    segments: [{ id: "seg-1", speakerClusterId: "spk-1" }],
  });
  await observe({ db, item: ITEM, job: JOB });
  const after1 = db.observations.length;
  await observe({ db, item: ITEM, job: JOB });
  assert.equal(db.observations.length, after1, "the ingest ledger must stop a second pass doubling evidence");
});

// ── 3. aggregate ────────────────────────────────────────────────────────────

test("aggregate with no observations skips honestly", async () => {
  const db = fakeDb({ source: EXTERNAL_SOURCE });
  const res = await aggregate({ db, item: ITEM, job: { ...JOB, stage: "aggregate" } });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.match(res.reason, /nothing to aggregate/i);
});

test("aggregate proposes CANDIDATE rules and never an approved one", async () => {
  // 30 observations of one variant across 6 speakers: comfortably past the
  // sample floor, so this is the case that DOES produce a rule.
  const observations = Array.from({ length: 30 }, (_, i) => ({
    lexemeId: "lex-1",
    variantKey: "morgn",
    realization: null,
    sourceKey: "yiddish24",
    itemId: "item-1",
    speakerClusterId: `spk-${i % 6}`,
    confidence: 0.9,
    evidenceKind: "ACOUSTIC_ALIGNED",
  }));
  const db = fakeDb({
    source: EXTERNAL_SOURCE,
    lexemes: [{ id: "lex-1", writtenForm: "מאָרגן", normalized: "morgn", origin: "YIDDISH" }],
    observations,
  });
  const res = await aggregate({ db, item: ITEM, job: { ...JOB, stage: "aggregate" } });
  assert.equal(res.ok, true);
  for (const r of db.rules) {
    assert.equal(r.status, "CANDIDATE", "the engine may propose, never approve");
    assert.equal(r.approvedBy ?? null, null);
    assert.equal(r.approvedAt ?? null, null);
  }
});

test("aggregate flags a genuine disagreement for a person instead of picking a winner", async () => {
  // Two variants, each well represented. The engine must NOT choose.
  const mk = (variant: string, n: number, off: number) =>
    Array.from({ length: n }, (_, i) => ({
      lexemeId: "lex-1",
      variantKey: variant,
      realization: null,
      sourceKey: "yiddish24",
      itemId: "item-1",
      speakerClusterId: `spk-${off + (i % 5)}`,
      confidence: 0.9,
      evidenceKind: "ACOUSTIC_ALIGNED",
    }));
  const db = fakeDb({
    source: EXTERNAL_SOURCE,
    lexemes: [{ id: "lex-1", writtenForm: "מאָרגן", normalized: "morgn", origin: "YIDDISH" }],
    observations: [...mk("morgn", 20, 0), ...mk("moygn", 20, 10)],
  });
  await aggregate({ db, item: ITEM, job: { ...JOB, stage: "aggregate" } });
  assert.equal(db.findings.length, 1, "a real split must become a finding");
  assert.equal(db.findings[0].kind, "PRONUNCIATION_CONFLICT");
  assert.equal(db.findings[0].status, "PROPOSED");
  assert.ok(db.findings[0].speakerCount >= 2, "the finding must carry how many speakers it rests on");
});
