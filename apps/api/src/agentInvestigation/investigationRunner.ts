/**
 * The investigation workspace — the assistant's read-only window onto BOTH
 * servers: Connect's Postgres (loopcom) and the PBX's MySQL.
 *
 * ⛔⛔ WHY THIS EXISTS, in one sentence: you cannot pre-build a capability for
 * every way a phone system breaks, but you CAN give the assistant the same
 * five verbs a person uses to investigate — query, count, list, describe,
 * compare — and let it point them wherever the problem is. Diagnosis is
 * generic. Only repair is scenario-specific.
 *
 * ⛔ THREE LAYERS OF ENFORCEMENT, and none of them is "the model was told not
 * to". A change that removes any one of them is a change that puts 29
 * companies' data at risk:
 *   1. `validateReadOnlySql` refuses anything that is not a single read.
 *   2. Postgres runs it inside a READ ONLY transaction with a statement
 *      timeout, so the SERVER refuses a write even if layer 1 were bypassed.
 *   3. The PBX credential is `connect_read`, which holds SELECT and nothing
 *      else, so the GRANT refuses a write even if layers 1 and 2 were bypassed.
 *
 * ⛔ The PBX is READ-ONLY BY STANDING RULE, not merely by configuration. This
 * module must never gain a write path to it, and `connectOmbutelMysql` is
 * REUSED from pbxQueueDirectory rather than reimplemented — a second connection
 * helper is how the two would drift and how one of them would quietly end up
 * pointed at a writable credential.
 */
import { connectOmbutelMysql } from "../pbxQueueDirectory";
import {
  validateReadOnlySql,
  wrapWithRowLimit,
  MAX_INVESTIGATION_ROWS,
  type SqlDialect,
} from "./readOnlySql";

/** Where a query ran. Named for a person reading the report, not for a DBA. */
export type InvestigationSource = "connect" | "pbx";

export interface InvestigationSuccess {
  ok: true;
  source: InvestigationSource;
  /** The statement as actually executed, including the row cap. */
  executed: string;
  rows: unknown[];
  rowCount: number;
  /** True when the row cap cut the result — the model must be told, or it will
   *  reason about a partial set as if it were the whole set. */
  truncated: boolean;
  elapsedMs: number;
}

export interface InvestigationFailure {
  ok: false;
  source: InvestigationSource;
  error: string;
  /** True when the guard refused it (a fixable mistake), false when the
   *  database refused it (possibly a real fault worth reporting). */
  refusedByGuard: boolean;
}

export type InvestigationResult = InvestigationSuccess | InvestigationFailure;

/** How long any single investigation query may run before it is killed. */
export const QUERY_TIMEOUT_MS = 15_000;

/**
 * JSON cannot carry a BigInt, and Postgres returns one for every `count(*)`.
 * Left unhandled this throws INSIDE the serializer, which surfaces as a generic
 * 500 with no hint that a count was involved — an afternoon of confusion for a
 * one-line fix. Dates become ISO strings for the same reason: so the model sees
 * a stable, comparable value instead of an object that stringifies to `{}`.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

function clampLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), MAX_INVESTIGATION_ROWS);
}

/** Never hand a raw driver error to a model or a report — it can carry the
 *  connection string. Keep the useful part, drop the rest. */
function safeDbError(e: any): string {
  const msg = String(e?.message ?? e ?? "unknown error");
  return msg
    .replace(/(mysql|postgres(?:ql)?):\/\/[^\s"']+/gi, "<connection>")
    .replace(/password=\S+/gi, "password=<redacted>")
    .slice(0, 500);
}

/**
 * Run a read-only query against CONNECT's Postgres (the loopcom server).
 *
 * ⛔ The READ ONLY transaction is the real guarantee here. `prisma` is the
 * ordinary application client and it HAS write rights — that is precisely why
 * the transaction is opened READ ONLY rather than trusting the text guard.
 */
export async function runConnectQuery(
  prisma: any,
  sql: string,
  limit: unknown = 50,
): Promise<InvestigationResult> {
  const check = validateReadOnlySql(sql, "postgres");
  if (!check.ok) {
    return { ok: false, source: "connect", error: check.error!, refusedByGuard: true };
  }

  const capped = clampLimit(limit);
  const executed = wrapWithRowLimit(sql, capped);
  const started = Date.now();

  try {
    const rows: unknown[] = await prisma.$transaction(async (tx: any) => {
      // Order matters: make the transaction read-only BEFORE anything runs in it.
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
      return await tx.$queryRawUnsafe(executed);
    }, { timeout: QUERY_TIMEOUT_MS + 5_000 });

    const safe = (Array.isArray(rows) ? rows : []).map(toJsonSafe);
    return {
      ok: true,
      source: "connect",
      executed,
      rows: safe,
      rowCount: safe.length,
      truncated: safe.length >= capped,
      elapsedMs: Date.now() - started,
    };
  } catch (e: any) {
    return { ok: false, source: "connect", error: safeDbError(e), refusedByGuard: false };
  }
}

/**
 * Run a read-only query against the PBX's MySQL (ombutel + asterisk).
 *
 * ⛔ This is the half that answers "what does the phone system actually think",
 * and it is where most real diagnoses live: `ombu_extensions` (does this
 * extension exist at all), `ombu_custom_applications` / `ombu_custom_destinations`
 * (is it a forward rather than a phone), `ombu_inbound_routes`, `ombu_devices`,
 * `asterisk.queues_log`.
 */
export async function runPbxQuery(
  ombuMysqlUrlEncrypted: string | null | undefined,
  sql: string,
  limit: unknown = 50,
): Promise<InvestigationResult> {
  const check = validateReadOnlySql(sql, "mysql");
  if (!check.ok) {
    return { ok: false, source: "pbx", error: check.error!, refusedByGuard: true };
  }

  const conn = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!conn.ok) {
    return {
      ok: false,
      source: "pbx",
      error: `Cannot reach the phone system database: ${conn.skipReason}`,
      refusedByGuard: false,
    };
  }

  const capped = clampLimit(limit);
  const executed = wrapWithRowLimit(sql, capped);
  const started = Date.now();

  try {
    // Belt for the timeout, since MySQL has no per-transaction statement_timeout
    // the way Postgres does. The GRANT is the belt for read-only.
    await conn.conn.query(`SET SESSION MAX_EXECUTION_TIME = ${QUERY_TIMEOUT_MS}`).catch(() => {});
    const [rows] = await conn.conn.query(executed);
    const safe = (Array.isArray(rows) ? rows : []).map(toJsonSafe);
    return {
      ok: true,
      source: "pbx",
      executed,
      rows: safe,
      rowCount: safe.length,
      truncated: safe.length >= capped,
      elapsedMs: Date.now() - started,
    };
  } catch (e: any) {
    return { ok: false, source: "pbx", error: safeDbError(e), refusedByGuard: false };
  } finally {
    await conn.conn.end().catch(() => {});
  }
}

/** A compact, model-facing rendering of one result. */
export function describeResult(r: InvestigationResult): string {
  if (!r.ok) return `[${r.source}] FAILED: ${r.error}`;
  const head = `[${r.source}] ${r.rowCount} row${r.rowCount === 1 ? "" : "s"} in ${r.elapsedMs}ms`;
  const note = r.truncated
    ? ` (TRUNCATED at the row cap — there may be more; narrow the query before drawing a conclusion)`
    : "";
  return head + note;
}

export type { SqlDialect };
