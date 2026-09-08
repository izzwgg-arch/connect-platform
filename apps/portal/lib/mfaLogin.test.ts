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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyLoginResponse,
  isSubmittableMfaCode,
  looksLikeRecoveryCodeInput,
  looksLikeTotpCodeInput,
  mfaChallengeErrorMessage,
  normalizeMfaCodeInput,
  otpChannelLabel,
  otpChoiceLabel,
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
  assert.match(src, /function completeSignIn\(session: Extract<ClassifiedLogin, \{ kind: "session" \}>\) \{[\s\S]{0,400}?writeAuthToken\(session\.token\);/);
  assert.match(src, /writeAuthToken\(session\.token\);/, "the ONE write is the classified session token");
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

// ─── per-tenant sign-in code + Turnstile (2026-08-19; v2 2026-09-08) ─────────

test("classifyLoginResponse (v2): choose-channel → awaitingChannel with both masked destinations; a one-channel send → straight to the code; a token still always wins; no trusted-device fields exist", () => {
  const choose = classifyLoginResponse({ otpChallengeRequired: true, preAuthToken: "p".repeat(40), expiresInSeconds: 300, channels: ["SMS", "EMAIL"], destinations: { SMS: "•••-•••-1234", EMAIL: "b••••@acme.test" }, sent: false, reason: "choose_channel", error: "otp_required" });
  assert.equal(choose.kind, "otp_challenge");
  if (choose.kind === "otp_challenge") {
    assert.equal(choose.awaitingChannel, true);
    assert.deepEqual(choose.channels, ["SMS", "EMAIL"]);
    assert.deepEqual(choose.destinations, { SMS: "•••-•••-1234", EMAIL: "b••••@acme.test" });
    assert.equal(choose.sent, false);
    assert.equal(choose.expiresInSeconds, 300);
  }
  const sentNow = classifyLoginResponse({ otpChallengeRequired: true, preAuthToken: "p".repeat(40), channel: "EMAIL", channels: ["EMAIL"], destinations: { EMAIL: "o•••••@acme.test" }, destination: "o•••••@acme.test", sent: true });
  assert.equal(sentNow.kind === "otp_challenge" && sentNow.awaitingChannel, false, "one channel, already sent → no choice screen");
  assert.equal(sentNow.kind === "otp_challenge" && sentNow.channel, "EMAIL");
  assert.equal(sentNow.kind === "otp_challenge" && sentNow.destination, "o•••••@acme.test");
  const oldShape = classifyLoginResponse({ otpChallengeRequired: true, preAuthToken: "p".repeat(40), channels: ["SMS", "EMAIL"], sent: false });
  assert.equal(oldShape.kind === "otp_challenge" && oldShape.awaitingChannel, true, "two channels and no channel used yet → choose, even without the reason");
  const junkDest = classifyLoginResponse({ otpChallengeRequired: true, preAuthToken: "p".repeat(40), channels: ["SMS"], destinations: { SMS: 5, PIGEON: "x" } as any, sent: true, channel: "SMS" });
  assert.deepEqual(junkDest.kind === "otp_challenge" && junkDest.destinations, {}, "only string destinations for offered channels survive");
  assert.equal(classifyLoginResponse({ otpChallengeRequired: true }).kind, "failed", "no pre-auth token → not a challenge");
  const withToken = classifyLoginResponse({ token: "t", otpChallengeRequired: true, preAuthToken: "p".repeat(40) });
  assert.equal(withToken.kind, "session", "a token always wins");
  const plain = classifyLoginResponse({ token: "t", trustedDeviceToken: "d".repeat(48) } as any);
  assert.equal(plain.kind === "session" && "trustedDeviceToken" in plain, false, "v2: a v1 device token in the body is dropped on the floor");
  assert.equal(otpChoiceLabel("SMS", "•••-•••-1234"), "Text me at •••-•••-1234");
  assert.equal(otpChoiceLabel("EMAIL", undefined), "Email me");
  assert.equal(otpChannelLabel("SMS"), "text message");
});

test("⛔ login page (v2): choose text or email → /auth/otp/send with the pre-auth token → /auth/otp/verify; no remember-me, no device token, the pre-auth token is never stored", () => {
  const src = read("../app/login/page.tsx");
  assert.match(src, /apiPost<OtpSendResponse>\("\/auth\/otp\/send", \{\s*\n\s*preAuthToken: otp\.preAuthToken,\s*\n\s*channel,/);
  assert.match(src, /apiPost<LoginApiResponse>\("\/auth\/otp\/verify", \{\s*\n\s*preAuthToken: otp\.preAuthToken,\s*\n\s*code: trimmed,\s*\n\s*\}\)/);
  assert.match(src, /apiPost<[^>]*>\("\/auth\/otp\/resend", \{\s*\n\s*preAuthToken: otp\.preAuthToken,/);
  assert.match(src, /classified\.kind === "otp_challenge"/);
  assert.match(src, /if \(otp && otp\.awaitingChannel\)/, "the choice screen is its own render branch");
  assert.match(src, /otp\.channels\.map\(\(c\) =>/, "one button per offered channel");
  assert.match(src, /otp\.destinations\[c\]/, "each button shows the masked registered destination");
  assert.match(src, /className="lc-login-choice"/);
  // v1 leftovers must be gone from the page.
  assert.doesNotMatch(src, /rememberDevice|trustedDevice|TrustedDevice|Remember this device|90 days/);
  // The only session write is inside completeSignIn, from a classified session; the pre-auth token never goes near it.
  const tokenWrites = src.match(/writeAuthToken\(/g) ?? [];
  assert.equal(tokenWrites.length, 1);
  assert.match(src, /writeAuthToken\(session\.token\)/);
  assert.doesNotMatch(src, /writeAuthToken\([^)]*preAuth/i);
  assert.match(src, /autoComplete="one-time-code"/);
  // Turnstile: rendered only when a site key is configured; the token rides the login body; a human_check_ refusal resets the widget.
  assert.match(src, /TURNSTILE_SITE_KEY \? <TurnstileWidget/);
  assert.match(src, /\.\.\.\(turnstileToken \? \{ turnstileToken \} : \{\}\)/);
  assert.match(src, /errCode\.startsWith\("human_check_"\)/);
});

test("⛔ v2 sign-out is the ONLY thing that ends a verified sign-in: clearAuthSession drops the session AND the v1 device token; lib/trustedDevice.ts is gone", () => {
  const s = read("../services/session.ts");
  const fn = s.slice(s.indexOf("export function clearAuthSession("), s.indexOf("export function readTenantContext("));
  assert.match(fn, /localStorage\.removeItem\("cc-trusted-device"\)/);
  assert.equal(existsSync(join(here, "trustedDevice.ts")), false, "the remember-this-device module was deleted, not left dead");
});

test("TurnstileWidget: renders nothing without a site key and loads only Cloudflare's script", () => {
  const tw = read("../components/TurnstileWidget.tsx");
  assert.match(tw, /if \(!TURNSTILE_SITE_KEY\) return null;/);
  // The URL moved into lib/turnstileScript.ts so app/login/layout.tsx can
  // preload the byte-identical string. The property this guards is unchanged —
  // the widget must load Cloudflare's script and nothing else — so follow it
  // one hop rather than dropping the assertion.
  assert.match(tw, /from "\.\.\/lib\/turnstileScript"/, "the widget must take its script URL from the shared module");
  assert.match(read("./turnstileScript.ts"), /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  assert.doesNotMatch(tw, /TURNSTILE_SECRET/, "the secret never reaches the browser");
  assert.match(tw, /"expired-callback": \(\) => onToken\(""\)/, "an expired token is cleared, not resent");
});
