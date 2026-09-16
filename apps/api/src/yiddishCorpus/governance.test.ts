/**
 * Yiddish Corpus — governance guard tests.
 *
 * These are the walls. If one of these ever goes green-to-red, the fix is the
 * code, never the test: each one stands for a promise made to a customer or to
 * Yiddish Labs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAudioFetchAllowed,
  assertContentReadable,
  canReadContent,
  exclusionBreakdown,
  filterExportable,
  governanceBadge,
  isYlDerived,
  trainingEligibilityOf,
  YcGovernanceError,
  type YcRightsLike,
  type YcSourceLike,
} from "./governance";
import { YC_AUDIO_BLOCKED_MESSAGE } from "./contracts";

const privateSource: YcSourceLike = {
  key: "voicemail",
  name: "Voicemail transcripts",
  governanceClass: "CUSTOMER_PRIVATE",
  contentAllowed: false,
  audioFetchMode: "DISABLED",
  trainingExportEligibility: "EXCLUDED",
};

const platformSource: YcSourceLike = {
  key: "voicelab",
  name: "Voice Lab",
  governanceClass: "PLATFORM",
  contentAllowed: true,
  audioFetchMode: "DISABLED",
  trainingExportEligibility: "UNKNOWN",
};

const externalSource: YcSourceLike = {
  key: "yiddish24",
  name: "Yiddish24",
  governanceClass: "EXTERNAL",
  contentAllowed: true,
  audioFetchMode: "DISABLED",
  trainingExportEligibility: "UNKNOWN",
};

const granted = (allowedUse: string): YcRightsLike => ({ allowedUse, state: "GRANTED", decidedBy: "izzy" });

// ── Wall 1: the customer wall ────────────────────────────────────────────────

test("customer-private content cannot be read", () => {
  assert.equal(canReadContent(privateSource), false);
  assert.throws(() => assertContentReadable(privateSource), (err: unknown) => {
    assert.ok(err instanceof YcGovernanceError);
    assert.equal((err as YcGovernanceError).code, "CUSTOMER_WALL");
    assert.match((err as Error).message, /counted, never read/i);
    return true;
  });
});

test("counting a private source is always fine — only reading is walled", () => {
  // The wall is about CONTENT. Nothing here refuses a count, and the badge
  // says so: the class is reported, the content flag is false, no throw.
  const badge = governanceBadge(privateSource);
  assert.equal(badge.governanceClass, "CUSTOMER_PRIVATE");
  assert.equal(badge.contentAllowed, false);
  assert.equal(badge.trainingExportEligibility, "EXCLUDED");
});

test("an owner-recorded basis opens the customer wall, and only then", () => {
  const withBasis: YcSourceLike = { ...privateSource, contentAllowed: true };
  assert.equal(canReadContent(withBasis), true);
  assert.doesNotThrow(() => assertContentReadable(withBasis));
  // …but it is STILL excluded from a training export. Two different questions.
  assert.equal(trainingEligibilityOf(withBasis).eligibility, "EXCLUDED");
});

test("customer-private rows can never be exported, not even a human one", () => {
  const verdict = trainingEligibilityOf(privateSource, {
    row: { engine: "human", evidenceKind: "HUMAN", consented: true, sttProvider: "human" },
  });
  assert.equal(verdict.eligibility, "EXCLUDED");
  assert.equal(verdict.primaryReason, "CUSTOMER_PRIVATE");
});

// ── Wall 2: Yiddish Labs is serving-only, and so is "we cannot prove it" ─────

test("a legacy stt-yi row with an unknown provider is treated as YL-derived", () => {
  // The 3,510 voicemail transcripts: YL-first with an ivrit fallback in a bare
  // catch. Nothing per row says which answered — so it counts as YL.
  assert.equal(isYlDerived({ engine: "stt-yi", sttProvider: null }), true);
  assert.equal(isYlDerived({ engine: "stt-yi", sttProvider: "unknown" }), true);
  assert.equal(isYlDerived({ engine: "stt-yi", sttProvider: "" }), true);
  // A named, non-YL provider IS proof — somebody recorded it.
  assert.equal(isYlDerived({ engine: "stt-yi", sttProvider: "ivrit" }), false);
  // And an explicit YL tag anywhere is decisive.
  assert.equal(isYlDerived({ engine: "yiddishlabs" }), true);
  assert.equal(isYlDerived({ engine: "openai", sttProvider: "yiddish-labs" }), true);
  assert.equal(isYlDerived({ engine: "openai", sttProvider: "openai" }), false);
  // "yl" as a substring must not fire on ordinary words.
  assert.equal(isYlDerived({ engine: "openly-licensed" }), false);
  assert.equal(isYlDerived({ engine: "yl" }), true);
});

test("an unprovable-provider row on a PLATFORM source is still excluded", () => {
  const verdict = trainingEligibilityOf(platformSource, {
    row: { engine: "stt-yi", sttProvider: "unknown", evidenceKind: "ACOUSTIC_ALIGNED" },
  });
  assert.equal(verdict.eligibility, "EXCLUDED");
  assert.equal(verdict.primaryReason, "YL_DERIVED");
  assert.match(verdict.note, /serving-only/i);
});

test("a human row on a platform source is the one thing that IS exportable", () => {
  const verdict = trainingEligibilityOf(platformSource, {
    row: { engine: "human", sttProvider: "human", evidenceKind: "HUMAN" },
  });
  assert.equal(verdict.eligibility, "ALLOWED");
  assert.equal(verdict.primaryReason, null);
});

test("a machine row with no consent is kept but never exported", () => {
  const verdict = trainingEligibilityOf(platformSource, {
    row: { engine: "openai", sttProvider: "openai", evidenceKind: "ACOUSTIC_ALIGNED" },
  });
  assert.equal(verdict.eligibility, "RESTRICTED");
  assert.equal(verdict.primaryReason, "NOT_HUMAN_OR_CONSENTED");
});

// ── Wall 3: external audio needs BOTH gates ─────────────────────────────────

test("audio fetch refuses without BOTH the mode and the grant", () => {
  const rights = [granted("analysis")];

  // Neither.
  assert.deepEqual(assertAudioFetchAllowed(externalSource, []), { ok: false, reason: YC_AUDIO_BLOCKED_MESSAGE });
  // Grant but no mode.
  assert.equal(assertAudioFetchAllowed(externalSource, rights).ok, false);
  // Mode but no grant.
  const armed: YcSourceLike = { ...externalSource, audioFetchMode: "OWNER_AUTHORIZED" };
  assert.equal(assertAudioFetchAllowed(armed, []).ok, false);
  // A grant that is not GRANTED.
  assert.equal(assertAudioFetchAllowed(armed, [{ allowedUse: "analysis", state: "UNKNOWN" }]).ok, false);
  // The wrong kind of grant (metadata only).
  assert.equal(assertAudioFetchAllowed(armed, [granted("metadata_only")]).ok, false);
  // Both gates open.
  assert.deepEqual(assertAudioFetchAllowed(armed, rights), { ok: true, reason: null });
  assert.equal(assertAudioFetchAllowed(armed, [granted("store_audio")]).ok, true);
});

test("the refusal is the plain-English one the screen shows, and never mentions a workaround", () => {
  const decision = assertAudioFetchAllowed(externalSource, []);
  assert.equal(decision.reason, YC_AUDIO_BLOCKED_MESSAGE);
  assert.match(decision.reason!, /We do not work around that/);
});

test("an external source needs a training_export grant before anything exports", () => {
  assert.equal(trainingEligibilityOf(externalSource, { rights: [granted("analysis")] }).primaryReason, "NO_EXTERNAL_RIGHTS");
  assert.equal(trainingEligibilityOf(externalSource, { rights: [granted("training_export")] }).eligibility, "ALLOWED");
});

// ── The export filter and an honest breakdown ───────────────────────────────

test("filterExportable lets only ALLOWED rows out", () => {
  const rows = [
    { row: "private", source: privateSource, provenance: { engine: "human", evidenceKind: "HUMAN" } },
    { row: "yl", source: platformSource, provenance: { engine: "stt-yi", sttProvider: "unknown" } },
    { row: "machine", source: platformSource, provenance: { engine: "openai", sttProvider: "openai" } },
    { row: "human", source: platformSource, provenance: { engine: "human", evidenceKind: "HUMAN" } },
    { row: "granted-external", source: externalSource, rights: [granted("training_export")] },
  ];
  assert.deepEqual(filterExportable(rows), ["human", "granted-external"]);
});

test("a row excluded for several reasons is counted ONCE in the breakdown", () => {
  // Private AND YL-derived AND source-marked-excluded: three reasons, one row.
  const rows = [
    { row: 1, source: privateSource, provenance: { engine: "stt-yi", sttProvider: null } },
    { row: 2, source: privateSource, provenance: { engine: "stt-yi", sttProvider: null } },
    { row: 3, source: platformSource, provenance: { engine: "yiddishlabs" } },
    { row: 4, source: platformSource, provenance: { engine: "human", evidenceKind: "HUMAN" } },
    { row: 5, source: externalSource },
  ];
  const b = exclusionBreakdown(rows);
  assert.equal(b.total, 5);
  assert.equal(b.exportable, 1);
  assert.equal(b.excluded, 4);
  const summed = b.byReason.reduce((s, r) => s + r.count, 0);
  assert.equal(summed, b.excluded, "the reason counts must add up to the excluded total, never more");
  const byName = Object.fromEntries(b.byReason.map((r) => [r.reason, r.count]));
  assert.equal(byName.CUSTOMER_PRIVATE, 2);
  assert.equal(byName.YL_DERIVED, 1);
  assert.equal(byName.NO_EXTERNAL_RIGHTS, 1);
});

test("the badge tells a screen everything it needs to refuse to show a row", () => {
  const badge = governanceBadge(privateSource, { engine: "stt-yi", sttProvider: null });
  assert.equal(badge.contentAllowed, false);
  assert.equal(badge.ylDerived, true);
  assert.equal(badge.trainingExportEligibility, "EXCLUDED");
  assert.match(badge.note ?? "", /counted, never read/i);
  assert.match(badge.note ?? "", /serving-only/i);
});
