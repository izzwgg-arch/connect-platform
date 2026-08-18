import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOGIN_PASSWORD_MIN_LENGTH, parseLoginRequest } from "./loginRequest";

// ---------------------------------------------------------------------------
// The bug this file exists to prevent coming back: a malformed login body used
// to THROW out of the handler and the client got 500 internal_error (live,
// 2026-08-18). The parser must never throw, whatever the body is.
// ---------------------------------------------------------------------------

const GARBAGE: unknown[] = [
  undefined,
  null,
  "",
  "not json",
  0,
  42,
  true,
  [],
  ["a@b.com", "password123"],
  {},
  { email: "a@b.com" },
  { password: "password123" },
  { email: "a@b.com", password: "x" }, // the exact live repro
  { email: "a@b.com", password: "" },
  { email: "a@b.com", password: 12345678 },
  { email: "a@b.com", password: null },
  { email: "a@b.com", password: { $gt: "" } },
  { email: "not-an-email", password: "password123" },
  { email: "", password: "password123" },
  { email: 7, password: "password123" },
  { email: ["a@b.com"], password: "password123" },
  { email: null, password: null },
  { email: "not-an-email", password: "x" },
];

test("never throws, whatever the body is", () => {
  for (const body of GARBAGE) {
    let out: ReturnType<typeof parseLoginRequest> | undefined;
    assert.doesNotThrow(() => {
      out = parseLoginRequest(body);
    }, `threw on ${JSON.stringify(body)}`);
    assert.equal(out?.ok, false, `accepted ${JSON.stringify(body)}`);
  }
});

test("the exact live repro (password \"x\") is refused, not thrown", () => {
  const out = parseLoginRequest({ email: "x@y.com", password: "x" });
  assert.deepEqual(out, { ok: false, reason: "bad_password" });
});

test("a well-formed pair is accepted verbatim (no lowercasing here — the handler owns emailKey)", () => {
  const out = parseLoginRequest({ email: "Izzy@Example.com", password: "correct horse" });
  assert.deepEqual(out, { ok: true, value: { email: "Izzy@Example.com", password: "correct horse" } });
});

test("password of exactly the minimum length passes; one short fails", () => {
  const ok = parseLoginRequest({ email: "a@b.com", password: "p".repeat(LOGIN_PASSWORD_MIN_LENGTH) });
  assert.equal(ok.ok, true);
  const short = parseLoginRequest({ email: "a@b.com", password: "p".repeat(LOGIN_PASSWORD_MIN_LENGTH - 1) });
  assert.deepEqual(short, { ok: false, reason: "bad_password" });
});

test("extra fields are ignored, not fatal (a client may send remember-me etc.)", () => {
  const out = parseLoginRequest({ email: "a@b.com", password: "password123", remember: true, device: "x" });
  assert.equal(out.ok, true);
});

test("the log-only reason names the field, and both-wrong is 'malformed'", () => {
  assert.deepEqual(parseLoginRequest({ email: "nope", password: "password123" }), { ok: false, reason: "bad_email" });
  assert.deepEqual(parseLoginRequest({ email: "a@b.com", password: "no" }), { ok: false, reason: "bad_password" });
  assert.deepEqual(parseLoginRequest({ email: "nope", password: "no" }), { ok: false, reason: "malformed" });
  assert.deepEqual(parseLoginRequest({}), { ok: false, reason: "malformed" });
  assert.deepEqual(parseLoginRequest(null), { ok: false, reason: "no_body" });
  assert.deepEqual(parseLoginRequest("string"), { ok: false, reason: "no_body" });
  assert.deepEqual(parseLoginRequest([]), { ok: false, reason: "no_body" });
});

test("source file reads no NODE_ENV (the api container sets none)", () => {
  const src = readFileSync(path.join(__dirname, "loginRequest.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = src.slice(src.indexOf('import { z } from "zod"'));
  assert.ok(!code.includes("NODE_ENV"));
});

// ---------------------------------------------------------------------------
// The handler contract, pinned against server.ts source. CRLF-normalised at the
// read site — see CLAUDE.md "a source-reading guard test that fails ONLY on
// Windows is a CRLF artifact".
// ---------------------------------------------------------------------------

function loginHandlerSource(): string {
  const src = readFileSync(path.join(__dirname, "server.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf('app.post("/auth/login"');
  assert.ok(start > 0, "POST /auth/login handler not found in server.ts");
  const end = src.indexOf("\napp.", start + 1);
  assert.ok(end > start, "could not find the end of the /auth/login handler");
  // Code only — the handler's own comment explains the old `.parse(req.body)` bug,
  // and a guard that trips on its own explanation guards nothing.
  return src
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("POST /auth/login never calls a throwing zod .parse on the body", () => {
  const h = loginHandlerSource();
  assert.doesNotMatch(h, /\.parse\(\s*req\.body/, "a throwing .parse(req.body) is the 500 bug — use parseLoginRequest");
  assert.match(h, /parseLoginRequest\(\s*req\.body\s*\)/, "the handler must go through parseLoginRequest");
});

test("a malformed body answers 401 invalid_credentials (the existing contract), not 400 and not 500", () => {
  const h = loginHandlerSource();
  const guard = h.match(/if \(!parsed\.ok\) \{[\s\S]*?\n\s*\}/);
  assert.ok(guard, "the parsed.ok guard must exist");
  assert.match(guard![0], /status\(401\)/);
  assert.match(guard![0], /invalid_credentials/);
  assert.doesNotMatch(guard![0], /status\(400\)|status\(500\)/);
});

test("a malformed body is answered BEFORE the throttle and is NOT recorded as a failure", () => {
  const h = loginHandlerSource();
  const guardAt = h.indexOf("if (!parsed.ok)");
  const throttleAt = h.indexOf("evaluateLoginAttempt(");
  assert.ok(guardAt > 0 && throttleAt > guardAt, "the malformed-body guard must run before evaluateLoginAttempt");
  const guard = h.match(/if \(!parsed\.ok\) \{[\s\S]*?\n\s*\}/)![0];
  assert.doesNotMatch(guard, /recordLoginFailure/, "garbage must not fill a victim's account counter");
});

test("the metric label for a malformed body is 'malformed' (dashboards tell it from bad_password)", () => {
  const h = loginHandlerSource();
  assert.match(h, /loginFailuresTotal\.labels\("malformed"\)/);
});
