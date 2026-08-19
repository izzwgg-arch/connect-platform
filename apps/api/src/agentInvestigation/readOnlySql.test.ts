/**
 * The guard that lets the assistant read two live production databases.
 *
 * ⛔ Most of these cases are BYPASS ATTEMPTS, not happy paths. A read-only
 * guard is only worth the file it lives in if it survives the obvious tricks:
 * a write hidden behind a comment, behind dollar-quoting, behind a second
 * statement, or behind a function that touches the filesystem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scrubSqlLiteralsAndComments,
  validateReadOnlySql,
  wrapWithRowLimit,
  MAX_INVESTIGATION_ROWS,
} from "./readOnlySql";

const ok = (sql: string) => {
  const r = validateReadOnlySql(sql);
  assert.equal(r.ok, true, `expected ALLOWED but was refused: ${r.error} — ${sql}`);
};
const refused = (sql: string, why: string) => {
  const r = validateReadOnlySql(sql);
  assert.equal(r.ok, false, `expected REFUSED (${why}) but was allowed: ${sql}`);
  assert.ok(r.error && r.error.length > 0, "a refusal must explain itself");
};

// ── the reads an investigation actually needs ────────────────────────────────

test("allows the real queries this feature exists to run", () => {
  ok(`select ext_number, status from "Extension" where "tenantId" = 'abc'`);
  ok(`SELECT extension, name FROM ombutel.ombu_extensions WHERE tenant_id = 11`);
  ok(`with recent as (select * from "ConnectCdr" limit 10) select count(*) from recent`);
  ok(`SELECT count(*) FROM "Voicemail" WHERE "tenantId" = 'x' GROUP BY extension`);
  ok(`select * from ombu_custom_destinations where tenant_id = 11`);
  ok(`SHOW TABLES`);
  ok(`DESCRIBE ombu_extensions`);
  ok(`EXPLAIN SELECT 1`);
  ok(`select a from t offset 10 limit 5`); // OFFSET must not trip the SET keyword
  ok(`  select 1  ;  `); // a single trailing semicolon is fine
});

// ── writes, in every costume ─────────────────────────────────────────────────

test("refuses every write, however it is dressed", () => {
  refused(`delete from "Extension"`, "bare delete");
  refused(`UPDATE "Tenant" SET name = 'x'`, "update");
  refused(`insert into "Extension" (id) values ('x')`, "insert");
  refused(`drop table "Extension"`, "drop");
  refused(`truncate "ConnectCdr"`, "truncate");
  refused(`grant select on x to y`, "grant");
  refused(`select 1; delete from "Extension"`, "second statement");
  refused(`select 1;delete from "Extension";`, "second statement, no spaces");
  refused(`SELECT * INTO evil FROM "Tenant"`, "SELECT INTO writes a table");
  refused(`select * from t into outfile '/tmp/x'`, "MySQL INTO OUTFILE");
  refused(`call some_procedure()`, "procedure call");
  refused(`set statement_timeout = 0`, "session change");
  refused(`begin; delete from x`, "transaction control");
});

test("a write hidden in a comment or a literal cannot sneak past, and a keyword INSIDE a literal is not a false refusal", () => {
  // The keyword is real code, only visually obscured — must still be refused.
  refused(`select 1 /* nothing to see */ ; delete from "Extension"`, "comment then real write");
  refused(`select 1 -- comment\n; drop table x`, "line comment then real write");

  // The keyword is DATA, not code — must be allowed, or ordinary searches break.
  ok(`select * from "AuditLog" where action = 'DELETE'`);
  ok(`select * from t where note = 'we should DROP this later'`);
  ok(`select 'INSERT' as label`);
  ok(`select * from t where x = 'a'';DELETE FROM y--'`); // doubled-quote escape
});

test("Postgres dollar-quoting cannot be used to hide a statement", () => {
  ok(`select $$ delete from everything $$ as harmless_text`);
  ok(`select $tag$ drop table x $tag$ as harmless_text`);
  // ...but a real statement after the dollar-quoted block is still caught.
  refused(`select $$ hi $$ ; delete from "Extension"`, "real write after dollar quote");
});

test("EXPLAIN ANALYZE is refused because it really runs the statement", () => {
  refused(`EXPLAIN ANALYZE SELECT 1`, "explain analyze executes");
  ok(`EXPLAIN SELECT 1`);
});

test("refuses functions that reach the filesystem, the network, or burn the server", () => {
  refused(`select pg_read_file('/etc/passwd')`, "file read");
  refused(`select pg_sleep(60)`, "denial of service");
  refused(`select dblink('host=evil', 'select 1')`, "network");
  refused(`select load_file('/etc/passwd')`, "MySQL file read");
  refused(`select benchmark(100000000, md5('x'))`, "MySQL cpu burn");
  refused(`select pg_terminate_backend(1)`, "kills other sessions");
});

test("refuses junk input without throwing", () => {
  refused("", "empty");
  refused("   ", "whitespace only");
  refused("banana", "not a statement");
  refused("x".repeat(20001), "too long");
  assert.equal(validateReadOnlySql(null as any).ok, false);
  assert.equal(validateReadOnlySql(undefined as any).ok, false);
  assert.equal(validateReadOnlySql(42 as any).ok, false);
});

// ── the scrubber itself ──────────────────────────────────────────────────────

test("scrubbing preserves length and newlines so offsets and statements survive", () => {
  const sql = "select 1 -- drop table x\nfrom t";
  const scrubbed = scrubSqlLiteralsAndComments(sql);
  assert.equal(scrubbed.length, sql.length, "length must be preserved");
  assert.ok(scrubbed.includes("\n"), "newlines must survive");
  assert.ok(!/drop/i.test(scrubbed), "comment body must be blanked");
  assert.ok(/select 1/.test(scrubbed), "code outside the comment must survive");
});

test("an unterminated comment or quote blanks to end of input rather than throwing", () => {
  assert.doesNotThrow(() => scrubSqlLiteralsAndComments("select 1 /* never closed"));
  assert.doesNotThrow(() => scrubSqlLiteralsAndComments("select 'never closed"));
  assert.doesNotThrow(() => scrubSqlLiteralsAndComments("select $$ never closed"));
  // And the unterminated text must not then be readable as code.
  refused(`select 1 /* x */ ; delete from t /* never closed`, "write before an unterminated comment");
});

// ── the row cap ──────────────────────────────────────────────────────────────

test("the row cap is applied at the database, not in JavaScript", () => {
  const wrapped = wrapWithRowLimit(`select * from "ConnectCdr"`, 50);
  assert.match(wrapped, /LIMIT 50/);
  assert.match(wrapped, /_investigation/);
  assert.ok(wrapped.includes(`select * from "ConnectCdr"`), "the original query must survive intact");
});

test("the cap can never be raised past the ceiling, and never below one row", () => {
  assert.match(wrapWithRowLimit("select 1", 10_000), new RegExp(`LIMIT ${MAX_INVESTIGATION_ROWS}`));
  assert.match(wrapWithRowLimit("select 1", -5), /LIMIT 1/);
  assert.match(wrapWithRowLimit("select 1", 0), /LIMIT 1/);
  assert.match(wrapWithRowLimit("select 1", NaN), /LIMIT 1/);
});

test("a trailing semicolon does not break the wrapper", () => {
  const wrapped = wrapWithRowLimit("select 1;", 10);
  assert.ok(!wrapped.includes(";\n) AS _investigation"), "the semicolon must be stripped before wrapping");
  assert.match(wrapped, /LIMIT 10/);
});

test("SHOW and DESCRIBE are passed through unwrapped — they cannot be subqueried", () => {
  assert.equal(wrapWithRowLimit("SHOW TABLES", 10), "SHOW TABLES");
  assert.equal(wrapWithRowLimit("DESCRIBE ombu_extensions", 10), "DESCRIBE ombu_extensions");
  assert.equal(wrapWithRowLimit("EXPLAIN SELECT 1", 10), "EXPLAIN SELECT 1");
});
