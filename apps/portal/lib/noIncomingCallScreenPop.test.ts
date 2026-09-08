/**
 * Guard: the CRM incoming-call screen pop stays gone (2026-09-08).
 *
 * Izzy, looking at the white "Incoming Call / Unknown caller / Dismiss" card in
 * the bottom-right corner of the portal: "Just remove those notifications
 * completely. I don't want to see those incoming call notifications in the
 * main tenant or any other tenant. The only incoming call notifications I want
 * to see are the actual incoming calls."
 *
 * The actual incoming call is the ringing softphone (floating dialer, Windows
 * mini dialer, phone app). Nothing else may pop for a ring. This test fails if
 * the component file comes back or anything under apps/portal mounts it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const portalRoot = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}

test("the CrmScreenPop component file does not exist", () => {
  assert.equal(existsSync(path.join(portalRoot, "components", "CrmScreenPop.tsx")), false);
});

test("nothing in apps/portal imports or mounts CrmScreenPop", () => {
  const offenders = walk(portalRoot)
    .filter((f) => !f.endsWith("noIncomingCallScreenPop.test.ts"))
    .filter((f) => /CrmScreenPop|crm-pop-slide-in/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(portalRoot, f));
  assert.deepEqual(offenders, []);
});

test("AppShell mounts only the assistant and the onboarding nudge beside the page", () => {
  const shell = readFileSync(path.join(portalRoot, "layout", "AppShell.tsx"), "utf8");
  assert.ok(!/ScreenPop/.test(shell));
  assert.ok(/<FloatingAssistant \/>/.test(shell));
  assert.ok(/<OnboardingSetupNudge \/>/.test(shell));
});
