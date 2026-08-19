/**
 * Read-only SQL guard — the safety core of the agent's investigation workspace.
 *
 * ⛔⛔ THE RULE THIS FILE EXISTS TO ENFORCE: the assistant may LOOK at anything
 * and CHANGE nothing. It is handed a window onto two live production databases
 * (Connect's Postgres and the PBX's MySQL) serving 29 real companies, so "it
 * probably only wrote a SELECT" is not a safety property.
 *
 * ⛔ THIS TEXT GUARD IS THE BRACES, NOT THE BELT. Parsing SQL with regexes is a
 * losing game and must never be the only thing standing between a model and a
 * production table. The actual enforcement is at the database:
 *   - Postgres: every statement runs inside a READ ONLY transaction with a
 *     statement_timeout. The SERVER rejects any write, whatever got past here.
 *   - PBX MySQL: the credential is `connect_read`, which holds SELECT and
 *     nothing else. The GRANT rejects any write, whatever got past here.
 * If you ever find yourself relaxing this file "because the database will catch
 * it", that is the correct instinct — but keep both layers, because the day
 * someone points this at a connection with write rights, this file is what is
 * left.
 *
 * ⛔ Comments and string literals are SCRUBBED before any keyword matching.
 * Without that, a keyword inside a comment or a quoted string reads as a write
 * and produces a false refusal — and a matcher that can be shaped by attacker
 * text is not a matcher. Scrub first, match second.
 */

export type SqlDialect = "postgres" | "mysql";

/**
 * Replace the CONTENTS of comments and string/identifier literals with spaces,
 * preserving length and line structure so statement separators survive.
 *
 * Handles line comments, block comments, single-quoted strings (with doubled
 * and backslash escapes), double-quoted identifiers, MySQL backticks, and
 * Postgres dollar-quoting — dollar-quoting is the one people forget, and it is
 * the easiest place to hide a keyword.
 */
export function scrubSqlLiteralsAndComments(sql: string): string {
  const out = sql.split("");
  const n = sql.length;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Line comment: -- ... end of line
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Block comment. Postgres nests these; MySQL does not. Treating them as
    // nesting is the conservative reading for both.
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; continue; }
        if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Postgres dollar quoting: $$ ... $$ or $tag$ ... $tag$
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? n : close + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    // Quoted string or identifier
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && quote === "'") { j += 2; continue; }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      blank(i, Math.min(j, n));
      i = j;
      continue;
    }

    i++;
  }

  return out.join("");
}

/**
 * Statement-level keywords that mean "this is not a read". Matched as whole
 * words against the SCRUBBED text, so OFFSET never trips SET and a column
 * named "delete" inside quotes is invisible here.
 */
const FORBIDDEN_KEYWORDS = [
  // writes and DDL
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE", "MERGE",
  "REPLACE", "RENAME", "COMMENT", "UPSERT",
  // permissions
  "GRANT", "REVOKE",
  // session and procedural control — a foothold even when it writes nothing itself
  "SET", "RESET", "CALL", "DO", "DECLARE", "PREPARE", "EXECUTE", "DEALLOCATE",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "START", "LOCK", "UNLOCK",
  // maintenance and server control
  "COPY", "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "DISCARD", "CHECKPOINT",
  "LISTEN", "NOTIFY", "UNLISTEN", "LOAD", "HANDLER", "INSTALL", "UNINSTALL",
  // SELECT ... INTO writes a table (Postgres) or a file (MySQL OUTFILE/DUMPFILE)
  "INTO",
];

/**
 * Functions that read the filesystem, reach the network, or burn the server.
 * A statement can be perfectly read-only and still be an attack.
 */
const FORBIDDEN_FUNCTIONS = [
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
  "lo_import", "lo_export", "dblink", "dblink_exec",
  "pg_sleep", "pg_sleep_for", "pg_sleep_until",
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
  "set_config", "pg_logical_emit_message",
  "load_file", "benchmark", "sleep", "sys_exec", "sys_eval",
];

export interface SqlValidation {
  ok: boolean;
  /** Plain-English reason, safe to show a person. */
  error?: string;
}

/**
 * Accept only a single read-only statement.
 *
 * ⛔ Deliberately strict and deliberately boring. Every refusal names what it
 * saw, because an agent given an unexplained "no" retries the same thing
 * forever, and a person reading the transcript needs to know whether the guard
 * or the query was wrong.
 */
export function validateReadOnlySql(sql: string, _dialect: SqlDialect = "postgres"): SqlValidation {
  if (typeof sql !== "string") return { ok: false, error: "The query must be text." };

  const raw = sql.trim();
  if (!raw) return { ok: false, error: "The query is empty." };
  if (raw.length > 20000) {
    return { ok: false, error: "The query is too long (limit 20,000 characters)." };
  }

  const scrubbed = scrubSqlLiteralsAndComments(raw);

  // One statement only. A trailing semicolon is fine; anything after it is not.
  const withoutTrailing = scrubbed.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { ok: false, error: "Only one statement is allowed — remove the extra ';'." };
  }

  // Must OPEN as a read.
  const firstWord = /^\s*([A-Za-z_]+)/.exec(withoutTrailing)?.[1]?.toUpperCase() ?? "";
  const OPENERS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);
  if (!OPENERS.has(firstWord)) {
    return {
      ok: false,
      error:
        `Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN queries are allowed here — ` +
        `this one starts with "${firstWord || "?"}". This workspace can look at data but never change it.`,
    };
  }

  // EXPLAIN ANALYZE actually RUNS the statement. Refuse it outright rather than
  // reasoning about whether the inner statement is a read.
  if (/^\s*EXPLAIN\b[\s\S]*\bANALYZE\b/i.test(withoutTrailing)) {
    return { ok: false, error: "EXPLAIN ANALYZE runs the query for real — use plain EXPLAIN." };
  }

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(withoutTrailing)) {
      return {
        ok: false,
        error:
          `"${kw}" is not allowed here — this workspace is read-only. ` +
          `If a change is needed, propose it in the report instead of making it.`,
      };
    }
  }

  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(withoutTrailing)) {
      return { ok: false, error: `The function "${fn}" is not allowed here.` };
    }
  }

  return { ok: true };
}

/** Hard ceiling on rows returned to the model, whatever it asks for. */
export const MAX_INVESTIGATION_ROWS = 200;

/**
 * Cap the result set at the DATABASE, not in JavaScript.
 *
 * ⛔ Capping in JS is too late: an unbounded query against ConnectCdr (126k+
 * rows) streams the whole result into the api's memory before any JS sees it.
 *
 * Wrapping is used instead of appending " LIMIT n" because appending has to
 * understand UNION, ORDER BY, existing LIMITs and subqueries — i.e. it has to
 * parse SQL, which is exactly what this module refuses to rely on. A subquery
 * wrapper needs no parsing and is valid in both engines.
 */
export function wrapWithRowLimit(sql: string, limit: number): string {
  const inner = sql.trim().replace(/;\s*$/, "");
  const capped = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_INVESTIGATION_ROWS));
  // SHOW / DESCRIBE / EXPLAIN cannot be used as a subquery in either engine.
  // They are inherently small, so they run as-is.
  if (/^\s*(SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(inner)) return inner;
  return `SELECT * FROM (\n${inner}\n) AS _investigation LIMIT ${capped}`;
}
