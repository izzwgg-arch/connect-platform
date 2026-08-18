import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isEnvFlagEnabled } from "./envFlag";
import {
  CARDKNOX_ALLOW_SIMULATE_VAR,
  CARDKNOX_SIMULATE_VAR,
  assertCardknoxNotSimulating,
  decideCardknoxSimulate,
} from "./cardknoxSimulateGuard";
import { shouldTolerateMissingRedis } from "./redis";
import { CRM_FORM_ALLOW_EPHEMERAL_VAR, getCrmFormStorageRoot } from "./crm/formStorage";

/**
 * ⛔ THE BUG CLASS THIS FILE EXISTS FOR.
 *
 * `NODE_ENV` is UNDEFINED in `app-api-1` (proven live 2026-08-18:
 * `docker exec app-api-1 printenv NODE_ENV` → empty, exit 1; `app-telephony-1`
 * prints `production`). Every `process.env.NODE_ENV === "production"` branch in
 * apps/api is therefore permanently false, and every safety check written that
 * way had never executed in production. The login throttle, the error-leak
 * handler and the anonymous tenant-creation gate were each fixed separately;
 * this is the rest of the sweep.
 *
 * ⛔ Each test below sets NODE_ENV to every plausible value and asserts the
 * verdict does not move. A gate that still reads NODE_ENV cannot pass these.
 */

const NODE_ENV_VALUES = [undefined, "", "production", "development", "test", "staging", "PRODUCTION"];

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    prior.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SRC = (...p: string[]) => readFileSync(path.join(__dirname, ...p), "utf8");
const SERVER_TS = SRC("server.ts");

// ── the shared truthiness rule ───────────────────────────────────────────────

test("isEnvFlagEnabled accepts every spelling the codebase already uses", () => {
  for (const on of ["1", "true", "TRUE", " True ", "yes", "on"]) {
    assert.equal(isEnvFlagEnabled(on), true, `${JSON.stringify(on)} must read as ON`);
  }
  for (const off of [undefined, null, "", "   ", "0", "false", "no", "off", "maybe", "2"]) {
    assert.equal(isEnvFlagEnabled(off as any), false, `${JSON.stringify(off)} must read as OFF`);
  }
});

// ── 1. Cardknox simulate: the payment guard that never ran ───────────────────

test("⛔ cardknox: simulate refuses boot regardless of NODE_ENV — the whole bug", () => {
  for (const nodeEnv of NODE_ENV_VALUES) {
    const d = decideCardknoxSimulate({
      NODE_ENV: nodeEnv,
      [CARDKNOX_SIMULATE_VAR]: "true",
    } as Record<string, string | undefined>);
    assert.equal(d.action, "refuse_boot", `must refuse with NODE_ENV=${String(nodeEnv)}`);
    assert.equal(d.reason, "simulate_not_allowed");
  }
});

test("⛔ cardknox: `=1` is caught too — solaGateway.ts reads '1', the old guard only read 'true'", () => {
  // This exact value put billing/solaGateway.ts into simulate mode while the
  // old boot guard stayed silent. It is the second hole in the same guard.
  for (const spelling of ["1", "true", "yes", "on", "TRUE"]) {
    const d = decideCardknoxSimulate({ [CARDKNOX_SIMULATE_VAR]: spelling });
    assert.equal(d.simulateRequested, true, `${spelling} must count as simulate`);
    assert.equal(d.action, "refuse_boot");
  }
});

test("cardknox: off / unset boots normally", () => {
  for (const off of [undefined, "", "false", "0", "no"]) {
    const d = decideCardknoxSimulate({ [CARDKNOX_SIMULATE_VAR]: off });
    assert.equal(d.simulateRequested, false);
    assert.equal(d.action, "boot");
    assert.equal(d.reason, "not_simulating");
  }
});

test("cardknox: a developer opts in with BOTH variables, and only then", () => {
  const d = decideCardknoxSimulate({
    [CARDKNOX_SIMULATE_VAR]: "1",
    [CARDKNOX_ALLOW_SIMULATE_VAR]: "1",
  });
  assert.equal(d.action, "boot");
  assert.equal(d.reason, "explicit_dev_override");

  // The override alone must not turn simulation on.
  const off = decideCardknoxSimulate({ [CARDKNOX_ALLOW_SIMULATE_VAR]: "1" });
  assert.equal(off.simulateRequested, false);
  assert.equal(off.action, "boot");
});

test("cardknox: the boot assertion throws, and names the override", () => {
  assert.throws(
    () => assertCardknoxNotSimulating({ [CARDKNOX_SIMULATE_VAR]: "true" }),
    (e: Error) => e.message.includes(CARDKNOX_ALLOW_SIMULATE_VAR) && /FAKED/.test(e.message),
  );
  assert.doesNotThrow(() => assertCardknoxNotSimulating({ [CARDKNOX_SIMULATE_VAR]: "false" }));
});

test("✅ production's real value boots: SOLA_CARDKNOX_SIMULATE=false (read live from app-api-1)", () => {
  // If this ever fails, the api will not start. Verified 2026-08-18 that the
  // live value in app-api-1 and app-worker-1 is the literal string "false".
  const d = decideCardknoxSimulate({ [CARDKNOX_SIMULATE_VAR]: "false", NODE_ENV: undefined });
  assert.equal(d.action, "boot");
});

// ── 2. CRM form storage: the ephemeral-root data-loss guard ──────────────────

test("⛔ crm forms: no configured root fails closed at every NODE_ENV", () => {
  for (const nodeEnv of NODE_ENV_VALUES) {
    withEnv(
      {
        NODE_ENV: nodeEnv,
        CRM_FORM_STORAGE_DIR: undefined,
        CRM_DOC_STORAGE_DIR: undefined,
        [CRM_FORM_ALLOW_EPHEMERAL_VAR]: undefined,
      },
      () => {
        assert.throws(
          () => getCrmFormStorageRoot(),
          /crm_form_storage_dir_required/,
          `must refuse an in-image root with NODE_ENV=${String(nodeEnv)}`,
        );
      },
    );
  }
});

test("✅ crm forms: production's real value is accepted (CRM_DOC_STORAGE_DIR, both compose blocks)", () => {
  withEnv(
    {
      NODE_ENV: undefined,
      CRM_FORM_STORAGE_DIR: undefined,
      CRM_DOC_STORAGE_DIR: "/var/lib/connect/crm-lead-docs",
      [CRM_FORM_ALLOW_EPHEMERAL_VAR]: undefined,
    },
    () => {
      assert.equal(getCrmFormStorageRoot(), "/var/lib/connect/crm-lead-docs");
    },
  );
});

test("crm forms: a developer opts into the throwaway root explicitly", () => {
  withEnv(
    {
      CRM_FORM_STORAGE_DIR: undefined,
      CRM_DOC_STORAGE_DIR: undefined,
      [CRM_FORM_ALLOW_EPHEMERAL_VAR]: "1",
    },
    () => {
      assert.ok(getCrmFormStorageRoot().length > 0);
    },
  );
});

test("⛔ crm forms: BOTH api compose blocks must keep the storage dir + its volume", () => {
  // The throw above is only safe because api AND api_candidate carry it. A
  // blue/green cutover onto a block missing either one would 500 every CRM
  // form upload — this is the check that keeps that from happening quietly.
  const compose = readFileSync(
    path.join(__dirname, "..", "..", "..", "docker-compose.app.yml"),
    "utf8",
  );
  assert.equal(
    (compose.match(/^\s+CRM_DOC_STORAGE_DIR:/gm) || []).length,
    2,
    "both api and api_candidate must set CRM_DOC_STORAGE_DIR",
  );
  assert.ok(
    (compose.match(/crm-lead-docs:\/var\/lib\/connect\/crm-lead-docs/g) || []).length >= 2,
    "both api and api_candidate must mount the crm-lead-docs volume",
  );
});

// ── 3. Redis dev fallback ────────────────────────────────────────────────────

test("⛔ redis: the quiet/no-retry fallback is keyed on REDIS_URL, never NODE_ENV", () => {
  for (const nodeEnv of NODE_ENV_VALUES) {
    assert.equal(
      shouldTolerateMissingRedis({ NODE_ENV: nodeEnv, REDIS_URL: "redis://connectcomms-redis:6379" }),
      false,
      `a configured REDIS_URL must always mean "retry and surface errors" (NODE_ENV=${String(nodeEnv)})`,
    );
    assert.equal(
      shouldTolerateMissingRedis({ NODE_ENV: nodeEnv, REDIS_URL: undefined }),
      true,
      `no REDIS_URL must always mean the dev fallback (NODE_ENV=${String(nodeEnv)})`,
    );
  }
  assert.equal(shouldTolerateMissingRedis({ REDIS_URL: "   " }), true, "blank is not configured");
});

// ── 4. Source guards: the dependency must not creep back ─────────────────────
//
// ⛔ These read the CALL SITES' source on purpose. Every defect of this shape
// has been a caller, and a unit test of the pure function passes straight
// through one.

test("⛔ source: redis.ts contains no NODE_ENV at all", () => {
  const code = SRC("redis.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes("NODE_ENV"), "redis.ts must not branch on NODE_ENV in executable code");
});

test("⛔ source: crm/formStorage.ts contains no NODE_ENV at all", () => {
  const code = SRC("crm", "formStorage.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes("NODE_ENV"), "formStorage.ts must not branch on NODE_ENV in executable code");
});

test("⛔ source: cardknoxSimulateGuard.ts contains no NODE_ENV at all", () => {
  const code = SRC("cardknoxSimulateGuard.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes("NODE_ENV"), "the payment guard must never be gated on NODE_ENV again");
});

test("⛔ source: server.ts calls the cardknox guard, and no longer has the dead inline check", () => {
  assert.ok(
    SERVER_TS.includes("assertCardknoxNotSimulating()"),
    "server.ts must call the boot guard",
  );
  assert.ok(
    SERVER_TS.includes('from "./cardknoxSimulateGuard"'),
    "server.ts must import the boot guard",
  );
  assert.ok(
    !/NODE_ENV\s*===\s*"production"\s*&&\s*\(process\.env\.SOLA_CARDKNOX_SIMULATE/.test(SERVER_TS),
    "the permanently-false inline Cardknox check must not come back",
  );
});

test("⛔ source: the dev-observe SUPER_ADMIN token route has no NODE_ENV bypass", () => {
  // canIssueDevObserveJwt gates a JWT-BYPASSED route that mints a SUPER_ADMIN
  // token scoped to tenantId "global". Its old first line was
  // `if (NODE_ENV === "development") return true;` — no secret required.
  const start = SERVER_TS.indexOf("function canIssueDevObserveJwt");
  assert.ok(start > 0, "canIssueDevObserveJwt must still exist");
  const body = SERVER_TS.slice(start, start + 1400);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes("NODE_ENV"), "the only key to this route must be DEV_OBSERVE_TOKEN_SECRET");
  assert.ok(code.includes("DEV_OBSERVE_TOKEN_SECRET"), "the secret check must remain");
});

test("⛔ source: apps/api/src has exactly ONE remaining executable NODE_ENV reader", () => {
  // A whole-tree sweep of EXECUTABLE code (comments stripped — several files
  // quote the old broken line in their doc blocks on purpose).
  //
  // `ops/serverHealth.ts` is the one deliberate survivor and is NOT a security
  // gate: `isLocalDevHost()` only picks which URL to probe for a health
  // readout. Its production branch (`PORTAL_INTERNAL_URL` / `http://portal:3000`)
  // is what the permanently-false condition already selects, so the gate is
  // dead in the CORRECT direction, and `process.platform === "win32"` covers
  // the actual local-dev case without NODE_ENV. Changing it would alter a
  // working health probe for no security benefit.
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const repoRoot = path.join(__dirname, "..", "..", "..");
  let candidates: string[] = [];
  try {
    candidates = execSync('git grep -l "process.env.NODE_ENV" -- apps/api/src', {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  } catch {
    return; // git unavailable in this environment — the targeted guards above still apply
  }
  const executable = candidates.filter((f) => {
    const stripped = readFileSync(path.join(repoRoot, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    return stripped.includes("process.env.NODE_ENV");
  });
  assert.deepEqual(
    executable.sort(),
    ["apps/api/src/ops/serverHealth.ts"],
    "a new executable NODE_ENV branch appeared in apps/api — it is permanently false in production, see CLAUDE.md",
  );
});
