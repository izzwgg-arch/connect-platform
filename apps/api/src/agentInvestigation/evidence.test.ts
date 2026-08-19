/**
 * The evidence rule, tested against the REAL report that motivated it.
 *
 * ⛔ The two false claims below are verbatim from the Trimpro escalation of
 * 2026-08-18. They are the regression cases: if a future change lets either of
 * them through as a finding, this suite goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceLog,
  citationsIn,
  isFactualClaim,
  partitionFindings,
  renderFindingsWithEvidenceRule,
} from "./evidence";

const logWith = (n: number) => {
  const log = new EvidenceLog();
  for (let i = 0; i < n; i++) {
    log.record({
      source: "connect",
      statement: `select ${i}`,
      rows: [{ n: i }],
      rowCount: 1,
      truncated: false,
      at: "2026-08-18T00:00:00.000Z",
    });
  }
  return log;
};

// ── the real failure, replayed ───────────────────────────────────────────────

test("THE REGRESSION: the two false Trimpro claims are demoted to NOT CHECKED", () => {
  const log = new EvidenceLog();
  log.record({
    source: "pbx",
    statement: "select extension, name from ombutel.ombu_extensions where tenant_id = 11",
    rows: [{ extension: "101" }, { extension: "102" }],
    rowCount: 7,
    truncated: false,
  });

  const findings = [
    "- Ext 109 exists as a Custom Application named Closet [E1]",
    "- Ext 101's mailbox is also near its 9,999-message limit.",
    "- Billing: this account has no billing settings row at all.",
  ].join("\n");

  const out = renderFindingsWithEvidenceRule(findings, log);

  assert.match(out.text, /NOT CHECKED/, "there must be an explicit unverified section");
  assert.equal(out.unverifiedCount, 2, "both fabricated claims must be demoted");

  // The measured finding stays a finding.
  const [above] = out.text.split("NOT CHECKED");
  assert.match(above, /Custom Application named Closet/);
  // The invented ones must NOT appear above the line.
  assert.ok(!/9,999-message limit/.test(above), "the mailbox claim must not read as a finding");
  assert.ok(!/no billing settings row/.test(above), "the billing claim must not read as a finding");
});

test("a fabricated citation is caught rather than trusted", () => {
  const log = logWith(2); // E1, E2 exist
  const findings = "- The mailbox is nearly full [E7]";
  const out = renderFindingsWithEvidenceRule(findings, log);

  assert.equal(out.danglingCount, 1, "E7 does not exist and must be flagged");
  assert.equal(out.unverifiedCount, 1, "and the claim must be demoted, not accepted");
  assert.match(out.text, /cited evidence that does not exist/);
  assert.match(out.text, /E7/);
});

test("with no evidence at all, every claim is demoted", () => {
  const log = new EvidenceLog();
  assert.equal(log.isEmpty(), true);
  const findings = "- Extension 109 is broken and the phone needs replacing";
  const out = renderFindingsWithEvidenceRule(findings, log);
  assert.equal(out.unverifiedCount, 1);
  assert.match(out.text, /NOT CHECKED/);
});

// ── citation parsing ─────────────────────────────────────────────────────────

test("citations are recognised in the shapes a model actually writes", () => {
  assert.deepEqual(citationsIn("holds 47 messages [E3]"), ["E3"]);
  assert.deepEqual(citationsIn("both agree [E1, E2]"), ["E1", "E2"]);
  assert.deepEqual(citationsIn("see [E1][E2]"), ["E1", "E2"]);
  assert.deepEqual(citationsIn("lower case [e4]"), ["E4"]);
  assert.deepEqual(citationsIn("no citation here"), []);
  assert.deepEqual(citationsIn("not a citation [Extension]"), []);
});

test("structure is not mistaken for a claim", () => {
  assert.equal(isFactualClaim(""), false);
  assert.equal(isFactualClaim("   "), false);
  assert.equal(isFactualClaim("FINDINGS:"), false);
  assert.equal(isFactualClaim("PROPOSED FIX"), false);
  assert.equal(isFactualClaim("- "), false);
  assert.equal(isFactualClaim("1."), false);
  assert.equal(isFactualClaim("- Ext 109 has no device registered"), true);
});

test("headings and blank lines survive into the report so it still reads as one", () => {
  const log = logWith(1);
  const findings = "FINDINGS:\n\n- Something measured [E1]\n";
  const out = renderFindingsWithEvidenceRule(findings, log);
  assert.match(out.text, /FINDINGS:/);
  assert.equal(out.unverifiedCount, 0);
});

// ── the log itself ───────────────────────────────────────────────────────────

test("evidence ids are stable and sequential", () => {
  const log = new EvidenceLog();
  const a = log.record({ source: "connect", statement: "select 1", rows: [], rowCount: 0, truncated: false });
  const b = log.record({ source: "pbx", statement: "select 2", rows: [], rowCount: 0, truncated: false });
  assert.equal(a.id, "E1");
  assert.equal(b.id, "E2");
  assert.deepEqual(log.ids(), ["E1", "E2"]);
});

test("the rendered evidence block lets a person re-run the claim", () => {
  const log = new EvidenceLog();
  log.record({
    source: "pbx",
    statement: "select count(*) from ombutel.ombu_extensions where tenant_id = 11",
    rows: [{ count: 7 }],
    rowCount: 1,
    truncated: false,
  });
  const rendered = log.render();
  assert.match(rendered, /\[E1\]/);
  assert.match(rendered, /on pbx/);
  assert.match(rendered, /ombu_extensions/, "the statement must be quotable");
  assert.match(rendered, /returned/, "the result must be shown, not just the query");
});

test("an empty log says so rather than rendering an empty heading", () => {
  assert.match(new EvidenceLog().render(), /none — no query was run/);
});

test("truncation is carried into the evidence, because a partial answer reasoned about as a whole one is how wrong conclusions happen", () => {
  const log = new EvidenceLog();
  log.record({ source: "connect", statement: "select * from big", rows: [{ a: 1 }], rowCount: 200, truncated: true });
  assert.match(log.render(), /truncated/);
});

test("only successful queries can become evidence — the log has no path for a failure", () => {
  const log = new EvidenceLog();
  // The recorder takes rows/rowCount; there is deliberately no `error` field to
  // pass, so "I tried and it broke" can never be cited as proof of anything.
  assert.equal(typeof (log as any).recordFailure, "undefined");
});

// ── partitioning detail ──────────────────────────────────────────────────────

test("a claim citing one real and one fake id still counts as verified, but the fake id is reported", () => {
  const log = logWith(1); // only E1
  const { verified, unverified, danglingCitations } = partitionFindings(
    "- Confirmed both ways [E1, E9]",
    log.ids(),
  );
  assert.equal(unverified.length, 0, "a real citation is enough to stand it up");
  assert.equal(verified.filter((l) => l.trim()).length, 1);
  assert.deepEqual(danglingCitations, ["E9"], "but the invented id must still surface");
});
