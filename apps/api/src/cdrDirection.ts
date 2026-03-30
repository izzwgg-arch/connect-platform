/**
 * Deterministic CDR direction classifier.
 *
 * Shared between:
 *  - /internal/cdr-ingest  (override stored direction before upsert)
 *  - /dashboard/call-kpis  (canonical mode — corrected counts at query time)
 *  - /admin/diagnostics/dashboard-reconciliation
 *  - cdrDirection.test.ts
 *
 * Rules (applied in priority order):
 *   1. from = short extension (2–6 digits), to = external PSTN (10–15 digits) → outgoing
 *   2. from = external PSTN (10–15 digits), to = short extension (2–6 digits) → incoming
 *   3. from = short extension, to = short extension                            → internal
 *   4. No pattern match → return storedDir unchanged
 *
 * 7-digit numbers (local) are intentionally excluded from the "external" bucket
 * because some PBX extensions are configured with 7-digit IDs.
 */

export type CdrDirection = "incoming" | "outgoing" | "internal" | "unknown";

const VALID_DIRECTIONS = new Set<string>(["incoming", "outgoing", "internal", "unknown"]);

function digitsOnly(s: string | null | undefined): string {
  if (!s) return "";
  const d = s.replace(/\D/g, "");
  // Strip leading country code "1" only when the result would be exactly 10 digits
  return /^1\d{10}$/.test(d) ? d.slice(1) : d;
}

function isExtension(digits: string): boolean {
  return digits.length >= 2 && digits.length <= 6;
}

function isExternal(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * Returns the canonical direction for a call.
 * If neither from nor to matches a pattern, storedDir is returned unchanged.
 */
export function canonicalDirection(
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

/**
 * Returns true if canonicalDirection would change the stored direction.
 * Used by the backfill endpoint to report which rows would be updated.
 */
export function wouldOverride(
  fromNumber: string | null | undefined,
  toNumber: string | null | undefined,
  storedDir: string,
): boolean {
  return canonicalDirection(fromNumber, toNumber, storedDir) !== storedDir;
}

/**
 * PostgreSQL CASE expression that computes canonical direction inline.
 * Follows the same rules as canonicalDirection().
 *
 * Usage:
 *   SELECT (${cdrCanonicalDirectionSql()}) AS canonical_direction, ...
 *   FROM "ConnectCdr" WHERE ...
 *
 * Column aliases default to the ConnectCdr schema; override if using a table alias.
 */
export function cdrCanonicalDirectionSql(
  fromCol = '"fromNumber"',
  toCol = '"toNumber"',
  dirCol = 'direction',
): string {
  // Pure-digit extraction
  const fromD = `REGEXP_REPLACE(COALESCE(${fromCol}, ''), '[^0-9]', '', 'g')`;
  const toD   = `REGEXP_REPLACE(COALESCE(${toCol},   ''), '[^0-9]', '', 'g')`;

  // Strip leading country code: 11 digits starting with '1' → strip first digit
  const fromN = `CASE WHEN LENGTH(${fromD}) = 11 AND LEFT(${fromD}, 1) = '1' THEN SUBSTRING(${fromD} FROM 2) ELSE ${fromD} END`;
  const toN   = `CASE WHEN LENGTH(${toD})   = 11 AND LEFT(${toD},   1) = '1' THEN SUBSTRING(${toD}   FROM 2) ELSE ${toD}   END`;

  const fromIsExt  = `(LENGTH(${fromN}) BETWEEN 2 AND 6)`;
  const toIsExt    = `(LENGTH(${toN})   BETWEEN 2 AND 6)`;
  const fromIsExtn = `(LENGTH(${fromN}) BETWEEN 10 AND 15)`;
  const toIsExtn   = `(LENGTH(${toN})   BETWEEN 10 AND 15)`;

  return (
    `CASE\n` +
    `  WHEN ${fromIsExt}  AND ${toIsExtn}  THEN 'outgoing'\n` +
    `  WHEN ${fromIsExtn} AND ${toIsExt}   THEN 'incoming'\n` +
    `  WHEN ${fromIsExt}  AND ${toIsExt}   THEN 'internal'\n` +
    `  ELSE ${dirCol}\n` +
    `END`
  );
}
