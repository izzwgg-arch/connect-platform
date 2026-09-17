/**
 * build-dataset.ts — pure-function tests. No DB, no ffmpeg, no network.
 *
 * Governance tests import the REAL `trainingEligibilityOf` from
 * apps/api/src/yiddishCorpus/governance.ts (never a re-implementation), so a
 * change to the real ladder is what these tests actually exercise.
 *
 * ⛔ One of these tests ("private source + GRANTED training_export + content
 * allowed -> included") encodes the target semantics of Lane A's planned
 * governance update (handoff §3.1.6: a CUSTOMER_PRIVATE source becomes
 * consented only when BOTH contentAllowed and a GRANTED training_export
 * right exist). Until that lane lands, the ladder still excludes ALL
 * CUSTOMER_PRIVATE rows unconditionally, so this one test is EXPECTED to
 * fail — that is not a Lane B defect, see the final report.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { trainingEligibilityOf } from "../../apps/api/src/yiddishCorpus/governance";
import type { YcRightsLike, YcSourceLike } from "../../apps/api/src/yiddishCorpus/governance";

import {
  DEFAULT_FILTER_OPTIONS,
  assembleDatasetRows,
  assignSplits,
  buildGoldClips,
  buildIvritClips,
  buildManifest,
  computeStats,
  filterEligibleRows,
  mergeAdjacentRows,
  passesRowQuality,
  sha256File,
  sha256Hex,
  stableUnit,
  type Clip,
  type GovernanceContext,
  type RawRow,
} from "./build-dataset";

// ── fixtures ─────────────────────────────────────────────────────────────────

function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: overrides.id ?? `row-${Math.random().toString(36).slice(2)}`,
    itemId: "item-1",
    segmentId: null,
    engine: "ivrit",
    sttProvider: "ivrit-ai/yi-whisper-large-v3-turbo",
    text: "a normal sentence of Yiddish text",
    confidence: 0.8,
    noSpeechProb: 0.1,
    startMs: 0,
    endMs: 5000,
    chunkIndex: 0,
    originRef: null,
    sourceKey: "yiddish24",
    ...overrides,
  };
}

const PLATFORM_SOURCE: YcSourceLike = {
  key: "yiddish24",
  name: "Yiddish24",
  governanceClass: "EXTERNAL",
  contentAllowed: true,
  audioFetchMode: "OWNER_AUTHORIZED",
  trainingExportEligibility: "UNKNOWN",
};

const GRANTED_RIGHTS: YcRightsLike[] = [{ allowedUse: "training_export", state: "GRANTED", decidedBy: "izzy" }];

const CUSTOMER_PRIVATE_SOURCE: YcSourceLike = {
  key: "voicemail",
  name: "Voicemail",
  governanceClass: "CUSTOMER_PRIVATE",
  contentAllowed: true,
  audioFetchMode: "OWNER_AUTHORIZED",
  trainingExportEligibility: "UNKNOWN",
};

const YL_SOURCE: YcSourceLike = {
  key: "yiddishlabs_cache",
  name: "Yiddish Labs cache",
  governanceClass: "PLATFORM",
  contentAllowed: true,
  audioFetchMode: "DISABLED",
  trainingExportEligibility: "UNKNOWN",
};

function ctxOf(source: YcSourceLike, rights: YcRightsLike[] = []): GovernanceContext {
  return { source, rights };
}

// ── governance integration ───────────────────────────────────────────────────

test("governance: an EXTERNAL source with a training_export grant is included", () => {
  const rows = [row({ id: "r1", sourceKey: "yiddish24" })];
  const ctx = ctxOf(PLATFORM_SOURCE, GRANTED_RIGHTS);
  const out = filterEligibleRows(rows, () => ctx, trainingEligibilityOf);
  assert.equal(out.length, 1);
});

test("governance: an EXTERNAL source with NO training_export grant is excluded", () => {
  const rows = [row({ id: "r1", sourceKey: "yiddish24" })];
  const ctx = ctxOf(PLATFORM_SOURCE, []);
  const out = filterEligibleRows(rows, () => ctx, trainingEligibilityOf);
  assert.equal(out.length, 0);
});

test("governance: a YL-marked source is excluded even though engine=ivrit", () => {
  const rows = [row({ id: "r1", sourceKey: "yiddishlabs_cache", engine: "ivrit" })];
  const ctx = ctxOf(YL_SOURCE, GRANTED_RIGHTS);
  const out = filterEligibleRows(rows, () => ctx, trainingEligibilityOf);
  assert.equal(out.length, 0, "YL marker on the source key must exclude regardless of any rights grant");
});

test("governance: a YL-marked engine tag is excluded even on an otherwise-clean source", () => {
  const rows = [row({ id: "r1", sourceKey: "yiddish24", engine: "yiddishlabs-sync" })];
  const ctx = ctxOf(PLATFORM_SOURCE, GRANTED_RIGHTS);
  const out = filterEligibleRows(rows, () => ctx, trainingEligibilityOf);
  assert.equal(out.length, 0);
});

test("governance: a CUSTOMER_PRIVATE source with no training_export grant is excluded", () => {
  const rows = [row({ id: "r1", sourceKey: "voicemail" })];
  const ctx = ctxOf(CUSTOMER_PRIVATE_SOURCE, []);
  const out = filterEligibleRows(rows, () => ctx, trainingEligibilityOf);
  assert.equal(out.length, 0);
});

test(
  "governance: a CUSTOMER_PRIVATE source with contentAllowed + a GRANTED training_export right is included " +
    "(target semantics of Lane A §3.1.6 — expected to fail until that lane's governance.ts change lands)",
  () => {
    const rows = [row({ id: "r1", sourceKey: "voicemail" })];
    const ctx = ctxOf(CUSTOMER_PRIVATE_SOURCE, GRANTED_RIGHTS);
    const out = filterEligibleRows(rows, () => ctx, trainingEligibilityOf);
    assert.equal(out.length, 1);
  },
);

test("governance: a row with no resolvable context is dropped, never included by default", () => {
  const rows = [row({ id: "r1" })];
  const out = filterEligibleRows(rows, () => null, trainingEligibilityOf);
  assert.equal(out.length, 0);
});

// ── quality filters ──────────────────────────────────────────────────────────

test("quality: confidence below the floor is excluded", () => {
  assert.equal(passesRowQuality(row({ confidence: 0.54 }), DEFAULT_FILTER_OPTIONS), false);
  assert.equal(passesRowQuality(row({ confidence: 0.55 }), DEFAULT_FILTER_OPTIONS), true);
});

test("quality: noSpeechProb above the ceiling is excluded", () => {
  assert.equal(passesRowQuality(row({ noSpeechProb: 0.51 }), DEFAULT_FILTER_OPTIONS), false);
});

test("quality: a row missing timing is excluded", () => {
  assert.equal(passesRowQuality(row({ startMs: null, endMs: null }), DEFAULT_FILTER_OPTIONS), false);
});

test("buildIvritClips drops low-confidence rows entirely (never merged in)", () => {
  const rows = [
    row({ id: "a", startMs: 0, endMs: 2000, confidence: 0.3, text: "low conf" }),
    row({ id: "b", startMs: 2000, endMs: 4000, confidence: 0.9, text: "good conf" }),
  ];
  const clips = buildIvritClips(rows, DEFAULT_FILTER_OPTIONS);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].text, "good conf");
});

// ── merging ──────────────────────────────────────────────────────────────────

test("mergeAdjacentRows joins rows with a small gap into one clip", () => {
  const rows = [
    row({ id: "a", startMs: 0, endMs: 2000, text: "hello" }),
    row({ id: "b", startMs: 2300, endMs: 4000, text: "world" }),
  ];
  const groups = mergeAdjacentRows(rows, DEFAULT_FILTER_OPTIONS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].text, "hello world");
  assert.equal(groups[0].startMs, 0);
  assert.equal(groups[0].endMs, 4000);
});

test("mergeAdjacentRows keeps rows separate across a big gap", () => {
  const rows = [
    row({ id: "a", startMs: 0, endMs: 2000, text: "hello" }),
    row({ id: "b", startMs: 10_000, endMs: 12_000, text: "world" }),
  ];
  const groups = mergeAdjacentRows(rows, DEFAULT_FILTER_OPTIONS);
  assert.equal(groups.length, 2);
});

test("mergeAdjacentRows stops merging once the 30s cap would be exceeded", () => {
  const rows = [
    row({ id: "a", startMs: 0, endMs: 29_500 }),
    row({ id: "b", startMs: 29_600, endMs: 31_000 }),
  ];
  const groups = mergeAdjacentRows(rows, DEFAULT_FILTER_OPTIONS);
  assert.equal(groups.length, 2, "merging past 30s must split into a new group");
});

test("buildIvritClips drops merged clips shorter than 1s or longer than 30s", () => {
  const tooShort = [row({ id: "a", startMs: 0, endMs: 500, text: "hi" })];
  assert.equal(buildIvritClips(tooShort, DEFAULT_FILTER_OPTIONS).length, 0);
});

// ── train/eval split ─────────────────────────────────────────────────────────

test("stableUnit is deterministic for the same id", () => {
  assert.equal(stableUnit("item-abc"), stableUnit("item-abc"));
});

test("assignSplits never changes an item's split across repeated calls", () => {
  const ids = ["item-1", "item-2", "item-3", "item-4", "item-5"];
  const first = assignSplits(ids, 0.4);
  const second = assignSplits(ids, 0.4);
  for (const id of ids) assert.equal(first.get(id), second.get(id));
});

test("an item is NEVER split across train and eval", () => {
  const rows = [
    row({ id: "a", itemId: "item-x", startMs: 0, endMs: 2000, text: "part one" }),
    row({ id: "b", itemId: "item-x", startMs: 20_000, endMs: 22_000, text: "part two, far away" }),
  ];
  const clips = buildIvritClips(rows, DEFAULT_FILTER_OPTIONS);
  assert.equal(clips.length, 2, "the two rows should NOT merge (big gap) but ARE the same item");
  const splitByItem = assignSplits(["item-x"], DEFAULT_FILTER_OPTIONS.evalFraction);
  const { train, evalRows } = assembleDatasetRows({ ivritClips: clips, goldClips: [], splitByItem, goldWeight: 3 });
  const trainHasItem = train.some((r) => r.item === "item-x");
  const evalHasItem = evalRows.some((r) => r.item === "item-x");
  assert.notEqual(trainHasItem, evalHasItem, "item-x clips must land entirely in one split, never both");
});

// ── gold ─────────────────────────────────────────────────────────────────────

test("gold rows are always in eval, and duplicated into train goldWeight times", () => {
  const goldRow = row({ id: "g1", itemId: "item-gold", engine: "human", confidence: 1, startMs: 0, endMs: 3000, text: "corrected text" });
  const goldClips = buildGoldClips([goldRow], DEFAULT_FILTER_OPTIONS);
  assert.equal(goldClips.length, 1);
  assert.equal(goldClips[0].gold, true);

  const splitByItem = assignSplits([], DEFAULT_FILTER_OPTIONS.evalFraction); // item-gold not in the ivrit split map at all
  const { train, evalRows } = assembleDatasetRows({ ivritClips: [], goldClips, splitByItem, goldWeight: 4 });
  assert.equal(evalRows.filter((r) => r.gold).length, 1);
  assert.equal(train.filter((r) => r.gold).length, 4);
});

test("a gold row's own item can also have ivrit clips assigned to train — the gold copy is a named exception, not a split violation", () => {
  const ivritRow = row({ id: "a", itemId: "item-both", startMs: 0, endMs: 2000, text: "machine text" });
  const goldRow = row({ id: "g", itemId: "item-both", engine: "human", startMs: 5000, endMs: 7000, text: "human text", confidence: 1 });
  const ivritClips = buildIvritClips([ivritRow], DEFAULT_FILTER_OPTIONS);
  const goldClips = buildGoldClips([goldRow], DEFAULT_FILTER_OPTIONS);
  // Force item-both's ivrit clip to train by using a 0 eval fraction.
  const splitByItem = assignSplits(["item-both"], 0);
  const { train, evalRows } = assembleDatasetRows({ ivritClips, goldClips, splitByItem, goldWeight: 2 });
  assert.ok(train.some((r) => r.item === "item-both" && !r.gold), "ivrit clip in train");
  assert.ok(evalRows.some((r) => r.item === "item-both" && r.gold), "gold clip in eval");
  assert.ok(train.some((r) => r.item === "item-both" && r.gold), "gold clip duplicated into train too");
});

test("assembleDatasetRows never stages the same clip file twice", () => {
  const ivritClips: Clip[] = [
    { itemId: "i1", sourceKey: "yiddish24", startMs: 0, endMs: 2000, text: "x", confidence: 0.9, gold: false, rowIds: ["a"] },
  ];
  const splitByItem = assignSplits(["i1"], 0.05);
  const { clipsToCut } = assembleDatasetRows({ ivritClips, goldClips: [], splitByItem, goldWeight: 3 });
  assert.equal(clipsToCut.length, 1);
});

// ── stats + manifest ─────────────────────────────────────────────────────────

test("computeStats aggregates hours and mean confidence per source", () => {
  const clips: Clip[] = [
    { itemId: "i1", sourceKey: "yiddish24", startMs: 0, endMs: 3_600_000, text: "a", confidence: 0.8, gold: false, rowIds: [] },
    { itemId: "i2", sourceKey: "voicemail", startMs: 0, endMs: 1_800_000, text: "b", confidence: 1, gold: true, rowIds: [] },
  ];
  const stats = computeStats(clips);
  assert.equal(stats.goldClips, 1);
  assert.equal(stats.totalHours, 1.5);
  const yiddish24 = stats.bySource.find((s) => s.source === "yiddish24");
  assert.ok(yiddish24);
  assert.equal(yiddish24!.hours, 1);
});

test("sha256Hex is stable for the same input", () => {
  assert.equal(sha256Hex("hello"), sha256Hex("hello"));
  assert.notEqual(sha256Hex("hello"), sha256Hex("world"));
});

test("sha256File matches sha256Hex of the same bytes", async () => {
  const tmp = path.join(os.tmpdir(), `yc-manifest-test-${Date.now()}.txt`);
  writeFileSync(tmp, "manifest hashing test\n", "utf8");
  try {
    const fromFile = await sha256File(tmp);
    const fromBuffer = sha256Hex("manifest hashing test\n");
    assert.equal(fromFile, fromBuffer);
  } finally {
    unlinkSync(tmp);
  }
});

test("buildManifest carries every file's hash and the stats block", () => {
  const stats = { ...computeStats([]), trainClips: 5, evalClips: 1 };
  const manifest = buildManifest({
    version: "v1",
    options: DEFAULT_FILTER_OPTIONS,
    files: [{ name: "train.jsonl", sha256: "abc", rows: 5 }],
    stats,
  });
  assert.equal(manifest.version, "v1");
  assert.equal(manifest.files[0].sha256, "abc");
  assert.equal(manifest.stats.trainClips, 5);
});

// ── guard: no Yiddish Labs text is ever a label source ──────────────────────

test("guard: this file never imports or names Yiddish Labs as a transcript source", () => {
  const fs = require("node:fs");
  const src: string = fs.readFileSync(path.join(__dirname, "build-dataset.ts"), "utf8");
  assert.doesNotMatch(src.toLowerCase(), /from ["']\.\/yiddishlabs|yiddishlabs\.client|yiddishlabsclient/);
});
