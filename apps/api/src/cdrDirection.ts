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
 *   0. dcontext from AMI Cdr event — most authoritative signal.
 *      Matches Asterisk dialplan context that originated the call.
 *      from-trunk / from-pstn / from-external / ivr-* / trk-*-in → incoming
 *      ext-local-* / from-internal / sub-local-dialing / trk-*-dial → outgoing or internal
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
  return /^1\d{10}$/.test(d) ? d.slice(1) : d;
}

function isExtension(digits: string): boolean {
  return digits.length >= 2 && digits.length <= 6;
}

function isExternal(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * Infer direction from Asterisk dcontext string.
 * Returns null if dcontext is absent or unrecognized.
 */
export function directionFromDcontext(
  dcontext: string | null | undefined,
  toNumber?: string | null | undefined,
): CdrDirection | null {
  if (!dcontext) return null;
  const dctx = dcontext.toLowerCase();

  if (
    dctx.includes("from-trunk") || dctx.includes("from-pstn") ||
    dctx.includes("from-external") || dctx.includes("inbound") ||
    /^ivr-\d/.test(dctx) ||
    /^trk-[^-]+-in/.test(dctx)
  ) {
    return "incoming";
  }

  if (
    dctx.includes("from-internal") || dctx.includes("ext-local") || dctx.includes("outbound") ||
    /^trk-[^-]+-dial/.test(dctx) ||
    /^t\d+_cos-/.test(dctx) ||
    dctx.includes("sub-local-dialing")
  ) {
    const destDigits = digitsOnly(toNumber);
    if (isExtension(destDigits)) return "internal";
    return "outgoing";
  }

  return null;
}

/**
 * Returns the canonical direction for a call.
 * Priority: dcontext (if provided) > number pattern > storedDir.
 */
export function canonicalDirection(
  fromNumber: string | null | undefined,
  toNumber: string | null | undefined,
  storedDir: string,
  dcontext?: string | null | undefined,
): CdrDirection {
  // Priority 0: dcontext is the most authoritative signal
  const fromCtx = directionFromDcontext(dcontext, toNumber);
  if (fromCtx) return fromCtx;

  // Priority 1–3: number-pattern heuristics
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
  dcontext?: string | null | undefined,
): boolean {
  return canonicalDirection(fromNumber, toNumber, storedDir, dcontext) !== storedDir;
}

/**
 * PostgreSQL CASE expression that computes canonical direction inline.
 * Follows the same rules as canonicalDirection():
 *   1. dcontext (if stored) — most authoritative
 *   2. number-pattern heuristic
 *   3. fallback to stored direction
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
  dcontextCol = '"dcontext"',
): string {
  const dctx = `LOWER(COALESCE(${dcontextCol}, ''))`;

  // dcontext inbound patterns
  const dctxInbound = [
    `${dctx} LIKE '%from-trunk%'`,
    `${dctx} LIKE '%from-pstn%'`,
    `${dctx} LIKE '%from-external%'`,
    `${dctx} LIKE '%inbound%'`,
    `${dctx} ~ '^ivr-[0-9]'`,
    `${dctx} ~ '^trk-[^-]+-in'`,
  ].join(" OR ");

  // dcontext outbound/internal patterns
  const dctxOutbound = [
    `${dctx} LIKE '%from-internal%'`,
    `${dctx} LIKE '%ext-local%'`,
    `${dctx} LIKE '%outbound%'`,
    `${dctx} ~ '^trk-[^-]+-dial'`,
    `${dctx} ~ '^t[0-9]+_cos-'`,
    `${dctx} LIKE '%sub-local-dialing%'`,
  ].join(" OR ");

  // Pure-digit extraction for number heuristic
  const fromD = `REGEXP_REPLACE(COALESCE(${fromCol}, ''), '[^0-9]', '', 'g')`;
  const toD   = `REGEXP_REPLACE(COALESCE(${toCol},   ''), '[^0-9]', '', 'g')`;

  const fromN = `CASE WHEN LENGTH(${fromD}) = 11 AND LEFT(${fromD}, 1) = '1' THEN SUBSTRING(${fromD} FROM 2) ELSE ${fromD} END`;
  const toN   = `CASE WHEN LENGTH(${toD})   = 11 AND LEFT(${toD},   1) = '1' THEN SUBSTRING(${toD}   FROM 2) ELSE ${toD}   END`;

  const fromIsExt  = `(LENGTH(${fromN}) BETWEEN 2 AND 6)`;
  const toIsExt    = `(LENGTH(${toN})   BETWEEN 2 AND 6)`;
  const fromIsExtn = `(LENGTH(${fromN}) BETWEEN 10 AND 15)`;
  const toIsExtn   = `(LENGTH(${toN})   BETWEEN 10 AND 15)`;

  return (
    `CASE\n` +
    `  WHEN ${dctxInbound} THEN 'incoming'\n` +
    `  WHEN (${dctxOutbound}) AND ${toIsExt} THEN 'internal'\n` +
    `  WHEN ${dctxOutbound} THEN 'outgoing'\n` +
    `  WHEN ${fromIsExt}  AND ${toIsExtn}  THEN 'outgoing'\n` +
    `  WHEN ${fromIsExtn} AND ${toIsExt}   THEN 'incoming'\n` +
    `  WHEN ${fromIsExt}  AND ${toIsExt}   THEN 'internal'\n` +
    `  ELSE ${dirCol}\n` +
    `END`
  );
}
