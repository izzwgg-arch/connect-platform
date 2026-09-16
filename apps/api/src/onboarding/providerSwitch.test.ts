/**
 * Wizard carrier switch — tests.
 *
 * The switch decides which carrier NEW sign-ups search and buy from, so the
 * failure modes that matter are: the stored value silently not applying, a
 * value the wizard cannot honour being stored anyway (the lying-toggle rule),
 * and the resolver throwing into live onboarding. Plus the wiring guards:
 * publicRoutes must ask the RESOLVER (not the sync env fn) at every site.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ONBOARDING_PROVIDER_SECRET_KEY,
  clearOnboardingProviderCache,
  onboardingNumberProvider,
  resolveOnboardingNumberProvider,
  storeOnboardingNumberProvider,
} from "./signalWireNumbers";
import { registerProviderSwitchRoutes } from "./providerSwitchRoutes";

const src = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const TEST_MASTER_KEY = "a".repeat(64);

function fakeDb(row: { valueEnc: string } | null) {
  const calls: Record<string, unknown[]> = { findUnique: [], upsert: [], deleteMany: [] };
  return {
    calls,
    agentSecret: {
      findUnique: async (args: unknown) => { calls.findUnique.push(args); return row; },
      upsert: async (args: unknown) => { calls.upsert.push(args); return {}; },
      deleteMany: async (args: unknown) => { calls.deleteMany.push(args); return {}; },
    },
    agentAuditLog: { create: async () => ({}) },
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    clearOnboardingProviderCache();
  });
}

test("resolver falls back to the env behaviour when nothing is stored (live onboarding unchanged)", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: undefined, ONBOARDING_NUMBER_PROVIDER: undefined }, async () => {
    clearOnboardingProviderCache();
    assert.equal(await resolveOnboardingNumberProvider(fakeDb(null)), "voipms");
  });
  await withEnv({ CREDENTIALS_MASTER_KEY: undefined, ONBOARDING_NUMBER_PROVIDER: "signalwire" }, async () => {
    clearOnboardingProviderCache();
    assert.equal(await resolveOnboardingNumberProvider(fakeDb(null)), "signalwire");
    assert.equal(onboardingNumberProvider(), "signalwire");
  });
});

test("a stored choice beats the env, round-tripped through the real encryption", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: TEST_MASTER_KEY, ONBOARDING_NUMBER_PROVIDER: "voipms" }, async () => {
    const sec = await import("@connect/security");
    const db = fakeDb({ valueEnc: sec.encryptJson({ provider: "signalwire" }) });
    clearOnboardingProviderCache();
    assert.equal(await resolveOnboardingNumberProvider(db), "signalwire");
  });
});

test("a stored telnyx choice is honoured since the wizard grew its Telnyx path (2026-09-16)", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: TEST_MASTER_KEY, ONBOARDING_NUMBER_PROVIDER: undefined }, async () => {
    const sec = await import("@connect/security");
    clearOnboardingProviderCache();
    assert.equal(await resolveOnboardingNumberProvider(fakeDb({ valueEnc: sec.encryptJson({ provider: "telnyx" }) })), "telnyx");
  });
  await withEnv({ CREDENTIALS_MASTER_KEY: undefined, ONBOARDING_NUMBER_PROVIDER: "telnyx" }, async () => {
    assert.equal(onboardingNumberProvider(), "telnyx");
  });
});

test("⛔ a stored value the wizard cannot honour (garbage) is IGNORED, never returned", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: TEST_MASTER_KEY, ONBOARDING_NUMBER_PROVIDER: undefined }, async () => {
    const sec = await import("@connect/security");
    for (const provider of ["carrier-x", "TELNYX-ish", ""]) {
      clearOnboardingProviderCache();
      const db = fakeDb({ valueEnc: sec.encryptJson({ provider }) });
      assert.equal(await resolveOnboardingNumberProvider(db), "voipms", `stored "${provider}" must fall back to env`);
    }
  });
});

test("⛔ the resolver NEVER throws into the wizard — a broken row reads as the env behaviour", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: TEST_MASTER_KEY, ONBOARDING_NUMBER_PROVIDER: undefined }, async () => {
    clearOnboardingProviderCache();
    const db = fakeDb({ valueEnc: "not-an-envelope" });
    assert.equal(await resolveOnboardingNumberProvider(db), "voipms");
    clearOnboardingProviderCache();
    const throwing: any = { agentSecret: { findUnique: async () => { throw new Error("db down"); } } };
    assert.equal(await resolveOnboardingNumberProvider(throwing), "voipms");
  });
});

test("store writes the encrypted row; clear deletes it; both clear the cache", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: TEST_MASTER_KEY, ONBOARDING_NUMBER_PROVIDER: undefined }, async () => {
    const db = fakeDb(null);
    await storeOnboardingNumberProvider(db as any, "signalwire", "user:test");
    assert.equal(db.calls.upsert.length, 1);
    const upsert: any = db.calls.upsert[0];
    assert.equal(upsert.where.key, ONBOARDING_PROVIDER_SECRET_KEY);
    const sec = await import("@connect/security");
    assert.deepEqual(sec.decryptJson(upsert.create.valueEnc), { provider: "signalwire" });
    await storeOnboardingNumberProvider(db as any, null, "user:test");
    assert.equal(db.calls.deleteMany.length, 1);
  });
});

test("the PUT route stores telnyx, refuses garbage, and the GET declares every carrier selectable", async () => {
  await withEnv({ CREDENTIALS_MASTER_KEY: TEST_MASTER_KEY, ONBOARDING_NUMBER_PROVIDER: undefined }, async () => {
    const routes: Record<string, (req: any, reply: any) => Promise<any>> = {};
    const app = {
      get: (p: string, h: any) => { routes[`GET ${p}`] = h; },
      put: (p: string, h: any) => { routes[`PUT ${p}`] = h; },
    };
    registerProviderSwitchRoutes({ app, db: fakeDb(null), requireOwner: async () => ({ sub: "owner" }) });

    function replyRecorder() {
      const r: any = { statusCode: 200, body: null };
      r.code = (c: number) => { r.statusCode = c; return r; };
      r.send = (b: unknown) => { r.body = b; return r; };
      return r;
    }

    const put = replyRecorder();
    await routes["PUT /admin/carrier-switch"]({ body: { provider: "telnyx" } }, put);
    assert.equal(put.statusCode, 200);
    assert.equal(put.body?.stored, "telnyx");

    const bad = replyRecorder();
    await routes["PUT /admin/carrier-switch"]({ body: { provider: "carrier-x" } }, bad);
    assert.equal(bad.statusCode, 400);

    const get = replyRecorder();
    await routes["GET /admin/carrier-switch"]({}, get);
    const opts = get.body?.options ?? [];
    for (const v of ["voipms", "signalwire", "telnyx"]) {
      assert.ok(opts.find((o: any) => o.value === v)?.selectable === true, `${v} must be selectable`);
    }
  });
});

// ── SOURCE guards ───────────────────────────────────────────────────────────

test("publicRoutes asks the RESOLVER at every provider site, and never the sync env fn", () => {
  const s = src("onboarding/publicRoutes.ts");
  const resolverCalls = s.match(/await resolveOnboardingNumberProvider\(db\)/g) ?? [];
  assert.ok(resolverCalls.length >= 3, `expected the 3 provider sites on the resolver, found ${resolverCalls.length}`);
  assert.doesNotMatch(s, /[^e]onboardingNumberProvider\(\)/, "publicRoutes must not call the sync env-only function directly");
});

test("server.ts registers the switch routes and gives /admin/carrier-switch a permission rule", () => {
  const server = src("server.ts");
  assert.match(server, /import \{ registerProviderSwitchRoutes \} from "\.\/onboarding\/providerSwitchRoutes";/);
  assert.match(server, /registerProviderSwitchRoutes\(\{\s*app,\s*db,\s*requireOwner: \(req, reply\) => requireSuperAdmin\(req, reply\),\s*\}\);/);
  assert.match(server, /\{ prefix: "\/admin\/carrier-switch", permission: "can_manage_global_settings" \}/);
});

test("every /admin/carrier-switch route opens with requireOwner", () => {
  const s = src("onboarding/providerSwitchRoutes.ts");
  const parts = s.split(/app\.(?:get|put)\("\/admin\/carrier-switch"/).slice(1);
  assert.equal(parts.length, 2, "expected the GET and PUT routes");
  for (const part of parts) {
    assert.match(part.slice(0, 220), /const user = await requireOwner\(req, reply\);\s*if \(!user\) return;/);
  }
});
