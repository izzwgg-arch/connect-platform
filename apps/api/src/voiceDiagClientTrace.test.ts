/**
 * ⛔ SOURCE GUARDS for the client-trace pipeline (2026-09-03).
 *
 * The pipeline is three files that must agree: the Prisma enum (packages/db),
 * the api route + Zod enum (server.ts) and the migration. A unit test of the
 * normaliser passes straight through a missing enum value (Prisma 500s at
 * insert), a missing route (404 forever, no telemetry) or a report schema that
 * silently strips the new fields (zod drops unknown keys — the /voice/voicemail
 * `pageSize` trap). These read the SOURCE.
 *
 * Replayable against the pre-change tree with VOICE_DIAG_GUARD_SERVER /
 * VOICE_DIAG_GUARD_SCHEMA to prove non-vacuity. ⛔ Never `git stash` here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SERVER = process.env.VOICE_DIAG_GUARD_SERVER || path.join(__dirname, "server.ts");
const SCHEMA = process.env.VOICE_DIAG_GUARD_SCHEMA || path.join(__dirname, "..", "..", "..", "packages", "db", "prisma", "schema.prisma");
const MIGRATIONS = path.join(__dirname, "..", "..", "..", "packages", "db", "prisma", "migrations");

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Whole-line comment lines dropped so a rule quoted in a doc block cannot satisfy an assertion. */
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const server = code(read(SERVER));
const schema = code(read(SCHEMA));

test("⛔ the Prisma enum carries CLIENT_TRACE (else every insert 500s)", () => {
  const m = /enum VoiceDiagEventType \{([\s\S]*?)\n\}/.exec(schema);
  assert.ok(m, "VoiceDiagEventType enum not found");
  assert.match(m![1], /\bCLIENT_TRACE\b/);
});

test("⛔ a migration adds the enum value (a schema edit alone never reaches production)", () => {
  const dirs = existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS) : [];
  const hit = dirs.find((d) => {
    const f = path.join(MIGRATIONS, d, "migration.sql");
    return existsSync(f) && /ADD VALUE 'CLIENT_TRACE'/.test(read(f));
  });
  assert.ok(hit, "no migration adds 'CLIENT_TRACE' to VoiceDiagEventType");
});

test("⛔ the single-event Zod enum accepts CLIENT_TRACE too", () => {
  const start = server.indexOf('app.post("/voice/diag/event"');
  assert.ok(start > 0);
  const block = server.slice(start, start + 4000);
  assert.match(block, /"CLIENT_TRACE"\]\)/, "CLIENT_TRACE must be the last member of the z.enum in /voice/diag/event");
});

test("⛔ the batch route exists, takes identity from the TOKEN, and is bounded", () => {
  const start = server.indexOf('app.post("/voice/diag/events"');
  assert.ok(start > 0, "POST /voice/diag/events is missing");
  const end = server.indexOf('app.get("/voice/diag/sessions"', start);
  assert.ok(end > start, "batch route must sit inside the /voice/diag block (the self-report guard slices up to /admin/voice/quality/live)");
  const block = server.slice(start, end);
  assert.match(block, /getUser\(req\)/, "identity must come from the token");
  assert.doesNotMatch(block, /z\s*\.\s*object\(\{[^}]*\b(userId|tenantId)\s*:/, "no identity in the body");
  assert.match(block, /normalizeClientTraceBatch\(req\.body/, "the pure normaliser must be the only parser");
  assert.match(block, /checkVoiceDiagEventLimit\(`batch:\$\{session\.id\}`/, "batches must be rate-limited per session, separately from single events");
  assert.match(block, /sanitizeDiagPayload\(r\.payload\)/, "every row must pass the shared sanitiser");
  assert.match(block, /where: \{ id: batch\.sessionId, tenantId: user\.tenantId, userId: user\.sub \}/, "the session must belong to the caller");
  assert.match(block, /type: "CLIENT_TRACE"/);
});

test("⛔ the quality-report schema NAMES the new fields — zod strips what it does not name", () => {
  const start = server.indexOf('app.post("/voice/diag/call-quality-report"');
  assert.ok(start > 0);
  const block = server.slice(start, start + 4000);
  for (const f of ["lastCallError", "micLabel", "micId", "speakerLabel", "speakerId", "speakerOn"]) {
    assert.match(block, new RegExp(`\\b${f}: z\\.`), `${f} is not declared in the call-quality-report schema and would be dropped`);
  }
});

test("the timeline read returns enough events to hold a chatty trace", () => {
  const start = server.indexOf('app.get("/admin/voice/diag/timeline"');
  assert.ok(start > 0);
  const block = server.slice(start, start + 3000);
  const m = /events: \{ orderBy: \{ createdAt: "asc" \}, take: (\d+) \}/.exec(block);
  assert.ok(m, "timeline events include not found");
  assert.ok(Number(m![1]) >= 500, `timeline take is ${m![1]}; CLIENT_TRACE rows would be truncated`);
});
