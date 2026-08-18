/**
 * MFA on the portal (Phase 11, 2026-08-18): the login-response classifier, the
 * code-input helpers, the plain-English error mapping, and source guards on
 * the call sites — because the defect that would matter here is a caller
 * (writing the pre-auth token to localStorage as if it were a session, or a
 * `.payload` read that silently swallows the api's message).
 *
 * ⛔ Source reads are CRLF-normalised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyLoginResponse,
  isSubmittableMfaCode,
  looksLikeRecoveryCodeInput,
  looksLikeTotpCodeInput,
  mfaChallengeErrorMessage,
  normalizeMfaCodeInput,
  safeNextPath,
  securityPageDestination,
} from "./mfaLogin";

const here = __dirname;
const read = (p: string) => readFileSync(join(here, p), "utf8").replace(/\r\n/g, "\n");

test("classifyLoginResponse: a token is a session; the flag rides along; nothing else changes", () => {
  assert.deepEqual(classifyLoginResponse({ token: "abc", portalPermissionSet: ["x"] }), {
    kind: "session", token: "abc", portalPermissionSet: ["x"], mfaEnrollmentRequired: false,
  });
  assert.deepEqual(classifyLoginResponse({ token: "abc" }), {
    kind: "session", token: "abc", portalPermissionSet: undefined, mfaEnrollmentRequired: false,
  });
  assert.equal(classifyLoginResponse({ token: "abc", mfaEnrollmentRequired: true }).kind, "session");
  assert.equal((classifyLoginResponse({ token: "abc", mfaEnrollmentRequired: true }) as any).mfaEnrollmentRequired, true);
});

test("classifyLoginResponse: the challenge shape has NO token and yields the pre-auth token; a token always wins", () => {
  const c = classifyLoginResponse({ mfaChallengeRequired: true, preAuthToken: "p.q.r", expiresInSeconds: 300, methods: ["totp", "recovery_code"], error: "mfa_required" });
  assert.deepEqual(c, { kind: "mfa_challenge", preAuthToken: "p.q.r", expiresInSeconds: 300, methods: ["totp", "recovery_code"] });
  // The legacy `error` field on the challenge body must not read as a failure.
  assert.notEqual(c.kind, "failed");
  // Malformed challenge (flag without token) is a failure, never a session.
  assert.equal(classifyLoginResponse({ mfaChallengeRequired: true }).kind, "failed");
  assert.deepEqual(classifyLoginResponse({ error: "nope" }), { kind: "failed", error: "nope" });
  assert.deepEqual(classifyLoginResponse(null), { kind: "failed", error: "Login failed" });
});

test("code helpers: 6 digits = TOTP, 10 alphanumerics = recovery, everything else unsendable", () => {
  assert.equal(looksLikeTotpCodeInput("123 456"), true);
  assert.equal(looksLikeTotpCodeInput("12345"), false);
  assert.equal(looksLikeRecoveryCodeInput("abcde-fghjk"), true);
  assert.equal(looksLikeRecoveryCodeInput("ABCDE FGHJK"), true);
  assert.equal(looksLikeRecoveryCodeInput("abcde"), false);
  assert.equal(isSubmittableMfaCode("123456"), true);
  assert.equal(isSubmittableMfaCode("ABCDE-FGHJK"), true);
  assert.equal(isSubmittableMfaCode(""), false);
  assert.equal(isSubmittableMfaCode("hello"), false);
  assert.equal(normalizeMfaCodeInput("  12 34 56 "), "123456");
});

test("error messages are plain English, read the body, and never a bare slug", () => {
  assert.match(mfaChallengeErrorMessage(429, { error: "RATE_LIMITED" }), /Too many wrong codes/);
  assert.match(mfaChallengeErrorMessage(401, { error: "invalid_code" }), /didn't match/);
  assert.match(mfaChallengeErrorMessage(401, { error: "preauth_invalid" }), /timed out/);
  assert.match(mfaChallengeErrorMessage(500, null), /server had a problem/i);
  for (const m of [mfaChallengeErrorMessage(401, { error: "invalid_code" }), mfaChallengeErrorMessage(401, null)]) {
    assert.doesNotMatch(m, /invalid_code|preauth_invalid|RATE_LIMITED/);
  }
});

test("next handling: only same-origin paths; the security redirect preserves where they were going", () => {
  assert.equal(safeNextPath(null), "/dashboard");
  assert.equal(safeNextPath("%2Fvoicemail%3Ffolder%3Dinbox"), "/voicemail?folder=inbox");
  assert.equal(safeNextPath("https://evil.example/x"), "/dashboard");
  assert.equal(safeNextPath("//evil.example"), "/dashboard");
  assert.equal(safeNextPath("/\\evil.example"), "/dashboard");
  assert.equal(securityPageDestination("/calls"), "/account/security?setup=1&next=%2Fcalls");
  assert.equal(securityPageDestination("//evil"), "/account/security?setup=1&next=%2Fdashboard");
  assert.equal(securityPageDestination(null), "/account/security?setup=1&next=%2Fdashboard");
});

// ─── Source guards ───────────────────────────────────────────────────────────

test("⛔ login page: the pre-auth token is NEVER written as a session, and the challenge goes to /auth/mfa/challenge", () => {
  const src = read("../app/login/page.tsx");
  assert.match(src, /classifyLoginResponse\(res\)/, "login must classify through the shared helper");
  assert.match(src, /apiPost<LoginApiResponse>\("\/auth\/mfa\/challenge", \{\s*\n\s*preAuthToken: challenge\.preAuthToken,\s*\n\s*code: trimmed,/);
  // writeAuthToken is called exactly once, on a classified SESSION token.
  const writes = src.match(/writeAuthToken\(/g) ?? [];
  assert.equal(writes.length, 1, "exactly one writeAuthToken call site");
  assert.match(src, /function completeSignIn\(session: Extract<ClassifiedLogin, \{ kind: "session" \}>\) \{\s*\n\s*writeAuthToken\(session\.token\);/);
  assert.doesNotMatch(src, /writeAuthToken\([^)]*preAuth/i, "the pre-auth token must never be stored as a session");
  assert.doesNotMatch(src, /localStorage\.setItem\([^)]*preAuth/i);
  // Errors are read from .body, never .payload.
  assert.doesNotMatch(src, /\.payload\b/);
  assert.match(src, /mfaChallengeErrorMessage\(e\.status, body\)/);
  // GRACE redirect goes through the shared helper.
  assert.match(src, /session\.mfaEnrollmentRequired \? securityPageDestination\(landing\) : landing/);
  // A `next` param is only ever followed through the same-origin guard.
  assert.match(src, /safeNextPath\(next\)/);
  assert.doesNotMatch(src, /decodeURIComponent\(next\)/, "the raw next param must not be navigated to");
});

test("⛔ security page: default export only, phrases registered, errors read .body", () => {
  const src = read("../app/(platform)/account/security/page.tsx");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const exportsInPage = [...src.matchAll(/^export\s+(?!default)/gm)];
  assert.equal(exportsInPage.length, 0, "a page.tsx may only export its default component (production build rule)");
  assert.match(src, /import \{ SECURITY_PHRASES \} from "\.\/phrases"/);
  assert.match(src, /useUiLanguage\(SECURITY_PHRASES\)/);
  assert.doesNotMatch(code, /\.payload\b/, "ApiError has .body, not .payload (CLAUDE.md)");
  assert.match(src, /e\.body as \{ error\?: string; message\?: string \} \| null/);
  for (const url of ['"/auth/mfa/status"', '"/auth/mfa/totp/setup"', '"/auth/mfa/totp/verify"', '"/auth/mfa/recovery-codes/regenerate"', '"/auth/mfa/disable"']) {
    assert.ok(src.includes(url), `${url} must be called from the page`);
  }
  assert.match(src, /QRCodeSVG value=\{mode\.setup\.otpauthUri\}/);
  assert.match(src, /<Suspense/, "useSearchParams needs a Suspense boundary for the production build");
  // Every literal handed to t() is in the phrase list.
  const phrases = read("../app/(platform)/account/security/phrases.ts");
  const used = [...src.matchAll(/(?<![A-Za-z0-9_.])t\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]);
  assert.ok(used.length > 10, `expected many t() calls, found ${used.length}`);
  for (const u of used) {
    assert.ok(phrases.includes(`"${u}"`), `phrase not registered for Yiddish: ${u}`);
  }
});

test("⛔ the security page is reachable: profile menu links it, and the dashboard mounts the enrolment nudge", () => {
  const menu = read("../components/ProfileMenu.tsx");
  assert.match(menu, /router\.push\("\/account\/security"\)/);
  const dash = read("../app/(platform)/dashboard/page.tsx");
  assert.match(dash, /<MfaEnrollmentNudge \/>/);
  const nudge = read("../components/MfaEnrollmentNudge.tsx");
  assert.match(nudge, /if \(!hasBrowserAuthToken\(\)\) return;/, "the nudge must not fire an unauthenticated /auth/mfa/status");
  assert.match(nudge, /"\/auth\/mfa\/status"/);
  assert.match(nudge, /href="\/account\/security\?setup=1"/);
});
