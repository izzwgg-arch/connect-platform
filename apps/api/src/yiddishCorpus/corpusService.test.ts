/**
 * Yiddish Corpus — corpus service, lexicon, internal indexer and retention.
 *
 * Everything runs against a small in-memory fake of the Prisma client that
 * RECORDS EVERY CALL. That recording is what makes the important assertion
 * possible: the internal indexer may count a customer-private table, and it
 * may never read one. A test that only checked the returned numbers would pass
 * while the indexer quietly selected 3,510 voicemail transcripts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  consensusFor,
  corpusCounts,
  fingerprintFor,
  recordAsset,
  recordObservation,
  recordSegments,
  recordTranscript,
  searchCorpus,
  upsertSourceItem,
} from "./corpusService";
import { classifyOrigin, ingestFingerprint, normalizeLexeme, tokenizeYiddish, upsertLexemesFromText } from "./lexicon";
import { reindexInternal } from "./internalIndexer";
import { applyRetention } from "./retention";
import { YcGovernanceError } from "./governance";

// ── A recording fake of the bits of Prisma these modules touch ───────────────

interface Call {
  model: string;
  op: string;
  args: any;
}

function matches(row: any, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries<any>(where)) {
    if (key === "NOT") {
      if (matches(row, cond)) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as any[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const value = row?.[key];
    if (cond === null) {
      if (value != null) return false;
    } else if (cond instanceof Date) {
      if (new Date(value).getTime() !== cond.getTime()) return false;
    } else if (cond && typeof cond === "object") {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("not" in cond) {
        if (cond.not === null) {
          if (value == null) return false;
        } else if (value === cond.not) return false;
      }
      if ("lte" in cond && !(value != null && new Date(value).getTime() <= new Date(cond.lte).getTime())) return false;
      if ("gte" in cond && !(value != null && new Date(value).getTime() >= new Date(cond.gte).getTime())) return false;
      if ("contains" in cond) {
        const hay = String(value ?? "").toLowerCase();
        if (!hay.includes(String(cond.contains).toLowerCase())) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function aggregateOf(rows: any[], args: any) {
  const out: any = {};
  if (args?._count) out._count = { _all: rows.length };
  if (args?._sum) {
    out._sum = {};
    for (const f of Object.keys(args._sum)) out._sum[f] = rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  }
  for (const key of ["_min", "_max"] as const) {
    if (!args?.[key]) continue;
    out[key] = {};
    for (const f of Object.keys(args[key])) {
      const values = rows.map((r) => r[f]).filter((v) => v != null).map((v) => new Date(v).getTime());
      out[key][f] = values.length ? new Date(key === "_min" ? Math.min(...values) : Math.max(...values)) : null;
    }
  }
  return out;
}

function makeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { ...seed };
  const calls: Call[] = [];
  let seq = 0;
  const uniqueKeys: Record<string, (row: any) => string | null> = {
    ycSource: (r) => `key:${r.key}`,
    ycSourceItem: (r) => `si:${r.sourceId}|${r.externalId}`,
    ycLexeme: (r) => `lx:${r.writtenForm}`,
    ycMetricSnapshot: (r) => `ms:${r.day}|${r.sourceKey}|${r.metric}`,
  };

  const model = (name: string) => {
    const rows = () => (tables[name] ??= []);
    const record = (op: string, args: any) => calls.push({ model: name, op, args });
    return {
      findUnique: async (args: any) => {
        record("findUnique", args);
        const where = args.where ?? {};
        // Compound unique keys arrive as a single nested object.
        const flat = where.sourceId_externalId ?? where.day_sourceKey_metric ?? where;
        return rows().find((r) => matches(r, flat)) ?? null;
      },
      findFirst: async (args: any) => {
        record("findFirst", args);
        return rows().find((r) => matches(r, args?.where)) ?? null;
      },
      findMany: async (args: any) => {
        record("findMany", args);
        let out = rows().filter((r) => matches(r, args?.where));
        if (args?.take) out = out.slice(0, args.take);
        return out.map((r) => ({ ...r }));
      },
      count: async (args: any) => {
        record("count", args);
        return rows().filter((r) => matches(r, args?.where)).length;
      },
      aggregate: async (args: any) => {
        record("aggregate", args);
        return aggregateOf(rows().filter((r) => matches(r, args?.where)), args);
      },
      create: async (args: any) => {
        record("create", args);
        const row = { id: `id-${++seq}`, createdAt: new Date(), discoveredAt: new Date(), ...args.data };
        const key = uniqueKeys[name]?.(row);
        if (key && rows().some((r) => uniqueKeys[name]!(r) === key)) {
          const err: any = new Error(`Unique constraint failed on ${name}`);
          err.code = "P2002";
          throw err;
        }
        rows().push(row);
        return { ...row };
      },
      createMany: async (args: any) => {
        record("createMany", args);
        for (const d of args.data) rows().push({ id: `id-${++seq}`, ...d });
        return { count: args.data.length };
      },
      update: async (args: any) => {
        record("update", args);
        const row = rows().find((r) => matches(r, args.where));
        if (!row) throw new Error(`${name}: no row to update`);
        for (const [k, v] of Object.entries<any>(args.data)) {
          if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
          else row[k] = v;
        }
        return { ...row };
      },
      upsert: async (args: any) => {
        record("upsert", args);
        const where = args.where ?? {};
        const flat = where.day_sourceKey_metric ?? where.sourceId_externalId ?? where;
        const row = rows().find((r) => matches(r, flat));
        if (row) {
          for (const [k, v] of Object.entries<any>(args.update)) {
            if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
            else row[k] = v;
          }
          return { ...row };
        }
        const created = { id: `id-${++seq}`, createdAt: new Date(), ...args.create };
        rows().push(created);
        return { ...created };
      },
    };
  };

  const db: any = new Proxy(
    { __tables: tables, __calls: calls },
    {
      get(target: any, prop: string) {
        if (prop in target) return target[prop];
        if (prop === "then") return undefined;
        return model(prop);
      },
    },
  );
  return { db, tables, calls };
}

const SRC = {
  external: {
    id: "src-ext",
    key: "yiddish24",
    name: "Yiddish24",
    kind: "EXTERNAL_ADAPTER",
    governanceClass: "EXTERNAL",
    contentAllowed: true,
    audioFetchMode: "DISABLED",
    trainingExportEligibility: "UNKNOWN",
  },
  private: {
    id: "src-vm",
    key: "voicemail",
    name: "Voicemail transcripts",
    kind: "INTERNAL_TABLE",
    governanceClass: "CUSTOMER_PRIVATE",
    contentAllowed: false,
    audioFetchMode: "DISABLED",
    trainingExportEligibility: "EXCLUDED",
  },
};

// ── Items and fingerprint dedupe ────────────────────────────────────────────

test("fingerprint dedupe marks the second item DUPLICATE and points at the first", async () => {
  const { db, tables } = makeDb({ ycSource: [{ ...SRC.external }] });
  const item = {
    externalId: "ep-1",
    title: "  Der Tog   Shiur ",
    durationSec: 1800,
    mediaUrl: "https://example.test/audio/1.mp3?token=abc",
    publishedLabel: "כ״ג אלול",
  };
  const first = await upsertSourceItem(db, "yiddish24", item);
  assert.equal(first.created, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.item.state, "DISCOVERED");

  // Same recording, new id, a different cache-busting token on the media URL.
  const second = await upsertSourceItem(db, "yiddish24", {
    ...item,
    externalId: "ep-1-reposted",
    mediaUrl: "https://example.test/audio/1.mp3?token=zzz",
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.item.state, "DUPLICATE");
  assert.equal(second.duplicateOfId, first.item.id);
  assert.equal(tables.ycSourceItem!.length, 2, "the duplicate is recorded, not thrown away");
});

test("the same externalId coming round again is a refresh, not a duplicate", async () => {
  const { db } = makeDb({ ycSource: [{ ...SRC.external }] });
  const first = await upsertSourceItem(db, "yiddish24", { externalId: "ep-9", title: "A", durationSec: 60 });
  // The pipeline has moved it on.
  await db.ycSourceItem.update({ where: { id: first.item.id }, data: { state: "TRANSCRIBED" } });
  const again = await upsertSourceItem(db, "yiddish24", { externalId: "ep-9", title: "A (updated)", durationSec: 60 });
  assert.equal(again.created, false);
  assert.equal(again.duplicate, false);
  assert.equal(again.item.state, "TRANSCRIBED", "a refresh must never reset the pipeline state");
  assert.equal(again.item.title, "A (updated)");
});

test("fingerprints ignore a cache-busting query string but not a different file", () => {
  const a = fingerprintFor({ externalId: "1", title: "X", durationSec: 10, mediaUrl: "https://h/a.mp3?t=1" });
  const b = fingerprintFor({ externalId: "2", title: "X", durationSec: 10, mediaUrl: "https://h/a.mp3?t=2" });
  const c = fingerprintFor({ externalId: "3", title: "X", durationSec: 10, mediaUrl: "https://h/b.mp3" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ── Transcripts: the provider is mandatory, and the wall holds ──────────────

test("recordTranscript refuses without an explicit sttProvider", async () => {
  const { db } = makeDb({
    ycSource: [{ ...SRC.external }],
    ycSourceItem: [{ id: "it-1", sourceId: "src-ext", externalId: "e1" }],
  });
  await assert.rejects(
    () => recordTranscript(db, { itemId: "it-1", engine: "openai", text: "א", sttProvider: undefined as any }),
    (err: unknown) => {
      assert.ok(err instanceof YcGovernanceError);
      assert.equal((err as YcGovernanceError).code, "STT_PROVIDER_REQUIRED");
      return true;
    },
  );
  // "unknown" is allowed — deliberately, and it costs the row its export.
  const row = await recordTranscript(db, { itemId: "it-1", engine: "stt-yi", text: "א", sttProvider: "unknown" });
  assert.equal(row.sttProvider, "unknown");
});

test("customer-private content cannot be written into the corpus either", async () => {
  const { db, tables } = makeDb({
    ycSource: [{ ...SRC.private }],
    ycSourceItem: [{ id: "it-p", sourceId: "src-vm", externalId: "vm1" }],
    ycLexeme: [],
  });
  await assert.rejects(
    () => recordTranscript(db, { itemId: "it-p", engine: "ivrit", text: "…", sttProvider: "ivrit" }),
    /counted, never read/i,
  );
  await assert.rejects(
    () =>
      recordObservation(db, {
        lexemeId: "lx-1",
        variantKey: "v1",
        sourceKey: "voicemail",
        evidenceKind: "ACOUSTIC_ALIGNED",
      }),
    /counted, never read/i,
  );
  await assert.rejects(
    () => recordAsset(db, { itemId: "it-p", storage: "STORED", storageKey: "a.wav" }),
    /counted, never read/i,
  );
  // A REFERENCE_ONLY asset is a pointer, not content — that one is allowed.
  const ref = await recordAsset(db, { itemId: "it-p", storage: "REFERENCE_ONLY", uri: "pbx://x" });
  assert.equal(ref.storage, "REFERENCE_ONLY");
  assert.equal((tables.ycTranscript ?? []).length, 0, "nothing textual was written");
});

test("segments and observations are stamped with their source", async () => {
  const { db } = makeDb({
    ycSource: [{ ...SRC.external }],
    ycSourceItem: [{ id: "it-1", sourceId: "src-ext", externalId: "e1" }],
  });
  const n = await recordSegments(db, "as-1", [
    { startMs: 0, endMs: 1000, klass: "SPEECH" },
    { startMs: 1000, endMs: 900 }, // backwards — dropped
  ]);
  assert.equal(n, 1);
  const o = await recordObservation(db, {
    lexemeId: "lx-1",
    variantKey: "v1",
    sourceKey: "yiddish24",
    evidenceKind: "ACOUSTIC_ALIGNED",
  });
  assert.equal(o.sourceKey, "yiddish24");
  assert.equal(o.sourceId, "src-ext");
});

// ── Consensus ───────────────────────────────────────────────────────────────

test("consensus refuses below the confidence floor, and says so", () => {
  const low = consensusFor([
    { engine: "ivrit", text: "א גוטן מארגן", confidence: 0.5 },
    { engine: "openai", text: "א גוטן מארגן", confidence: 0.55 },
  ]);
  assert.equal(low.text, null);
  assert.equal(low.reason, "no consensus: confidence too low");
  assert.deepEqual(low.engines, ["ivrit", "openai"]);
});

test("consensus needs two DIFFERENT engines, not two runs of one", () => {
  const same = consensusFor([
    { engine: "openai", text: "א גוטן מארגן", confidence: 0.95 },
    { engine: "openai", text: "א גוטן מארגן", confidence: 0.99 },
  ]);
  assert.equal(same.text, null);
  assert.match(same.reason ?? "", /two independent engines must agree/);
});

test("two engines above the floor agree, and disagreement is never deleted", () => {
  const input = [
    { engine: "ivrit", text: "א גוטן מארגן", confidence: 0.8 },
    { engine: "openai", text: " א גוטן   מארגן ", confidence: 0.9 },
    { engine: "yiddishlabs", text: "א גוטן מארגען", confidence: 0.95 },
  ];
  const c = consensusFor(input);
  assert.equal(c.text, "א גוטן מארגן");
  assert.deepEqual(c.engines, ["ivrit", "openai"]);
  assert.ok(c.meanConfidence >= 0.6);
  assert.equal(c.reason, null);
  assert.equal(input.length, 3, "consensusFor is a read: the losing reading is still there");
});

// ── Search: the wall, from the reader's side ────────────────────────────────

test("search never touches customer-private content and reports them as walled", async () => {
  const { db, calls } = makeDb({
    ycSource: [{ ...SRC.external }, { ...SRC.private }],
    ycSourceItem: [
      { id: "i1", sourceId: "src-ext", externalId: "e1", title: "Shiur about tefillah", state: "INDEXED", discoveredAt: new Date() },
      { id: "i2", sourceId: "src-vm", externalId: "vm1", title: "voicemail from a customer", state: "INDEXED", discoveredAt: new Date() },
    ],
  });
  const res = await searchCorpus(db, { q: "a" });
  assert.deepEqual(res.rows.map((r) => r.itemId), ["i1"]);
  assert.equal(res.walled.length, 1);
  assert.equal(res.walled[0]!.sourceKey, "voicemail");
  assert.equal(res.walled[0]!.count, 1);
  assert.match(res.walled[0]!.note, /counted, never read/i);

  // And the item query itself was scoped to readable sources — the private
  // source's id never appears in a findMany filter.
  const itemQueries = calls.filter((c) => c.model === "ycSourceItem" && c.op === "findMany");
  assert.ok(itemQueries.length > 0);
  for (const q of itemQueries) {
    assert.ok(!(q.args?.where?.sourceId?.in ?? []).includes("src-vm"));
  }
});

test("corpusCounts counts everything, including what it cannot read", async () => {
  const { db } = makeDb({
    ycSourceItem: [{ id: "a", state: "INDEXED" }, { id: "b", state: "DUPLICATE" }],
    ycTranscript: [{ id: "t" }],
    ycLexeme: [{ id: "l" }],
  });
  const counts = await corpusCounts(db);
  assert.equal(counts.items, 2);
  assert.equal(counts.duplicates, 1);
  assert.equal(counts.transcripts, 1);
  assert.equal(counts.lexemes, 1);
});

// ── Lexicon ─────────────────────────────────────────────────────────────────

test("tokenizing only ever slices — it never invents or alters a word", () => {
  const text = "  א גוטן, מארגן! ר״ל — hello 123  ";
  const tokens = tokenizeYiddish(text);
  assert.deepEqual(tokens, ["א", "גוטן", "מארגן", "ר״ל"]);
  for (const t of tokens) assert.ok(text.includes(t), `"${t}" must be a slice of the input`);

  const all = tokenizeYiddish(text, { keepNonHebrew: true });
  assert.ok(all.includes("hello"));
  assert.ok(all.includes("123"));
  assert.deepEqual(tokenizeYiddish(""), []);
  assert.deepEqual(tokenizeYiddish("...,!"), []);
});

test("origin classification is heuristic, and never claims a NAME", () => {
  assert.equal(classifyOrigin("123").origin, "NUMBER");
  assert.equal(classifyOrigin("hello").origin, "EN");
  assert.equal(classifyOrigin("ר״ל").origin, "ACRONYM");
  assert.equal(classifyOrigin("גוטן").origin, "YI");
  assert.equal(classifyOrigin("שבת").origin, "HE");
  for (const token of ["מאיר", "ברוקלין", "גוטן", "שבת", "hello", "123", "ר״ל"]) {
    assert.notEqual(classifyOrigin(token).origin, "NAME", "a NAME needs external evidence, never a shape guess");
    assert.ok(classifyOrigin(token).confidence <= 1);
    assert.ok(classifyOrigin(token).why.length > 0);
  }
});

test("normalizing strips niqqud for lookup but the written form is untouched", () => {
  const withNiqqud = "שַׁבָּת";
  assert.equal(normalizeLexeme(withNiqqud), "שבת");
  assert.notEqual(withNiqqud, normalizeLexeme(withNiqqud));
});

test("lexeme ingest is idempotent per (text, source, item) — frequency moves once", async () => {
  const { db, tables } = makeDb({ ycLexeme: [], ycMetricSnapshot: [] });
  const text = "א גוטן מארגן מארגן";
  const opts = { sourceKey: "yiddishlabs_cache", itemId: "tr-1" };

  const first = await upsertLexemesFromText(db, text, opts);
  assert.equal(first.alreadyIngested, false);
  assert.equal(first.lexemeIds.length, 3);
  const morgn = () => tables.ycLexeme!.find((l) => l.writtenForm === "מארגן");
  assert.equal(morgn()!.frequency, 2, "said twice in one text = frequency 2");

  const second = await upsertLexemesFromText(db, text, opts);
  assert.equal(second.alreadyIngested, true);
  assert.equal(second.lexemeIds.length, 3, "the ids still come back");
  assert.equal(morgn()!.frequency, 2, "a re-run must not double a counter");

  // A DIFFERENT item carrying the same text is a real second sighting.
  const other = await upsertLexemesFromText(db, text, { ...opts, itemId: "tr-2" });
  assert.equal(other.alreadyIngested, false);
  assert.equal(morgn()!.frequency, 4);

  assert.notEqual(ingestFingerprint(text, "a", "1"), ingestFingerprint(text, "a", "2"));
});

test("lexeme ingest refuses on a walled source", async () => {
  const { db } = makeDb({ ycLexeme: [] });
  await assert.rejects(
    () => upsertLexemesFromText(db, "א גוטן", { sourceKey: "voicemail", itemId: "x", source: SRC.private as any }),
    /counted, never read/i,
  );
});

// ── Internal indexer: counts only, proven by watching every call ────────────

const PRIVATE_MODELS = ["voicemail", "connectCdr", "supermarketOrderDraft", "agentConversation", "agentMessage", "connectChatMessage"];
const CONTENT_FIELDS = ["transcript", "text", "body", "content", "contentEn", "translation", "recordingPath", "localAudioPath", "pbxRecfile", "callerNumber", "callerName", "srcText", "outText", "items", "notes", "comments"];

function seededDb() {
  return makeDb({
    ycSource: [],
    ycMetricSnapshot: [],
    ycLexeme: [],
    voicemail: [
      { id: "v1", transcriptLanguage: "yi", durationSec: 3600, receivedAt: new Date("2026-07-01"), transcript: "SECRET" },
      { id: "v2", transcriptLanguage: "yi-en", durationSec: 1800, receivedAt: new Date("2026-09-01"), transcript: "SECRET" },
      { id: "v3", transcriptLanguage: "en", durationSec: 60, receivedAt: new Date("2026-09-02"), transcript: "SECRET" },
    ],
    connectCdr: [
      { id: "c1", recordingPath: "2026/07/01/a.wav", recordingMissingAt: null, talkSec: 7200, startedAt: new Date("2026-07-01") },
      { id: "c2", recordingPath: "2026/07/02/b.wav", recordingMissingAt: new Date(), talkSec: 60, startedAt: new Date("2026-07-02") },
    ],
    supermarketOrderDraft: [
      { id: "d1", transcript: "SECRET", createdAt: new Date("2026-08-01") },
      { id: "d2", transcript: "", createdAt: new Date("2026-08-02") },
    ],
    agentConversation: [{ id: "ac1", language: "yi", startedAt: new Date("2026-08-05") }],
    agentMessage: [{ id: "am1", conversationId: "ac1", content: "SECRET" }],
    connectChatMessage: [{ id: "cm1", type: "TEXT", body: "SECRET", createdAt: new Date("2026-08-09") }],
    agentTranslation: [
      { id: "tr1", action: "translate-yiddish", srcText: "good morning", outText: "א גוטן מארגן", updatedAt: new Date(), createdAt: new Date("2026-06-01") },
      { id: "tr2", action: "translate-english", srcText: "א גוטער שבת", outText: "a good sabbath", updatedAt: new Date(), createdAt: new Date("2026-06-02") },
    ],
  });
}

test("the indexer COUNTS customer-private tables and never reads one", async () => {
  const { db, calls } = seededDb();
  const res = await reindexInternal(db, { seedLexemes: true });

  const vm = res.sources.find((s) => s.key === "voicemail")!;
  assert.equal(vm.items, 2, "only yi / yi-en rows are counted");
  assert.equal(vm.audioHours, 1.5);
  assert.equal(vm.firstAt, new Date("2026-07-01").toISOString());
  assert.match(vm.note, /never read/i);

  const cdr = res.sources.find((s) => s.key === "call_recordings")!;
  assert.equal(cdr.items, 1, "a recording the PBX confirmed missing is not a recording");
  assert.equal(cdr.audioHours, 2);

  // ⛔ THE GUARD: every call against a private table is a count or an
  // aggregate, and no argument anywhere names a content field.
  const privateCalls = calls.filter((c) => PRIVATE_MODELS.includes(c.model));
  assert.ok(privateCalls.length > 0, "the indexer did look at them — it just counted");
  for (const c of privateCalls) {
    assert.ok(["count", "aggregate"].includes(c.op), `${c.model}.${c.op} reads rows from a walled table`);
    const args = JSON.stringify(c.args ?? {});
    for (const field of ["select", "include"]) {
      assert.ok(!args.includes(`"${field}"`), `${c.model}.${c.op} passed a ${field} — that is a read`);
    }
    for (const field of CONTENT_FIELDS) {
      // A field may appear as a COUNT filter (transcript: { not: "" }) but never
      // inside a select/include — checked above — and never as a sum/min/max.
      const inAggregate = new RegExp(`"_(sum|min|max)":\\{[^}]*"${field}"`).test(args);
      assert.ok(!inAggregate, `${c.model}.${c.op} aggregated the content field ${field}`);
    }
  }
  // And nothing walled was ever listed.
  assert.equal(calls.filter((c) => PRIVATE_MODELS.includes(c.model) && c.op === "findMany").length, 0);
});

test("the indexer MAY read the platform's own translation cache, and seeds lexemes from it", async () => {
  const { db, tables, calls } = seededDb();
  const res = await reindexInternal(db, { seedLexemes: true });
  const yl = res.sources.find((s) => s.key === "yiddishlabs_cache")!;
  assert.equal(yl.items, 2);
  assert.ok((yl.lexemesSeeded ?? 0) > 0);
  assert.ok(calls.some((c) => c.model === "agentTranslation" && c.op === "findMany"), "this one IS read, on purpose");

  const forms = tables.ycLexeme!.map((l) => l.writtenForm);
  assert.ok(forms.includes("מארגן"), "the Yiddish OUTPUT of translate-yiddish is the Yiddish");
  assert.ok(forms.includes("שבת"), "the Yiddish SOURCE of translate-english is the Yiddish");
  assert.ok(!forms.includes("good"), "the English side is not a Yiddish lexeme");

  // The source it registers is excluded from every export, permanently.
  const source = tables.ycSource!.find((s) => s.key === "yiddishlabs_cache")!;
  assert.equal(source.trainingExportEligibility, "EXCLUDED");
  assert.equal(source.governanceClass, "PLATFORM");
});

test("every internal source is registered walled-by-default, and counts are stored", async () => {
  const { db, tables } = seededDb();
  await reindexInternal(db);
  for (const s of tables.ycSource!) {
    assert.equal(s.contentAllowed, false, `${s.key} must start walled — the owner opens it, not the indexer`);
    assert.equal(s.audioFetchMode, "DISABLED");
    assert.equal(s.enabled, false);
    if (s.governanceClass === "CUSTOMER_PRIVATE") assert.equal(s.trainingExportEligibility, "EXCLUDED");
  }
  const snapshots = tables.ycMetricSnapshot!.filter((m) => m.metric === "internal_items");
  assert.ok(snapshots.length >= 6);
  assert.equal(snapshots.find((m) => m.sourceKey === "voicemail")!.value, 2);

  // Re-running is safe: the snapshot is upserted per day, not appended.
  await reindexInternal(db);
  assert.equal(tables.ycMetricSnapshot!.filter((m) => m.metric === "internal_items" && m.sourceKey === "voicemail").length, 1);
});

test("an absent source counts zero AND says it is absent — not an empty result", async () => {
  const { db } = seededDb();
  const res = await reindexInternal(db);
  const vl = res.sources.find((s) => s.key === "voicelab")!;
  assert.equal(vl.items, 0);
  assert.equal(vl.method, "absent");
  assert.match(vl.note, /not an empty result/i);
});

// ── Retention: audio bytes only ─────────────────────────────────────────────

function retentionDb(now: Date) {
  const past = new Date(now.getTime() - 86_400_000);
  const future = new Date(now.getTime() + 86_400_000);
  return makeDb({
    ycAudioAsset: [
      { id: "a-expired", itemId: "i1", storage: "STORED", storageKey: "a.wav", bytes: 100, kind: "EXTERNAL", retentionClass: "ORDINARY", expiresAt: past, deletedAt: null },
      { id: "a-golden", itemId: "i2", storage: "STORED", storageKey: "g.wav", bytes: 200, kind: "EXTERNAL", retentionClass: "GOLDEN", expiresAt: past, deletedAt: null },
      { id: "a-human", itemId: "i3", storage: "STORED", storageKey: "h.wav", bytes: 300, kind: "HUMAN_REFERENCE", retentionClass: "ORDINARY", expiresAt: past, deletedAt: null },
      { id: "a-corrected", itemId: "i4", storage: "STORED", storageKey: "c.wav", bytes: 400, kind: "EXTERNAL", retentionClass: "ORDINARY", expiresAt: past, deletedAt: null },
      { id: "a-fresh", itemId: "i5", storage: "STORED", storageKey: "f.wav", bytes: 500, kind: "EXTERNAL", retentionClass: "ORDINARY", expiresAt: future, deletedAt: null },
      { id: "a-noexpiry", itemId: "i6", storage: "STORED", storageKey: "n.wav", bytes: 600, kind: "EXTERNAL", retentionClass: "ORDINARY", expiresAt: null, deletedAt: null },
    ],
    ycReviewItem: [{ id: "rv1", subjectType: "asset", subjectId: "a-corrected", state: "REJECTED", decision: "REJECT_WITH_CORRECTION" }],
    ycTranscript: [{ id: "t1", itemId: "i1", text: "א גוטן מארגן", engine: "openai", sttProvider: "openai" }],
    ycSegment: [{ id: "s1", assetId: "a-expired", startMs: 0, endMs: 100 }],
    ycPronunciationObservation: [{ id: "o1", lexemeId: "l1", itemId: "i1", variantKey: "v", sourceKey: "yiddish24" }],
    ycLexeme: [{ id: "l1", writtenForm: "מארגן", frequency: 1 }],
    ycFinding: [],
    ycMetricSnapshot: [],
  });
}

test("retention deletes expired audio bytes and nothing else", async () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const { db, tables } = retentionDb(now);
  const removed: string[] = [];

  const res = await applyRetention(db, now, {
    deleteFile: async (asset) => {
      removed.push(asset.storageKey!);
      return true;
    },
  });

  assert.deepEqual(res.deleted.map((d) => d.assetId), ["a-expired"]);
  assert.deepEqual(removed, ["a.wav"]);
  assert.equal(res.errors.length, 0);

  const asset = tables.ycAudioAsset!.find((a) => a.id === "a-expired")!;
  assert.equal(asset.storage, "REFERENCE_ONLY");
  assert.equal(asset.storageKey, null);
  assert.ok(asset.deletedAt);
  assert.match(asset.deleteReason, /retention/);

  // ⛔ Nothing textual moved. This is the whole promise of the design.
  assert.equal(res.textDeleted, 0);
  assert.equal(tables.ycTranscript!.length, 1);
  assert.equal(tables.ycTranscript![0]!.text, "א גוטן מארגן");
  assert.equal(tables.ycSegment!.length, 1);
  assert.equal(tables.ycPronunciationObservation!.length, 1);
  assert.equal(tables.ycLexeme!.length, 1);
  assert.equal(tables.ycAudioAsset!.length, 6, "the asset ROW stays, so provenance still answers");
});

test("retention never touches golden, human-reference or corrected audio", async () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const { db, tables } = retentionDb(now);
  await applyRetention(db, now, { deleteFile: async () => true });

  for (const id of ["a-golden", "a-human", "a-corrected", "a-fresh", "a-noexpiry"]) {
    const a = tables.ycAudioAsset!.find((x) => x.id === id)!;
    assert.equal(a.deletedAt, null, `${id} must survive`);
    assert.equal(a.storage, "STORED");
    assert.ok(a.storageKey);
  }
});

test("retention writes a deletion log naming what it removed", async () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const { db, tables } = retentionDb(now);
  await applyRetention(db, now, { deleteFile: async () => true });

  assert.equal(tables.ycFinding!.length, 1);
  const log = tables.ycFinding![0]!;
  assert.equal(log.kind, "retention");
  assert.deepEqual(log.evidence.deletedAssetIds, ["a-expired"]);
  assert.match(log.statement, /No text, ratings or corrections were deleted/);
  assert.equal(tables.ycMetricSnapshot!.find((m) => m.metric === "retention_audio_deleted")!.value, 1);
});

test("a dry run reports exactly what the real run would do, and writes nothing", async () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const { db, tables } = retentionDb(now);
  let touched = false;
  const res = await applyRetention(db, now, { dryRun: true, deleteFile: async () => ((touched = true), true) });

  assert.equal(res.dryRun, true);
  assert.deepEqual(res.deleted.map((d) => d.assetId), ["a-expired"]);
  assert.equal(touched, false, "a dry run never removes a byte");
  assert.equal(tables.ycFinding!.length, 0);
  assert.equal(tables.ycAudioAsset!.find((a) => a.id === "a-expired")!.deletedAt, null);
  assert.ok(res.protectedAssets.some((p) => p.assetId === "a-corrected"));
});
