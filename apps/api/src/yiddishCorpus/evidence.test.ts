/**
 * Yiddish Corpus — evidence tests.
 *
 * The headline is the saturation test: one speaker repeating a word 500 times
 * must not outweigh ten speakers saying it ten times. That is the difference
 * between learning an accent and learning one man's habit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { conflictsFor, excludeSources, scoreVariants, weightForSource, type YcObservationLike } from "./evidence";
import { YC_RULE_SCORE_THRESHOLD, YC_SPEAKER_SATURATION } from "./contracts";

function obs(
  variantKey: string,
  sourceKey: string,
  speaker: string | null,
  n: number,
  evidenceKind: string = "ACOUSTIC_ALIGNED",
  confidence = 1,
): YcObservationLike[] {
  return Array.from({ length: n }, () => ({ variantKey, sourceKey, speakerClusterId: speaker, confidence, evidenceKind }));
}

test("one speaker's flood is capped; ten speakers outweigh it", () => {
  const flood = obs("A", "yiddish24", "spk-1", 500);
  const crowd = Array.from({ length: 10 }, (_, i) => obs("B", "yiddish24", `spk-${i + 10}`, 10)).flat();
  const [top] = scoreVariants([...flood, ...crowd], { minSamplesForConclusion: 0 });
  assert.equal(top!.variantKey, "B", "ten speakers must beat one speaker repeating himself");

  const byKey = Object.fromEntries(scoreVariants([...flood, ...crowd], { minSamplesForConclusion: 0 }).map((v) => [v.variantKey, v]));
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  // A: one speaker → cap = saturation × 1 = 3 raw units, then × weight 0.8.
  close(byKey.A!.effective, YC_SPEAKER_SATURATION * 1 * 0.8);
  // B: ten speakers → cap = 30, raw = 100, so capped at 30 × 0.8.
  close(byKey.B!.effective, YC_SPEAKER_SATURATION * 10 * 0.8);
  assert.equal(byKey.A!.support.obs, 500, "the raw count is still reported honestly");
  assert.equal(byKey.A!.support.speakers, 1);
});

test("unknown speakers buy no independence — they all share one bucket", () => {
  const anonymous = obs("A", "internal", null, 200);
  const [v] = scoreVariants(anonymous, { minSamplesForConclusion: 0 });
  assert.equal(v!.effective, YC_SPEAKER_SATURATION * 1 * 1, "200 unattributed observations cap like one speaker");
});

test("Yiddish Labs carries zero pronunciation weight", () => {
  assert.equal(weightForSource("yiddishlabs"), 0);
  assert.equal(weightForSource("yiddishlabs_cache"), 0);
  assert.equal(weightForSource("internal", "LEXICAL_ONLY"), 0);
  const scored = scoreVariants(obs("A", "yiddishlabs", "spk-1", 50, "LEXICAL_ONLY"), { minSamplesForConclusion: 0 });
  assert.equal(scored[0]!.effective, 0);
  assert.equal(scored[0]!.score, 0.5, "no weighted evidence = 0.5, the honest 'we do not know'");
  assert.equal(scored[0]!.eligibleForRule, false);
});

test("a human confirmation dominates whatever source it came through", () => {
  assert.equal(weightForSource("internal", "HUMAN"), 5);
  const mixed = [...obs("A", "internal", "spk-1", 3), ...obs("B", "internal", "spk-9", 3, "HUMAN")];
  const [top] = scoreVariants(mixed, { minSamplesForConclusion: 0 });
  assert.equal(top!.variantKey, "B");
  assert.equal(top!.humanConfirmed, true);
});

test("a NAME cannot become a rule without a human observation", () => {
  const strong = Array.from({ length: 12 }, (_, i) => obs("A", "yiddish24", `spk-${i}`, 5)).flat();
  const machineOnly = scoreVariants(strong, { origin: "NAME", minSamplesForConclusion: 0 });
  assert.ok(machineOnly[0]!.score > YC_RULE_SCORE_THRESHOLD, "the score alone is well over the bar");
  assert.equal(machineOnly[0]!.eligibleForRule, false);
  assert.match(machineOnly[0]!.blockedReason ?? "", /no person has confirmed it/i);

  const withHuman = scoreVariants([...strong, ...obs("A", "human", "spk-h", 1, "HUMAN")], {
    origin: "NAME",
    minSamplesForConclusion: 0,
  });
  assert.equal(withHuman[0]!.eligibleForRule, true);
  assert.equal(withHuman[0]!.blockedReason, null);

  // The same evidence on an ordinary Yiddish word needs no human.
  assert.equal(scoreVariants(strong, { origin: "YI", minSamplesForConclusion: 0 })[0]!.eligibleForRule, true);
});

test("thin evidence refuses to call a winner", () => {
  const thin = obs("A", "internal", "spk-1", 2);
  const [v] = scoreVariants(thin, { origin: "YI" });
  assert.equal(v!.eligibleForRule, false);
  assert.match(v!.blockedReason ?? "", /observations for this word in total|below/i);
});

test("score is a Beta posterior: evenly split variants sit at 0.5, never 'a winner'", () => {
  const even = [
    ...Array.from({ length: 5 }, (_, i) => obs("A", "internal", `a${i}`, 3)).flat(),
    ...Array.from({ length: 5 }, (_, i) => obs("B", "internal", `b${i}`, 3)).flat(),
  ];
  const scored = scoreVariants(even, { minSamplesForConclusion: 0 });
  assert.equal(scored.length, 2);
  for (const v of scored) {
    assert.ok(Math.abs(v.share - 0.5) < 1e-9);
    assert.ok(v.score < YC_RULE_SCORE_THRESHOLD, "an even split must never clear the rule bar");
  }
});

test("excludeSources lets the UI recompute with a source switched off", () => {
  const rows = [...obs("A", "yiddish24", "spk-1", 10), ...obs("B", "internal", "spk-2", 10)];
  assert.equal(excludeSources(rows, ["yiddish24"]).length, 10);
  const without = scoreVariants(rows, { excludeSourceKeys: ["yiddish24"], minSamplesForConclusion: 0 });
  assert.deepEqual(without.map((v) => v.variantKey), ["B"]);
  // And the original array is untouched.
  assert.equal(rows.length, 20);
});

test("two real variants are an open conflict, not a winner", () => {
  const split = [
    ...Array.from({ length: 6 }, (_, i) => obs("A", "internal", `a${i}`, 3)).flat(),
    ...Array.from({ length: 4 }, (_, i) => obs("B", "internal", `b${i}`, 3)).flat(),
  ];
  const scored = scoreVariants(split, { minSamplesForConclusion: 0 });
  const conflict = conflictsFor(scored);
  assert.equal(conflict.open, true);
  assert.deepEqual(conflict.variantKeys.sort(), ["A", "B"]);
  assert.match(conflict.note, /Both are real/);

  const lopsided = scoreVariants([...obs("A", "internal", "a", 20), ...obs("B", "internal", "b", 1, "ACOUSTIC_ALIGNED", 0.1)], {
    minSamplesForConclusion: 0,
  });
  assert.equal(conflictsFor(lopsided).open, false);
});
