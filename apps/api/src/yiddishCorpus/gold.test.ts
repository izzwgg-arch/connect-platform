/**
 * Yiddish Corpus — the GOLD SET.
 *
 * Two layers, tested separately:
 *  1. `gold.ts`'s pure functions (sampling math, upload/range validation) —
 *     no db, no fastify, no fs.
 *  2. The routes themselves, through the same fake-fastify/fake-Prisma
 *     harness `routes.test.ts` uses, for the behaviours that only exist once
 *     the routes are wired up: the wall, and "a decision never touches the
 *     machine row's text".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoldHumanRow,
  finetuneReportPaths,
  goldClipPath,
  goldStorageRoot,
  GOLD_DECISION_STATE,
  parseRangeHeader,
  stratifiedGoldSample,
  validateGoldClipUpload,
  YC_GOLD_CLIP_MAX_BYTES,
  type GoldCandidate,
} from "./gold";
import { registerYiddishCorpusRoutes, YC_REGISTERED_ROUTES } from "./routes";
import { YC_API_PREFIX } from "./contracts";

// ═══════════════════════════ pure-function tests ═══════════════════════════

function candidate(overrides: Partial<GoldCandidate>): GoldCandidate {
  return {
    transcriptId: "t_default",
    itemId: "i_default",
    assetId: "a_default",
    sourceKey: "yiddish24",
    confidence: 0.5,
    startMs: 0,
    endMs: 5000,
    text: "text",
    language: "yi",
    segmentId: null,
    ...overrides,
  };
}

test("stratifiedGoldSample: count <= 0 or an empty pool returns nothing", () => {
  assert.deepEqual(stratifiedGoldSample([candidate({})], 0), []);
  assert.deepEqual(stratifiedGoldSample([], 10), []);
});

test("stratifiedGoldSample: never returns more than requested, and never more than the pool has", () => {
  const pool = Array.from({ length: 5 }, (_, i) => candidate({ transcriptId: `t${i}`, itemId: `i${i}`, confidence: i / 5 }));
  assert.equal(stratifiedGoldSample(pool, 3).length, 3);
  assert.equal(stratifiedGoldSample(pool, 50).length, 5, "cannot invent candidates the pool does not have");
});

test("stratifiedGoldSample: never returns the same transcript twice", () => {
  const pool = Array.from({ length: 40 }, (_, i) =>
    candidate({ transcriptId: `t${i}`, itemId: `i${i % 6}`, confidence: (i % 11) / 10 }),
  );
  const picked = stratifiedGoldSample(pool, 25);
  const ids = new Set(picked.map((c) => c.transcriptId));
  assert.equal(ids.size, picked.length, "a duplicate transcript was sampled");
});

test("stratifiedGoldSample: prefers low confidence — the mean of the sample is well below the mean of the pool", () => {
  // A wide, evenly spread pool across many items so no single item dominates
  // a confidence stratum by construction.
  const pool: GoldCandidate[] = [];
  for (let i = 0; i < 100; i++) {
    pool.push(candidate({ transcriptId: `t${i}`, itemId: `i${i % 10}`, sourceKey: `src${i % 4}`, confidence: i / 100 }));
  }
  const poolMean = pool.reduce((s, c) => s + (c.confidence ?? 0), 0) / pool.length; // 0.495
  const picked = stratifiedGoldSample(pool, 20);
  const pickedMean = picked.reduce((s, c) => s + (c.confidence ?? 0), 0) / picked.length;
  assert.ok(pickedMean < poolMean - 0.1, `sample mean ${pickedMean} should sit well below the pool mean ${poolMean}`);
});

test("stratifiedGoldSample: null confidence is treated as the lowest (most wanted), not skipped", () => {
  const pool: GoldCandidate[] = [
    candidate({ transcriptId: "t_null", itemId: "i1", confidence: null }),
    ...Array.from({ length: 10 }, (_, i) => candidate({ transcriptId: `t_hi${i}`, itemId: `i${i + 2}`, confidence: 0.9 })),
  ];
  const picked = stratifiedGoldSample(pool, 1);
  assert.equal(picked[0]?.transcriptId, "t_null");
});

test("stratifiedGoldSample: spreads across items instead of exhausting one item first", () => {
  // 4 items, 10 rows each, interleaved and all equal confidence so the
  // stratification split cannot accidentally separate them by item.
  const pool: GoldCandidate[] = [];
  for (let row = 0; row < 10; row++) {
    for (let item = 0; item < 4; item++) {
      pool.push(candidate({ transcriptId: `t${row}_${item}`, itemId: `item${item}`, sourceKey: `src${item % 2}`, confidence: 0.5 }));
    }
  }
  const picked = stratifiedGoldSample(pool, 8);
  const distinctItems = new Set(picked.map((c) => c.itemId));
  assert.ok(distinctItems.size >= 3, `expected picks spread across at least 3 of 4 items, got ${distinctItems.size}`);
  const maxFromOneItem = Math.max(...[...distinctItems].map((id) => picked.filter((c) => c.itemId === id).length));
  assert.ok(maxFromOneItem <= 5, `one item supplied ${maxFromOneItem} of 8 picks — not a spread`);
});

test("validateGoldClipUpload: refuses anything that isn't audio/wav", () => {
  const bad = validateGoldClipUpload("audio/mpeg", 1000);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.status, 415);
    assert.equal(bad.error, "unsupported_media_type");
  }
});

test("validateGoldClipUpload: accepts audio/wav with a content-type parameter", () => {
  const ok = validateGoldClipUpload("audio/wav; charset=binary", 1000);
  assert.equal(ok.ok, true);
});

test("validateGoldClipUpload: refuses an empty body", () => {
  const bad = validateGoldClipUpload("audio/wav", 0);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
});

test("validateGoldClipUpload: refuses anything over the 3 MB cap, accepts exactly at the cap", () => {
  const tooBig = validateGoldClipUpload("audio/wav", YC_GOLD_CLIP_MAX_BYTES + 1);
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.equal(tooBig.status, 413);
  const atCap = validateGoldClipUpload("audio/wav", YC_GOLD_CLIP_MAX_BYTES);
  assert.equal(atCap.ok, true);
});

test("parseRangeHeader: no header means the whole file", () => {
  assert.equal(parseRangeHeader(undefined, 1000), null);
  assert.equal(parseRangeHeader(null, 1000), null);
});

test("parseRangeHeader: a plain byte range", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99 });
});

test("parseRangeHeader: open-ended range reads to the end of the file", () => {
  assert.deepEqual(parseRangeHeader("bytes=900-", 1000), { start: 900, end: 999 });
});

test("parseRangeHeader: a suffix range reads the last N bytes", () => {
  assert.deepEqual(parseRangeHeader("bytes=-100", 1000), { start: 900, end: 999 });
});

test("parseRangeHeader: an end past the file is clamped, not refused", () => {
  assert.deepEqual(parseRangeHeader("bytes=990-999999", 1000), { start: 990, end: 999 });
});

test("parseRangeHeader: malformed or out-of-bounds headers are ignored (whole file)", () => {
  assert.equal(parseRangeHeader("not-a-range", 1000), null);
  assert.equal(parseRangeHeader("bytes=2000-3000", 1000), null, "a start past the end of the file is not a valid range");
});

test("buildGoldHumanRow: always engine=human, confidence=1, and the gold-tagged originRef", () => {
  const row = buildGoldHumanRow({
    reviewId: "rev_1",
    itemId: "item_1",
    segmentId: "seg_1",
    startMs: 1000,
    endMs: 4000,
    language: "yi",
    text: "  a corrected sentence  ",
    actor: "izzy@loopcom.net",
  });
  assert.equal(row.engine, "human");
  assert.equal(row.confidence, 1);
  assert.equal(row.originRef, "gold:rev_1");
  assert.equal(row.sttProvider, "izzy@loopcom.net");
  assert.equal(row.text, "  a corrected sentence  ", "buildGoldHumanRow does not itself trim — the caller already did");
});

test("buildGoldHumanRow: defaults language to yi when the machine row had none", () => {
  const row = buildGoldHumanRow({
    reviewId: "rev_2",
    itemId: "item_1",
    segmentId: null,
    startMs: null,
    endMs: null,
    language: null,
    text: "x",
    actor: "a",
  });
  assert.equal(row.language, "yi");
});

test("goldClipPath: refuses a path-traversal id and anything that isn't a plain id", () => {
  assert.throws(() => goldClipPath("../../etc/passwd"));
  assert.throws(() => goldClipPath("has spaces"));
  assert.throws(() => goldClipPath(""));
});

test("goldClipPath: a plain id resolves under the storage root's gold/ folder", () => {
  const old = process.env.YIDDISH_CORPUS_STORAGE_DIR;
  process.env.YIDDISH_CORPUS_STORAGE_DIR = "/tmp/yc-test-root";
  try {
    const p = goldClipPath("clh1abc123");
    assert.equal(p.replace(/\\/g, "/"), "/tmp/yc-test-root/gold/clh1abc123.wav");
  } finally {
    if (old === undefined) delete process.env.YIDDISH_CORPUS_STORAGE_DIR;
    else process.env.YIDDISH_CORPUS_STORAGE_DIR = old;
  }
});

test("finetuneReportPaths: latest is stable, history is timestamped, both under the same storage root", () => {
  const old = process.env.YIDDISH_CORPUS_STORAGE_DIR;
  process.env.YIDDISH_CORPUS_STORAGE_DIR = "/tmp/yc-test-root";
  try {
    const paths = finetuneReportPaths(new Date("2026-09-17T12:00:00.000Z"));
    assert.equal(paths.latest.replace(/\\/g, "/"), "/tmp/yc-test-root/finetune/latest-report.json");
    assert.ok(paths.history.includes("2026-09-17"), "the history file should carry the run's timestamp");
    assert.equal(goldStorageRoot(), "/tmp/yc-test-root");
  } finally {
    if (old === undefined) delete process.env.YIDDISH_CORPUS_STORAGE_DIR;
    else process.env.YIDDISH_CORPUS_STORAGE_DIR = old;
  }
});

test("GOLD_DECISION_STATE covers exactly the four decisions", () => {
  assert.deepEqual(Object.keys(GOLD_DECISION_STATE).sort(), ["accept", "correct", "reject", "skip"]);
});

// ═══════════════════════════ route-level tests ═══════════════════════════
// Same fake-fastify / fake-Prisma harness as routes.test.ts (duplicated
// locally: routes.test.ts does not export it).

type Handler = (req: any, reply: any) => Promise<any>;

function fakeApp() {
  const routes = new Map<string, Handler>();
  const record = (method: string) => (path: string, handler: Handler) => routes.set(`${method} ${path}`, handler);
  return {
    app: {
      get: record("GET"),
      post: record("POST"),
      put: record("PUT"),
      patch: record("PATCH"),
      log: { info() {}, warn() {}, error() {} },
    },
    routes,
  };
}

function fakeReply() {
  const r: any = {
    statusCode: 200,
    payload: undefined as any,
    headers: {} as Record<string, string>,
    code(n: number) {
      r.statusCode = n;
      return r;
    },
    header(k: string, v: string) {
      r.headers[k] = v;
      return r;
    },
    send(p: any) {
      r.payload = p;
      return undefined;
    },
  };
  return r;
}

const EMPTY_DEFAULTS: Record<string, any> = {
  count: 0,
  findMany: [],
  findFirst: null,
  findUnique: null,
  aggregate: { _sum: {} },
  groupBy: [],
  updateMany: { count: 0 },
};

function fakeDb(overrides: Record<string, any> = {}): any {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (args: any) => {
                const key = `${String(model)}.${String(method)}`;
                if (key in overrides) {
                  const v = overrides[key];
                  return typeof v === "function" ? v(args) : v;
                }
                if (String(method) in EMPTY_DEFAULTS) return EMPTY_DEFAULTS[String(method)];
                return { id: "row_1", ...(args?.data ?? args?.create ?? {}) };
              };
            },
          },
        );
      },
    },
  );
}

const SUPER_ADMIN = { sub: "u_owner", email: "izzy@loopcom.net", role: "SUPER_ADMIN" };
const allowingGate = async () => SUPER_ADMIN;

function register(db: any) {
  const { app, routes } = fakeApp();
  registerYiddishCorpusRoutes({ app, db, requireOwner: allowingGate });
  return routes;
}

test("the gold routes are all registered and in the shared route table", () => {
  const routes = register(fakeDb());
  for (const r of YC_REGISTERED_ROUTES.filter((r) => r.path.includes("/gold") || r.path.includes("/finetune"))) {
    assert.ok(routes.has(`${r.method} ${r.path}`), `route table lists ${r.method} ${r.path} but nothing registered it`);
  }
});

const SOURCE_PLATFORM = {
  id: "src_platform",
  key: "internal",
  name: "Internal",
  kind: "INTERNAL_TABLE",
  governanceClass: "PLATFORM",
  trainingExportEligibility: "UNKNOWN",
  contentAllowed: true,
  audioFetchMode: "DISABLED",
  enabled: true,
};
const SOURCE_WALLED = {
  id: "src_voicemail",
  key: "voicemail",
  name: "Voicemail transcripts",
  kind: "INTERNAL_TABLE",
  governanceClass: "CUSTOMER_PRIVATE",
  trainingExportEligibility: "EXCLUDED",
  contentAllowed: false,
  audioFetchMode: "DISABLED",
  enabled: true,
};

test("GET /gold hides text and marks walled for a customer-private source without a recorded basis, and shows it for an allowed one", async () => {
  const rows = [
    {
      id: "rev_open",
      subjectId: "t_open",
      state: "OPEN",
      detail: { sourceKey: "internal", text: "readable text", confidence: 0.4, startMs: 0, endMs: 4000 },
      createdAt: new Date(),
    },
    {
      id: "rev_walled",
      subjectId: "t_walled",
      state: "OPEN",
      detail: { sourceKey: "voicemail", text: "secret customer text", confidence: 0.2, startMs: 0, endMs: 3000 },
      createdAt: new Date(),
    },
  ];
  const db = fakeDb({
    "ycReviewItem.findMany": rows,
    "ycSource.findMany": [SOURCE_PLATFORM, SOURCE_WALLED],
  });
  const routes = register(db);
  const handler = routes.get(`GET ${YC_API_PREFIX}/gold`)!;
  const reply = fakeReply();
  await handler({ query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  const open = reply.payload.items.find((i: any) => i.id === "rev_open");
  const walled = reply.payload.items.find((i: any) => i.id === "rev_walled");
  assert.equal(open.walled, false);
  assert.equal(open.text, "readable text");
  assert.equal(walled.walled, true);
  assert.equal(walled.text, null, "customer-private text must never be returned");
});

const OPEN_REVIEW_ITEM = {
  id: "rev_1",
  subjectType: "TRANSCRIPT",
  subjectId: "transcript_1",
  reason: "gold_candidate",
  state: "OPEN",
  detail: { itemId: "item_1", segmentId: "seg_1", startMs: 1000, endMs: 4000, text: "machine text", sourceKey: "internal", language: "yi" },
};

test("POST /gold/:reviewId/decide 'correct' writes a NEW human transcript row and never updates the machine row", async () => {
  const creates: any[] = [];
  const updates: any[] = [];
  const db = fakeDb({
    "ycReviewItem.findUnique": OPEN_REVIEW_ITEM,
    "ycTranscript.create": (a: any) => {
      creates.push(a);
      return { id: "human_row_1", ...a.data };
    },
    "ycTranscript.update": () => {
      updates.push("should not be called");
      throw new Error("the machine transcript row must never be updated by a 'correct' decision");
    },
    "ycReviewItem.update": (a: any) => ({ ...OPEN_REVIEW_ITEM, ...a.data }),
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/:reviewId/decide`)!;
  const reply = fakeReply();
  await handler({ params: { reviewId: "rev_1" }, body: { decision: "correct", text: "the corrected sentence" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(updates.length, 0);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].data.engine, "human");
  assert.equal(creates[0].data.text, "the corrected sentence");
  assert.equal(creates[0].data.confidence, 1);
  assert.equal(creates[0].data.originRef, "gold:rev_1");
  assert.equal(reply.payload.item.state, "EDITED");
  assert.equal(reply.payload.humanTranscriptId, "human_row_1");
});

test("POST /gold/:reviewId/decide 'correct' without text is refused, and writes nothing", async () => {
  const creates: any[] = [];
  const db = fakeDb({
    "ycReviewItem.findUnique": OPEN_REVIEW_ITEM,
    "ycTranscript.create": (a: any) => {
      creates.push(a);
      return { id: "x" };
    },
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/:reviewId/decide`)!;
  const reply = fakeReply();
  await handler({ params: { reviewId: "rev_1" }, body: { decision: "correct" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 400);
  assert.equal(creates.length, 0);
});

test("POST /gold/:reviewId/decide 'accept' writes the ORIGINAL machine text as the new human row, unmodified", async () => {
  const creates: any[] = [];
  const db = fakeDb({
    "ycReviewItem.findUnique": OPEN_REVIEW_ITEM,
    "ycTranscript.create": (a: any) => {
      creates.push(a);
      return { id: "human_row_2", ...a.data };
    },
    "ycReviewItem.update": (a: any) => ({ ...OPEN_REVIEW_ITEM, ...a.data }),
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/:reviewId/decide`)!;
  const reply = fakeReply();
  await handler({ params: { reviewId: "rev_1" }, body: { decision: "accept" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(creates[0].data.text, "machine text");
  assert.equal(reply.payload.item.state, "APPROVED");
});

test("POST /gold/:reviewId/decide 'reject' zeroes the machine row's confidence and never touches its text, and writes no human row", async () => {
  const updates: any[] = [];
  const creates: any[] = [];
  const db = fakeDb({
    "ycReviewItem.findUnique": OPEN_REVIEW_ITEM,
    "ycTranscript.update": (a: any) => {
      updates.push(a);
      return { id: "transcript_1", ...a.data };
    },
    "ycTranscript.create": (a: any) => {
      creates.push(a);
      throw new Error("a 'reject' decision must never write a human transcript row");
    },
    "ycReviewItem.update": (a: any) => ({ ...OPEN_REVIEW_ITEM, ...a.data }),
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/:reviewId/decide`)!;
  const reply = fakeReply();
  await handler({ params: { reviewId: "rev_1" }, body: { decision: "reject" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(creates.length, 0);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0].data), ["confidence"], "reject must update confidence only — never text");
  assert.equal(updates[0].data.confidence, 0);
  assert.equal(reply.payload.item.state, "REJECTED");
});

test("POST /gold/:reviewId/decide 'skip' writes nothing at all", async () => {
  const creates: any[] = [];
  const updates: any[] = [];
  const db = fakeDb({
    "ycReviewItem.findUnique": OPEN_REVIEW_ITEM,
    "ycTranscript.create": (a: any) => {
      creates.push(a);
      return { id: "x" };
    },
    "ycTranscript.update": (a: any) => {
      updates.push(a);
      return {};
    },
    "ycReviewItem.update": (a: any) => ({ ...OPEN_REVIEW_ITEM, ...a.data }),
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/:reviewId/decide`)!;
  const reply = fakeReply();
  await handler({ params: { reviewId: "rev_1" }, body: { decision: "skip" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(creates.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(reply.payload.item.state, "DEFERRED");
});

test("POST /gold/:reviewId/decide 404s for a review item that is not an open gold candidate", async () => {
  const db = fakeDb({ "ycReviewItem.findUnique": { ...OPEN_REVIEW_ITEM, reason: "some_other_reason" } });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/:reviewId/decide`)!;
  const reply = fakeReply();
  await handler({ params: { reviewId: "rev_1" }, body: { decision: "skip" }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 404);
});

test("POST /gold/sample creates review items only for transcripts with a stored asset and timing, and skips what is already sampled", async () => {
  const transcripts = [
    { id: "t1", itemId: "i1", startMs: 0, endMs: 4000, confidence: 0.1, text: "a", language: "yi", segmentId: null },
    { id: "t2", itemId: "i2", startMs: 0, endMs: 4000, confidence: 0.2, text: "b", language: "yi", segmentId: null },
    // no stored asset for i3 — must be dropped, not sampled
    { id: "t3", itemId: "i3", startMs: 0, endMs: 4000, confidence: 0.3, text: "c", language: "yi", segmentId: null },
  ];
  const items = [
    { id: "i1", sourceId: "s1" },
    { id: "i2", sourceId: "s1" },
    { id: "i3", sourceId: "s1" },
  ];
  const sources = [{ ...SOURCE_PLATFORM, id: "s1", key: "internal" }];
  const assets = [
    { id: "a1", itemId: "i1", storage: "STORED" },
    { id: "a2", itemId: "i2", storage: "STORED" },
  ];
  const created: any[] = [];
  const db = fakeDb({
    "ycTranscript.findMany": transcripts,
    "ycSourceItem.findMany": items,
    "ycSource.findMany": sources,
    "ycAudioAsset.findMany": assets,
    "ycReviewItem.findMany": [], // nothing already sampled
    "ycReviewItem.create": (a: any) => {
      created.push(a);
      return { id: `rev_${created.length}`, ...a.data };
    },
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/sample`)!;
  const reply = fakeReply();
  await handler({ body: { count: 10 }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.candidatePool, 2, "t3 has no stored asset and must not be a candidate");
  assert.equal(reply.payload.created, 2);
  const sampledIds = created.map((c) => c.data.subjectId).sort();
  assert.deepEqual(sampledIds, ["t1", "t2"]);
  for (const c of created) {
    assert.equal(c.data.subjectType, "TRANSCRIPT");
    assert.equal(c.data.reason, "gold_candidate");
    assert.equal(c.data.state, "OPEN");
    assert.equal(c.data.detail.sourceKey, "internal");
  }
});

test("POST /gold/sample is idempotent: a transcript already sampled is never sampled again", async () => {
  const transcripts = [{ id: "t1", itemId: "i1", startMs: 0, endMs: 4000, confidence: 0.1, text: "a", language: "yi", segmentId: null }];
  const items = [{ id: "i1", sourceId: "s1" }];
  const sources = [{ ...SOURCE_PLATFORM, id: "s1", key: "internal" }];
  const assets = [{ id: "a1", itemId: "i1", storage: "STORED" }];
  const created: any[] = [];
  const db = fakeDb({
    "ycTranscript.findMany": transcripts,
    "ycSourceItem.findMany": items,
    "ycSource.findMany": sources,
    "ycAudioAsset.findMany": assets,
    "ycReviewItem.findMany": [{ subjectId: "t1" }], // already sampled
    "ycReviewItem.create": (a: any) => {
      created.push(a);
      return { id: "rev_x", ...a.data };
    },
  });
  const routes = register(db);
  const handler = routes.get(`POST ${YC_API_PREFIX}/gold/sample`)!;
  const reply = fakeReply();
  await handler({ body: { count: 10 }, user: SUPER_ADMIN }, reply);
  assert.equal(reply.payload.created, 0);
  assert.equal(created.length, 0);
});

test("GET /gold/stats reports zeros honestly when nothing has been sampled", async () => {
  const db = fakeDb({
    "ycReviewItem.groupBy": [],
    "ycTranscript.findMany": [],
    "ycReviewItem.findMany": [],
  });
  const routes = register(db);
  const handler = routes.get(`GET ${YC_API_PREFIX}/gold/stats`)!;
  const reply = fakeReply();
  await handler({ query: {}, user: SUPER_ADMIN }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.open, 0);
  assert.equal(reply.payload.decided, 0);
  assert.equal(reply.payload.total, 0);
  assert.ok(reply.payload.note);
});

test("gold.ts has no Yiddish Labs import or call in its actual code — only in its own doc comments", () => {
  // Comments are allowed (and expected) to NAME the policy this file follows
  // ("never calls Yiddish Labs") — stripping them first is what makes this a
  // real guard on code rather than a check that fails on its own docstring.
  const fs = require("node:fs");
  const raw = fs.readFileSync(require.resolve("./gold"), "utf8");
  const codeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly.toLowerCase(), /yiddishlabs|yiddish-labs|yiddish_labs/);
});
