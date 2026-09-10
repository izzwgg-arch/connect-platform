/**
 * Sign in with Google on the portal login page (2026-09-10) — the wording and
 * the wiring. The rules live in the api (apps/api/src/googleLogin.ts); the
 * portal's whole job is a link to the api's start route, taking the handoff
 * off the URL, and trading it for the ORDINARY login body so the 2FA screens
 * apply unchanged. Each of those is a caller-side property, so the guards read
 * the page's SOURCE (comment-stripped, CRLF-normalised).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GOOGLE_LOGIN_START_PATH, googleLoginErrorMessage } from "./mfaLogin";

const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
const stripLineComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\{\/\*|\*)/.test(l)).join("\n");

test("every google_error the api can send has a plain-English sentence, and none invites a sign-up", () => {
  const apiErrors = ["not_registered", "disabled", "cancelled", "expired", "not_configured", "google_failed", "email_unverified"];
  for (const code of apiErrors) {
    const msg = googleLoginErrorMessage(code);
    assert.ok(msg.length > 20, code);
    assert.doesNotMatch(msg, /\b(sign ?up|create an account|register)\b/i, `${code} must not invite a sign-up`);
    assert.doesNotMatch(msg, /_/, `${code} must not leak a slug`);
  }
  assert.match(googleLoginErrorMessage("not_registered"), /administrator/i);
  assert.match(googleLoginErrorMessage("not_registered"), /extension/i);
  assert.equal(googleLoginErrorMessage(""), "");
  assert.equal(googleLoginErrorMessage(null), "");
  assert.ok(googleLoginErrorMessage("something_new").length > 20, "an unknown slug still reads as a sentence");
  assert.equal(GOOGLE_LOGIN_START_PATH, "/auth/google/start");
});

test("login page: a Sign in with Google link to the api's start route, carrying a safe next", () => {
  const src = stripLineComments(read("../app/login/page.tsx"));
  assert.match(src, /className="lc-login-google"/);
  assert.match(src, /href=\{googleStartHref\(\)\}/);
  assert.match(src, /GOOGLE_LOGIN_START_PATH\}\?next=\$\{encodeURIComponent\(landing\)\}/);
  assert.match(src, /const landing = safeNextPath\(next\);\s*\n\s*return `\$\{getPortalApiBaseUrl\(\)\}\$\{GOOGLE_LOGIN_START_PATH\}/);
  // No Google script tag, no client-side token handling — a top-level navigation only.
  assert.doesNotMatch(src, /accounts\.google\.com\/gsi|google\.accounts\.id|id_token/);
});

test("login page: the handoff and any error are taken OFF the URL before anything else, then traded over POST", () => {
  const src = stripLineComments(read("../app/login/page.tsx"));
  const effect = src.slice(src.indexOf('const handoff = params.get("g")'), src.indexOf("void loginWithGoogleHandoff(String(handoff))"));
  assert.match(effect, /params\.delete\("g"\)/);
  assert.match(effect, /params\.delete\("google_error"\)/);
  assert.match(effect, /window\.history\.replaceState\(/);
  assert.ok(effect.indexOf("replaceState") < effect.length, "the URL is cleaned before the handoff is spent");
  assert.match(src, /apiPost<LoginApiResponse>\("\/auth\/google\/complete", \{ code: handoff \}\)/);
});

test("login page: Google's body goes through the SAME reader as a password login — challenges render, nothing is special-cased", () => {
  const src = stripLineComments(read("../app/login/page.tsx"));
  const google = src.slice(src.indexOf("async function loginWithGoogleHandoff("), src.indexOf("function otpSendNotice("));
  assert.match(google, /applyLoginResponse\(res\)/);
  const password = src.slice(src.indexOf("async function loginWithCredentials("), src.indexOf("async function submitCode("));
  assert.match(password, /applyLoginResponse\(res\)/);
  const reader = src.slice(src.indexOf("function applyLoginResponse("), src.indexOf("function googleStartHref("));
  assert.match(reader, /classified\.kind === "mfa_challenge"/);
  assert.match(reader, /classified\.kind === "otp_challenge"/);
  assert.match(reader, /completeSignIn\(classified\)/);
  // Exactly one place decides what a login body means.
  assert.equal((src.match(/classifyLoginResponse\(res\)/g) || []).length, 3, "applyLoginResponse + the two second-step submits; no extra classifier");
});

test("stylesheet: the Google button and divider exist and use the card's own tokens", () => {
  const css = read("../app/globals.css");
  assert.match(css, /\.lc-login-google \{[\s\S]*?height: 46px;[\s\S]*?border: 1px solid var\(--border\);[\s\S]*?color: var\(--text\);/);
  assert.match(css, /\.lc-login-or \{/);
  const block = css.slice(css.indexOf(".lc-login-or {"), css.indexOf("/* Two-step verification (MFA) step"));
  assert.ok(block.length > 200 && block.length < 4000, "the Google block sits before the MFA block");
  assert.doesNotMatch(block, /prefers-color-scheme/, "the login card follows the in-app theme, never the OS");
});

test("CRM pages: reply tracking and Drive import are described as not offered, never as 'reconnect to enable'", () => {
  const settings = stripLineComments(read("../app/(platform)/crm/email/settings/page.tsx"));
  assert.match(settings, /state === "unavailable"/);
  assert.doesNotMatch(settings, /"no_scope"|Reconnect for reply tracking|gmail\.readonly permission was not granted/);
  assert.match(settings, /Reply tracking not available/);
  assert.match(settings, /enableReplyTracking: false/);
  const email = stripLineComments(read("../app/(platform)/crm/email/page.tsx"));
  assert.match(email, /enableReplyTracking: false/);
  assert.doesNotMatch(email, /Enable in settings to track replies/);
  const drive = stripLineComments(read("../app/(platform)/crm/drive/page.tsx"));
  assert.match(drive, /status\.driveImportAvailable === false/);
  assert.match(drive, /status\.driveImportAvailable !== false && \(/);
});
