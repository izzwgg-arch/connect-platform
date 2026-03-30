/**
 * Tests for CDR direction canonicalization logic.
 * Self-contained — inlines the pure functions from cdrDirection.ts so this file
 * runs standalone without compilation:
 *
 *   node --experimental-strip-types --test src/cdrDirection.test.ts
 *
 * Coverage:
 *  1. Short extension → long external PSTN = outgoing  (primary direction bug fix)
 *  2. Long external PSTN → short extension = incoming
 *  3. Short extension → short extension = internal
 *  4. No clear pattern → stored direction unchanged
 *  5. Leading country code (+1) normalisation
 *  6. Null / empty from/to: return stored direction
 *  7. Unknown stored direction with no pattern = still "unknown"
 *  8. wouldOverride() identifies misclassified rows
 *  9. Ambiguous 7-9 digit numbers: direction not overridden
 * 10. cdrCanonicalDirectionSql() returns a CASE statement
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Inline copies of pure functions from cdrDirection.ts ─────────────────────
// (same approach as pbx-live.test.ts — avoids ESM/CJS complications)

type CdrDirection = "incoming" | "outgoing" | "internal" | "unknown";
const VALID_DIRECTIONS = new Set<string>(["incoming", "outgoing", "internal", "unknown"]);

function digitsOnly(s: string | null | undefined): string {
  if (!s) return "";
  const d = s.replace(/\D/g, "");
  return /^1\d{10}$/.test(d) ? d.slice(1) : d;
}
function isExtension(digits: string): boolean {
  return digits.length >= 2 && digits.length <= 6;
}
function isExternal(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15;
}
function canonicalDirection(
  fromNumber: string | null | undefined,
  toNumber: string | null | undefined,
  storedDir: string,
): CdrDirection {
  const from = digitsOnly(fromNumber);
  const to = digitsOnly(toNumber);
  if (from || to) {
    if (isExtension(from) && isExternal(to)) return "outgoing";
    if (isExternal(from) && isExtension(to)) return "incoming";
    if (isExtension(from) && isExtension(to)) return "internal";
  }
  const d = storedDir as CdrDirection;
  return VALID_DIRECTIONS.has(d) ? d : "unknown";
}
function wouldOverride(
  fromNumber: string | null | undefined,
  toNumber: string | null | undefined,
  storedDir: string,
): boolean {
  return canonicalDirection(fromNumber, toNumber, storedDir) !== storedDir;
}
function cdrCanonicalDirectionSql(
  fromCol = '"fromNumber"',
  toCol = '"toNumber"',
  dirCol = "direction",
): string {
  const fromD = `REGEXP_REPLACE(COALESCE(${fromCol}, ''), '[^0-9]', '', 'g')`;
  const toD   = `REGEXP_REPLACE(COALESCE(${toCol},   ''), '[^0-9]', '', 'g')`;
  const fromN = `CASE WHEN LENGTH(${fromD}) = 11 AND LEFT(${fromD}, 1) = '1' THEN SUBSTRING(${fromD} FROM 2) ELSE ${fromD} END`;
  const toN   = `CASE WHEN LENGTH(${toD})   = 11 AND LEFT(${toD},   1) = '1' THEN SUBSTRING(${toD}   FROM 2) ELSE ${toD}   END`;
  const fromIsExt  = `(LENGTH(${fromN}) BETWEEN 2 AND 6)`;
  const toIsExt    = `(LENGTH(${toN})   BETWEEN 2 AND 6)`;
  const fromIsExtn = `(LENGTH(${fromN}) BETWEEN 10 AND 15)`;
  const toIsExtn   = `(LENGTH(${toN})   BETWEEN 10 AND 15)`;
  return `CASE\n  WHEN ${fromIsExt}  AND ${toIsExtn}  THEN 'outgoing'\n  WHEN ${fromIsExtn} AND ${toIsExt}   THEN 'incoming'\n  WHEN ${fromIsExt}  AND ${toIsExt}   THEN 'internal'\n  ELSE ${dirCol}\nEND`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 1. Extension → external PSTN = outgoing
test("extension → external: override incoming to outgoing", () => {
  assert.equal(canonicalDirection("107", "8453519000", "incoming"), "outgoing");
});
test("extension → external: override unknown to outgoing", () => {
  assert.equal(canonicalDirection("102", "12125551234", "unknown"), "outgoing");
});
test("extension → external: already outgoing stays outgoing", () => {
  assert.equal(canonicalDirection("105", "9174561234", "outgoing"), "outgoing");
});
test("2-digit extension → 10-digit = outgoing", () => {
  assert.equal(canonicalDirection("10", "4155556789", "incoming"), "outgoing");
});
test("6-digit extension (max) → 10-digit = outgoing", () => {
  assert.equal(canonicalDirection("123456", "8005551234", "incoming"), "outgoing");
});

// 2. External PSTN → extension = incoming
test("external → extension: stays incoming when stored correctly", () => {
  assert.equal(canonicalDirection("8453519000", "107", "incoming"), "incoming");
});
test("external → extension: override outgoing to incoming", () => {
  assert.equal(canonicalDirection("9174561234", "105", "outgoing"), "incoming");
});
test("external → extension: override unknown to incoming", () => {
  assert.equal(canonicalDirection("18005551234", "201", "unknown"), "incoming");
});

// 3. Extension → extension = internal
test("extension → extension: stays internal when already correct", () => {
  assert.equal(canonicalDirection("101", "202", "internal"), "internal");
});
test("extension → extension: override incoming to internal", () => {
  assert.equal(canonicalDirection("103", "104", "incoming"), "internal");
});
test("extension → extension: override outgoing to internal", () => {
  assert.equal(canonicalDirection("200", "300", "outgoing"), "internal");
});

// 4. No clear pattern → stored direction unchanged
test("both null: return stored direction", () => {
  assert.equal(canonicalDirection(null, null, "incoming"), "incoming");
  assert.equal(canonicalDirection(null, null, "outgoing"), "outgoing");
  assert.equal(canonicalDirection(null, null, "unknown"), "unknown");
});
test("external → external: no pattern, keep stored", () => {
  assert.equal(canonicalDirection("8005551234", "9174569000", "incoming"), "incoming");
});

// 5. Country code normalisation
test("+1 country code stripped from 11-digit 'to': classified as external", () => {
  assert.equal(canonicalDirection("107", "18453519000", "incoming"), "outgoing");
});
test("+1 country code stripped from 11-digit 'from': classified as external", () => {
  assert.equal(canonicalDirection("18005551234", "107", "outgoing"), "incoming");
});

// 6. Null/empty handling
test("empty string from/to: keep stored direction", () => {
  assert.equal(canonicalDirection("", "", "outgoing"), "outgoing");
});
test("from=null, to=extension: no pattern, keep stored", () => {
  assert.equal(canonicalDirection(null, "107", "incoming"), "incoming");
});

// 7. Unknown stored direction
test("unknown stored with no pattern: still unknown", () => {
  assert.equal(canonicalDirection(null, null, "unknown"), "unknown");
});
test("invalid stored direction string: returns unknown", () => {
  assert.equal(canonicalDirection(null, null, "bogus"), "unknown");
});

// 8. wouldOverride()
test("wouldOverride: true for extension→external stored as incoming", () => {
  assert.equal(wouldOverride("107", "8453519000", "incoming"), true);
});
test("wouldOverride: false when already correctly classified outgoing", () => {
  assert.equal(wouldOverride("107", "8453519000", "outgoing"), false);
});
test("wouldOverride: false for correctly classified incoming", () => {
  assert.equal(wouldOverride("8453519000", "107", "incoming"), false);
});
test("wouldOverride: false for correctly classified internal", () => {
  assert.equal(wouldOverride("101", "202", "internal"), false);
});
test("wouldOverride: false when no pattern applies", () => {
  assert.equal(wouldOverride(null, null, "incoming"), false);
});

// 9. Ambiguous 7-9 digit numbers
test("7-digit 'to': ambiguous local PSTN, not counted as external → keep stored", () => {
  assert.equal(canonicalDirection("105", "5551234", "incoming"), "incoming");
});
test("9-digit 'to': not in external range → keep stored", () => {
  assert.equal(canonicalDirection("105", "123456789", "incoming"), "incoming");
});
test("1-digit 'from': not in extension range → no pattern", () => {
  assert.equal(canonicalDirection("5", "8453519000", "incoming"), "incoming");
});

// 10. cdrCanonicalDirectionSql()
test("cdrCanonicalDirectionSql returns CASE statement", () => {
  const sql = cdrCanonicalDirectionSql();
  assert.ok(sql.includes("CASE"));
  assert.ok(sql.includes("'outgoing'"));
  assert.ok(sql.includes("'incoming'"));
  assert.ok(sql.includes("'internal'"));
  assert.ok(sql.includes("END"));
});
test("cdrCanonicalDirectionSql accepts custom column names", () => {
  const sql = cdrCanonicalDirectionSql("t.from_num", "t.to_num", "t.dir");
  assert.ok(sql.includes("t.from_num"));
  assert.ok(sql.includes("t.to_num"));
  assert.ok(sql.includes("t.dir"));
});
