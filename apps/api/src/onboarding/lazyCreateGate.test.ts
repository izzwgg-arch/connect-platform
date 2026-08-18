import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canLazyCreate } from "./publicRoutes";

/**
 * Guard for the fix to §5 of AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md.
 *
 * The gate used to be `NODE_ENV !== "production"`, and `app-api-1` sets no
 * NODE_ENV — so an anonymous caller could PUT an unknown token into existence
 * and walk it all the way to a real Tenant + BillingInvoice.
 *
 * ⛔ Two properties are asserted, and the second is the one that matters:
 *   1. the gate defaults to CLOSED with no env at all;
 *   2. NODE_ENV has no influence on it whatsoever — the old failure mode was a
 *      gate that read a variable the container never sets.
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("⛔ canLazyCreate: defaults to CLOSED when no env var is set at all", () => {
  withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: undefined, NODE_ENV: undefined }, () => {
    assert.equal(canLazyCreate(), false);
  });
});

test("⛔ canLazyCreate: NODE_ENV is irrelevant — this is the whole point of the fix", () => {
  // The old gate returned TRUE for every one of these.
  for (const nodeEnv of [undefined, "", "development", "test", "staging", "production"]) {
    withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: undefined, NODE_ENV: nodeEnv }, () => {
      assert.equal(
        canLazyCreate(),
        false,
        `lazy-create must stay closed with NODE_ENV=${String(nodeEnv)}`,
      );
    });
  }
});

test("canLazyCreate: an EMPTY opt-in variable is still closed (the `\"\"` is falsy trap)", () => {
  withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: "", NODE_ENV: undefined }, () => {
    assert.equal(canLazyCreate(), false);
  });
});

test("canLazyCreate: junk values are closed, not open", () => {
  for (const v of ["0", "false", "no", "off", "maybe", " ", "prod"]) {
    withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: v }, () => {
      assert.equal(canLazyCreate(), false, `value ${JSON.stringify(v)} must not open the gate`);
    });
  }
});

test("canLazyCreate: local dev can opt in explicitly", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: v }, () => {
      assert.equal(canLazyCreate(), true, `value ${JSON.stringify(v)} should open the gate`);
    });
  }
});

test("canLazyCreate: the opt-in wins even with NODE_ENV=production (dev override is unconditional)", () => {
  withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: "1", NODE_ENV: "production" }, () => {
    assert.equal(canLazyCreate(), true);
  });
});

test("canLazyCreate: read at CALL time, not module load", () => {
  withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: undefined }, () => {
    assert.equal(canLazyCreate(), false);
  });
  withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: "1" }, () => {
    assert.equal(canLazyCreate(), true);
  });
  withEnv({ ONBOARDING_ALLOW_LAZY_CREATE: undefined }, () => {
    assert.equal(canLazyCreate(), false);
  });
});

// ── Source guard: the NODE_ENV dependency must not creep back ──────────────────

test("⛔ source: publicRoutes.ts no longer branches on NODE_ENV", () => {
  const src = readFileSync(resolve(__dirname, "./publicRoutes.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    (src.match(/NODE_ENV/g) || []).length,
    0,
    "NODE_ENV must not appear in executable code in publicRoutes.ts",
  );
  assert.ok(
    src.includes("ONBOARDING_ALLOW_LAZY_CREATE"),
    "the explicit opt-in variable must be the only lever",
  );
});

test("⛔ source: both lazy-create call sites still consult the gate", () => {
  const src = readFileSync(resolve(__dirname, "./publicRoutes.ts"), "utf8");
  // One definition (`export function canLazyCreate()`) plus exactly two call sites.
  const callSites = (src.match(/(?<!function )canLazyCreate\(\)/g) || []).length;
  assert.equal(
    callSites,
    2,
    "the validate route and the save route must both gate on canLazyCreate()",
  );
  assert.ok(
    /if \(!canLazyCreate\(\)\) \{[\s\S]{0,600}?onboardingSubmission\.create/.test(src),
    "the save route must refuse BEFORE creating a submission",
  );
});
