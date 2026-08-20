/**
 * Guards on hooks/useSipPhone.ts's init retry ladders (2026-08-20).
 *
 * The defect these pin: setup-class failures (PBX_NOT_LINKED,
 * EXTENSION_NOT_ASSIGNED/NOT_PROVISIONED, 403) used to retry on a fixed 60 s
 * loop forever. One loop per open window (the desktop app runs more than one)
 * consumed the entire per-user /voice/me/extension budget (60/hour), so a
 * fresh page load on an account that COULD register drew 429 on its first
 * credential fetch and the customer had to reload repeatedly before the
 * softphone registered. Setup-class failures must recheck on their own slow
 * ladder (capped in the minutes, not seconds), and retries must carry jitter
 * so several windows of one login don't march in lockstep against the shared
 * budget.
 *
 * These are source-reading guards on purpose: the defect is which lane a
 * failure path picks, and a unit test of a helper passes straight through a
 * caller that forgets the option.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// CRLF-normalise: Windows checkouts are CRLF and literal-\n matching breaks.
const src = readFileSync(
  path.join(__dirname, "..", "hooks", "useSipPhone.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

test("a slow setup-class retry ladder exists and is capped in minutes, not seconds", () => {
  assert.ok(/setupRetryDelayMs\s*=\s*60_000/.test(src), "slow ladder starts at 60s");
  assert.ok(
    /SETUP_RETRY_MAX_MS\s*=\s*15\s*\*\s*60_000/.test(src),
    "slow ladder caps at 15 minutes",
  );
});

test("400/403/404 from the credential endpoints are classified setup-class", () => {
  assert.ok(
    /isSetupClassError[\s\S]{0,200}e\.status === 400 \|\| e\.status === 403 \|\| e\.status === 404/.test(src),
    "isSetupClassError covers 400/403/404",
  );
});

test("every setup-shaped failure path takes the slow lane", () => {
  // The two fetch catches classify by status…
  const classified = src.match(/scheduleInitRetry\("(?:extension-fetch|credential-fetch)", \{ setupClass: isSetupClassError\(e\) \}\)/g) || [];
  assert.equal(classified.length, 2, "extension-fetch and credential-fetch classify the error");
  // …and the two known-config paths are hardwired slow.
  assert.ok(src.includes('scheduleInitRetry("config", { setupClass: true })'), "config gaps recheck slowly");
  assert.ok(src.includes('scheduleInitRetry("empty-credential", { setupClass: true })'), "missing SIP password rechecks slowly");
});

test("no failure path re-arms the old fixed 60s loop for setup problems", () => {
  // The old shape was `initRetryDelayMs = 60_000` immediately before a plain
  // scheduleInitRetry("config"/"empty-credential") — the fixed once-a-minute
  // recheck that starved the budget. Only the 429 branches may pin 60s.
  const stripped = src.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/initRetryDelayMs = 60_000;\s*\n\s*scheduleInitRetry\("(?:config|empty-credential)"\)/.test(stripped),
    "fixed 60s recheck for config problems must not return");
});

test("retries are jittered so parallel windows desynchronise", () => {
  assert.ok(/delay = Math\.round\(delay \* \(0\.85 \+ Math\.random\(\) \* 0\.3\)\)/.test(src), "±15% jitter applied");
});

test("a successful credential fetch resets the slow ladder", () => {
  assert.ok(/initRetryDelayMs = 5_000;[^\n]*\n\s*setupRetryDelayMs = 60_000;/.test(src), "both ladders reset on success");
});

// ── Sign-in wake-up (2026-08-20, the other half of "reload to register") ──
// The login page signs in via router.replace — a client-side navigation with
// NO page reload — so a provider that mounted on the signed-out login screen
// never remounts. Every token-gated effect that bails on !hasBrowserAuthToken()
// must therefore re-run when the token appears, or the phone engine (and the
// outbound-routes / extra-accounts fetches) stay dead until a manual reload.
// Proven live 2026-08-20 03:52 CEST: a real sign-in loaded the whole dashboard
// while the engine made ZERO credential fetches and opened no telephony WS.

test("the hook tracks token presence with a storage listener AND a same-window poll", () => {
  assert.ok(/const \[authTokenPresent, setAuthTokenPresent\] = useState/.test(src), "authTokenPresent state exists");
  assert.ok(/window\.addEventListener\("storage", check\)/.test(src), "cross-window storage listener");
  assert.ok(/setInterval\(check, 2_000\)/.test(src), "same-window poll (storage does not fire for own writes)");
});

test("the SIP engine effect re-runs when the token appears", () => {
  assert.ok(/\}, \[reinitSeq, authTokenPresent\]\);/.test(src), "engine effect keyed on reinitSeq AND authTokenPresent");
});

test("the outbound-routes and extra-accounts effects re-run when the token appears", () => {
  const keyed = src.match(/\}, \[authTokenPresent\]\);/g) || [];
  assert.equal(keyed.length, 2, "both token-gated fetch effects keyed on authTokenPresent");
});
