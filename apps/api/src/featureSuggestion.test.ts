import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeatureSuggestionEmail, FEATURE_SUGGESTION_MIN, FEATURE_SUGGESTION_MAX } from "@connect/shared";

// Normalise line endings so matches hold on a Windows (CRLF) checkout too.
const readSrc = (name: string) => readFileSync(join(__dirname, name), "utf8").replace(/\r\n/g, "\n");
const src = readSrc("featureSuggestion.ts");
const serverSrc = readSrc("server.ts");
const bypassSrc = readSrc("jwtPublicRouteBypass.ts");

/** Executable lines only — the doc comments here quote "ADMIN_ALERT" on purpose. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the route is actually registered — a module nobody calls sends nothing", () => {
  // The defect class here is a CALLER, not a function: the module can be
  // perfect and unreachable. Same shape as the invite email that lost its APK
  // link on one of two paths.
  assert.match(serverSrc, /import \{ registerFeatureSuggestionRoutes \} from "\.\/featureSuggestion"/);
  assert.match(serverSrc, /registerFeatureSuggestionRoutes\(app\)/);
});

test("the email type is anything but ADMIN_ALERT — that type is muted at the send door", () => {
  // A suggestion filed as ADMIN_ALERT would build clean, log clean and reach
  // nobody (lastErrorCode ALERTS_MUTED, owner directive 2026-08-12).
  assert.match(src, /FEATURE_SUGGESTION_EMAIL_TYPE = "FEATURE_SUGGESTION"/);
  const code = stripComments(src);
  assert.ok(!code.includes('"ADMIN_ALERT"'), "the muted type must not appear in executable code");
  assert.match(code, /type: FEATURE_SUGGESTION_EMAIL_TYPE/, "the job must be created with the constant, not a retyped string");
});

test("suggestions land at info@loopcom.net unless the env says otherwise", () => {
  // Izzy's explicit destination (2026-08-20). A recipient, not a platform link,
  // so it deliberately does NOT follow PLATFORM_MAIL_DOMAIN.
  assert.match(src, /FEATURE_SUGGESTION_EMAIL \|\| "info@loopcom\.net"/);
});

test("the route is NOT in the unauthenticated bypass list and demands a session", () => {
  assert.doesNotMatch(bypassSrc, /feature-suggestion/);
  assert.match(src, /status\(401\)\.send\(\{ error: "unauthorized" \}\)/);
});

test("tenant and identity come from the token, never from the request body", () => {
  const schema = src.slice(src.indexOf(".safeParse") - 400, src.indexOf(".safeParse"));
  assert.doesNotMatch(schema, /tenantId/);
  assert.doesNotMatch(schema, /userName/);
  assert.doesNotMatch(schema, /email/i);
  assert.match(src, /tenantId: user\.tenantId/);
  assert.match(src, /actorUserId: user\.sub/);
});

test("validation failures speak plain English, never a code", () => {
  assert.match(src, /safeParse/);
  assert.doesNotMatch(src, /\)\s*\.parse\(req\.body/);
  assert.match(src, /Please tell us a little more about the feature you'd like\./);
  assert.match(src, /We couldn't send that just now\./);
});

test("the email job and its audit row land together — the audit row is the per-user counter", () => {
  assert.match(src, /db\.\$transaction\(async \(tx\) => \{/);
  const tx = src.slice(src.indexOf("db.$transaction"), src.indexOf("} catch (err: any)"));
  assert.match(tx, /emailJob\.create\(/);
  assert.match(tx, /auditLog\.create\(/);
});

test("both rate limits exist and the refusal is friendly", () => {
  assert.match(src, /PER_USER_LIMIT/);
  assert.match(src, /PER_TENANT_LIMIT/);
  assert.match(src, /status\(429\)/);
  assert.match(src, /a person will read them/);
});

test("this stays out of the support-report module — that file is escalation-only by contract", () => {
  // supportReport.test.ts pins that supportReport.ts never grows an
  // emailJob.create; the suggestion path must not be merged into it.
  const reportSrc = readSrc("supportReport.ts");
  assert.ok(!stripComments(reportSrc).includes("feature-suggestion"), "the suggestion route belongs in featureSuggestion.ts");
});

// ── the pure builder ───────────────────────────────────────────────────────

test("the email carries the company, the person and the verbatim suggestion", () => {
  const mail = buildFeatureSuggestionEmail({
    tenantName: "Gesheft",
    userName: "Joel Landau",
    userEmail: "joel@example.com",
    suggestion: "Let me press 9 to replay the menu in Yiddish.",
    page: "Dashboard",
  });
  assert.match(mail.subject, /^Feature suggestion — /);
  assert.match(mail.text, /Company: {2}Gesheft/);
  assert.match(mail.text, /Joel Landau \(joel@example\.com\)/);
  assert.match(mail.text, /Let me press 9 to replay the menu in Yiddish\./);
  assert.match(mail.text, /the Dashboard page/);
  assert.match(mail.text, /Reply to joel@example\.com/);
  assert.match(mail.html, /Let me press 9 to replay the menu in Yiddish\./);
});

test("a long suggestion gets a clipped subject; the body keeps every word", () => {
  const long = "A".repeat(FEATURE_SUGGESTION_MAX);
  const mail = buildFeatureSuggestionEmail({ tenantName: "T", userName: "U", suggestion: long });
  assert.ok(mail.subject.length < 100, "email subjects have practical limits");
  assert.ok(mail.text.includes(long), "the body is verbatim, never clipped");
});

test("HTML in a suggestion is escaped, and a missing email drops the reply line", () => {
  const mail = buildFeatureSuggestionEmail({
    tenantName: "T <b>",
    userName: "U",
    userEmail: null,
    suggestion: "add a <script>alert(1)</script> button please",
  });
  assert.ok(!mail.html.includes("<script>"), "raw HTML must never reach the inbox");
  assert.match(mail.html, /&lt;script&gt;/);
  assert.doesNotMatch(mail.text, /Reply to/);
  assert.equal(FEATURE_SUGGESTION_MIN, 10);
});
