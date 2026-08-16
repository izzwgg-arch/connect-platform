import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeAgent, QUEUE_LOG_TABLE, DEFAULT_SERVICE_LEVEL_SEC } from "./pbxQueueStats";
import { queueLogName } from "./pbxQueueDirectory";

/**
 * These are the mistakes that produce a CONFIDENT WRONG ANSWER rather than an
 * error — the kind that ships, renders beautifully, and misinforms a customer
 * about their own phone system. Each one was actually made while building this
 * feature, so each gets a test.
 *
 * Several assertions read the module SOURCE. That is deliberate: the defect
 * shape here is "somebody swaps a column back" and a behavioural test against a
 * mocked MySQL would happily agree with the wrong column.
 */

const statsSource = readFileSync(join(__dirname, "pbxQueueStats.ts"), "utf8");
const dirSource = readFileSync(join(__dirname, "pbxQueueDirectory.ts"), "utf8");

/**
 * Comments in these modules deliberately QUOTE the wrong patterns in order to
 * warn about them ("`max(data1)` string-compares…"). Scanning raw source would
 * therefore fail on the documentation itself, so the SQL assertions below run
 * against code with comments removed. The prose assertions use the raw source.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const statsCode = stripComments(statsSource);
const dirCode = stripComments(dirSource);

// ── The queue-naming trap ───────────────────────────────────────────────────

test("queueLogName builds the T<tenant>_Q<ext> name the log actually uses", () => {
  assert.equal(queueLogName("8", "750"), "T8_Q750");
  assert.equal(queueLogName(8, "751"), "T8_Q751");
  assert.equal(queueLogName(" 8 ", " 752 "), "T8_Q752");
});

test("queueLogName is the ONLY place the log name is assembled", () => {
  // A hand-rolled `T${x}_Q${y}` anywhere else is how the two drift apart and a
  // busy queue starts reporting zero rows.
  const offenders = [statsCode, dirCode].filter((src) => {
    const matches = src.match(/`T\$\{[^}]+\}_Q\$\{[^}]+\}`/g) ?? [];
    return matches.length > 0;
  });
  // Exactly one occurrence, and it must be inside pbxQueueDirectory's helper.
  const dirMatches = dirCode.match(/`T\$\{[^}]+\}_Q\$\{[^}]+\}`/g) ?? [];
  assert.equal(dirMatches.length, 1, "the log name must be assembled exactly once");
  assert.equal(offenders.includes(statsCode), false, "pbxQueueStats must never build the name itself");
});

// ── The varchar trap ────────────────────────────────────────────────────────

test("every numeric read of a dataN column is CAST — string compare gives nonsense", () => {
  // MAX(data1) on a varchar returns the lexically-largest value: '9' beats
  // '20326'. This produced an abandon "max wait" BELOW its own average.
  const rawAggregates = statsCode.match(/(?:AVG|MAX|MIN|SUM)\(\s*data\d/gi) ?? [];
  assert.deepEqual(rawAggregates, [], "aggregate over a dataN column without CAST(... AS UNSIGNED)");

  const rawComparisons = statsCode.match(/data\d\s*(?:<=|>=|<|>)\s*\?/g) ?? [];
  assert.deepEqual(rawComparisons, [], "numeric comparison against a raw varchar dataN column");
});

// ── The per-event field-meaning trap ────────────────────────────────────────

test("ABANDON reads wait time from data3, never data1", () => {
  // On ABANDON, data1 is the queue POSITION. Reading it as a duration yields a
  // plausible small number and is completely wrong.
  const abandonBlock = statsCode.slice(
    statsCode.indexOf("event = 'ABANDON'") - 700,
    statsCode.indexOf("event = 'ABANDON'") + 120,
  );
  assert.match(abandonBlock, /CAST\(data3 AS UNSIGNED\)/, "abandon wait must come from data3");
  assert.doesNotMatch(
    abandonBlock,
    /AVG\(CAST\(data1 AS UNSIGNED\)\)\s+AS\s+avg_wait/,
    "data1 on an ABANDON row is the position, not the wait",
  );
});

test("answered stats read hold time from data1 and talk time from data2", () => {
  assert.match(statsCode, /AVG\(CAST\(data1 AS UNSIGNED\)\) AS avg_wait/);
  assert.match(statsCode, /AVG\(CAST\(data2 AS UNSIGNED\)\) AS avg_talk/);
});

// ── The timezone trap ───────────────────────────────────────────────────────

test("reports filter on `created`, never on the UTC varchar `time` column", () => {
  // `time` is a varchar in UTC; `created` is a real timestamp in the PBX's own
  // local clock. Mixing them silently shifts every report by four hours.
  assert.doesNotMatch(statsSource, /WHERE[^;]*\btime\s*(?:>=|<=|>|<)/i);
  assert.match(statsCode, /created >= /);
});

test("the range is evaluated by MySQL, so no JS timezone conversion can creep in", () => {
  // A JS Date formatted into SQL would need us to guess EDT vs EST.
  assert.doesNotMatch(statsCode, /getUTCFullYear|toISOString\(\)\.slice/);
  assert.match(statsCode, /DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/);
});

// ── The RINGNOANSWER trap ───────────────────────────────────────────────────

test("ringNoAnswer is carried as its own field and never folded into a failure count", () => {
  assert.match(statsCode, /ringNoAnswer/);
  // It must not be summed into abandoned/timedOut, which is what would turn a
  // structural ringall artefact into an accusation against every agent.
  assert.doesNotMatch(statsCode, /abandoned\s*\+\s*.*ringNoAnswer|ringNoAnswer\s*\+\s*abandoned/);
});

// ── Agent normalisation ─────────────────────────────────────────────────────

test("normalizeAgent reduces every interface shape to a bare extension", () => {
  assert.equal(normalizeAgent("102"), "102");
  assert.equal(normalizeAgent("PJSIP/T8_102"), "102");
  assert.equal(normalizeAgent("Local/102@from-queue/n"), "102");
  assert.equal(normalizeAgent("SIP/102"), "102");
  assert.equal(normalizeAgent("  111  "), "111");
  assert.equal(normalizeAgent(""), "");
});

test("normalizeAgent maps every alias of one agent onto the same key", () => {
  // Otherwise one person appears as three rows, each with a third of their
  // calls, and the "share of queue" figure becomes meaningless.
  const aliases = ["102", "PJSIP/T8_102", "Local/102@from-queue/n"];
  const normalized = new Set(aliases.map(normalizeAgent));
  assert.equal(normalized.size, 1);
});

// ── Failing safe ────────────────────────────────────────────────────────────

test("a missing grant is its own reported reason, not an empty report", () => {
  // An empty report renders as "this customer had no calls" — a confident lie
  // about a queue doing 2,000 calls a month.
  assert.match(statsCode, /queue_log_access_denied/);
  assert.match(statsCode, /ER_TABLEACCESS_DENIED_ERROR/);
  assert.match(statsCode, /ER_DBACCESS_DENIED_ERROR/);
});

test("the queue log table is fully schema-qualified", () => {
  // The connection selects the `ombutel` database; an unqualified `queues_log`
  // would resolve to the wrong schema and 1146.
  assert.equal(QUEUE_LOG_TABLE, "asterisk.queues_log");
});

test("a service-level target always declares where it came from", () => {
  // VitalPBX leaves `servicelevel` NULL on every queue we have, so the report
  // must never present our default as the customer's own configured SLA.
  assert.match(statsCode, /serviceLevelTargetSource/);
  assert.match(statsCode, /"queue_config"/);
  assert.equal(typeof DEFAULT_SERVICE_LEVEL_SEC, "number");
});

// ── Membership is authoritative ─────────────────────────────────────────────

test("idle members are derived from configured membership, not from ring counts", () => {
  const block = statsCode.slice(statsCode.indexOf("const idleMembers"), statsCode.indexOf("const hourAgg"));
  assert.match(block, /q\.members/, "must walk configured members");
  assert.doesNotMatch(block, /RINGNOANSWER/, "ring counts must not decide who is idle");
});
