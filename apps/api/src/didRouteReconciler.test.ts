/**
 * The reconciler is the "silent decay is never silent" layer. These tests
 * drive full cycles with stubbed deps and assert the repair policies:
 * replay recorded intent only, rate-limit route re-asserts, alert on
 * everything, never let one broken mapping stop the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffAstDbKeys,
  expectedDidmapKeys,
  reassertAllowed,
  runReconcilerCycle,
  type DidRouteReconcilerDeps,
  type ReconcilerMapping,
  type ReconcilerState,
  type AstDbKV,
} from "./didRouteReconciler";

// ── pure helpers ────────────────────────────────────────────────────────────

test("diffAstDbKeys flags wrong and missing values, treats absent as empty string", () => {
  const expected: AstDbKV[] = [
    { family: "f", key: "a", value: "1" },
    { family: "f", key: "b", value: "" },
    { family: "f", key: "c", value: "3" },
  ];
  const live: AstDbKV[] = [
    { family: "f", key: "a", value: "1" },   // ok
    { family: "f", key: "c", value: "999" }, // wrong
    // b missing entirely — but expected empty, so NOT drift
  ];
  const drifted = diffAstDbKeys(expected, live);
  assert.deepEqual(drifted.map((d) => d.key), ["c"]);
});

test("expectedDidmapKeys: digits-keyed family, tenant + profile, tolerates null profile", () => {
  const mapping: ReconcilerMapping = {
    id: "m1", tenantId: "t1", e164: "+18457231213", enabled: true, routingMode: "connect", ivrProfileId: "prof1",
  };
  const keys = expectedDidmapKeys(mapping, "connect_communications");
  assert.deepEqual(keys, [
    { family: "connect/didmap/18457231213", key: "tenant", value: "connect_communications" },
    { family: "connect/didmap/18457231213", key: "profile_id", value: "prof1" },
  ]);
  assert.equal(expectedDidmapKeys({ ...mapping, ivrProfileId: null }, "s")[1].value, "");
  assert.deepEqual(expectedDidmapKeys({ ...mapping, e164: "garbage" }, "s"), []);
});

test("reassertAllowed: first time yes, inside window no, after window yes", () => {
  const HOUR = 60 * 60 * 1000;
  assert.equal(reassertAllowed(undefined, 1000, HOUR), true);
  assert.equal(reassertAllowed(1000, 1000 + HOUR - 1, HOUR), false);
  assert.equal(reassertAllowed(1000, 1000 + HOUR, HOUR), true);
});

// ── cycle harness ───────────────────────────────────────────────────────────

// Far enough in the past that the publish-settle guard never applies.
const OLD_PUBLISH_AT = 1_000;

const MAPPING: ReconcilerMapping = {
  id: "map1", tenantId: "ten1", e164: "+18457231213", enabled: true, routingMode: "connect", ivrProfileId: "prof1",
};

function makeDeps(overrides: Partial<DidRouteReconcilerDeps> = {}) {
  const calls = {
    reasserts: [] as string[],
    didmapRepublishes: [] as string[],
    menuReplays: [] as string[],
    alerts: [] as string[],
  };
  const deps: DidRouteReconcilerDeps = {
    app: { log: { info: () => {}, warn: () => {}, error: () => {} } },
    db: {
      didRouteMapping: { findMany: async () => [MAPPING] },
    },
    sendAdminAlert: async (key) => { calls.alerts.push(key); },
    inspectMapping: async () => ({ ok: true, mode: "connect" }),
    doorwayStatus: async () => ({ ok: true, healthy: true, contextLive: true }),
    // Default: live AstDB matches whatever is expected (no drift).
    readAstDbKeys: async (_slug, family, keyNames) => {
      const expected = expectedDidmapKeys(MAPPING, "slug1");
      const menu = [{ family: "connect/t_slug1", key: "active_prompt", value: "custom/x" }];
      const all = [...expected, ...menu];
      return keyNames.map((k) => all.find((kv) => kv.family === family && kv.key === k) ?? { family, key: k, value: "" });
    },
    republishDidmap: async (m) => { calls.didmapRepublishes.push(m.id); },
    replayLastMenuPublish: async (tenantId) => { calls.menuReplays.push(tenantId); },
    lastSuccessfulPublishKeys: async () => ({ id: "pub1", publishedAt: OLD_PUBLISH_AT, keys: [{ family: "connect/t_slug1", key: "active_prompt", value: "custom/x" }] }),
    reassertRoute: async (id) => { calls.reasserts.push(id); return { statusCode: 200, body: {} }; },
    getTenantSlug: async () => "slug1",
    ...overrides,
  };
  return { deps, calls };
}

test("healthy world: a cycle repairs nothing and alerts nothing", async () => {
  const { deps, calls } = makeDeps();
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.reasserts, []);
  assert.deepEqual(calls.didmapRepublishes, []);
  assert.deepEqual(calls.menuReplays, []);
  assert.deepEqual(calls.alerts, []);
});

// ── the 2026-08-06 failure: row says connect, callers get the PBX ───────────

test("RENDER drift (row says connect, dialplan says PBX IVR) is caught and re-baked", async () => {
  const rebakes: string[] = [];
  const { deps, calls } = makeDeps({
    inspectMapping: async () => ({
      ok: true, mode: "connect", renderedMode: "pbx", renderedGotos: ["T2_app-ivr,IVR-1,1"],
    }),
    rebakeRoute: async (m) => { rebakes.push(m.id); return { ok: true, changed: 1 }; },
  });
  const state: ReconcilerState = { lastReassertAt: new Map() };
  await runReconcilerCycle(deps, state);
  assert.deepEqual(rebakes, ["map1"]);
  assert.ok(calls.alerts.includes("reconciler-render-map1"));
  // The ROW is fine, so the row-drift path must NOT also fire a switch.
  assert.deepEqual(calls.reasserts, []);
  // Rate-limited on the next cycle: a human mid-surgery gets one repair, not a fight.
  await runReconcilerCycle(deps, state);
  assert.equal(rebakes.length, 1);
});

test("a helper too old to report the render is never treated as healthy-by-omission", async () => {
  const rebakes: string[] = [];
  const { deps, calls } = makeDeps({
    inspectMapping: async () => ({ ok: true, mode: "connect" }), // no renderedMode
    rebakeRoute: async (m) => { rebakes.push(m.id); return { ok: true, changed: 0 }; },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  // Nothing to act on (we cannot see the render) — but equally no false repair.
  assert.deepEqual(rebakes, []);
  assert.deepEqual(calls.alerts, []);
});

test("render drift with no re-bake available says so instead of claiming a fix", async () => {
  const { deps, calls } = makeDeps({
    inspectMapping: async () => ({ ok: true, mode: "connect", renderedMode: "pbx", renderedGotos: ["T2_app-ivr,IVR-1,1"] }),
    rebakeRoute: undefined,
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.ok(calls.alerts.includes("reconciler-render-map1"));
});

test("unhealthy doorway prefers the platform-wide repair over a single re-assert", async () => {
  let repairs = 0;
  const { deps, calls } = makeDeps({
    doorwayStatus: async () => ({ ok: true, healthy: false, contextLive: true }),
    repairDoorway: async () => { repairs++; return { ok: true, routes: [{ did: "+1", rebaked: 1, error: null }] }; },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.equal(repairs, 1);
  assert.deepEqual(calls.reasserts, []); // repair replaces the blind re-assert
  assert.ok(calls.alerts.includes("reconciler-doorway"));
});

test("route drifted off Connect: re-asserted through the real switch route + alerted, rate-limited on the next cycle", async () => {
  const { deps, calls } = makeDeps({ inspectMapping: async () => ({ ok: true, mode: "pbx" }) });
  const state: ReconcilerState = { lastReassertAt: new Map() };
  await runReconcilerCycle(deps, state);
  assert.deepEqual(calls.reasserts, ["map1"]);
  assert.ok(calls.alerts.includes("reconciler-route-map1"));
  // Second cycle inside the rate window: alert again (dedupe is sendAdminAlert's
  // job), but do NOT re-assert again.
  await runReconcilerCycle(deps, state);
  assert.equal(calls.reasserts.length, 1);
});

test("lost didmap keys are republished from the mapping row", async () => {
  const { deps, calls } = makeDeps({
    readAstDbKeys: async (_slug, family, keyNames) =>
      keyNames.map((k) => ({ family, key: k, value: "" })), // AstDB wiped
    lastSuccessfulPublishKeys: async () => null,            // isolate: no menu publish
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.didmapRepublishes, ["map1"]);
  assert.ok(calls.alerts.includes("reconciler-didmap-map1"));
});

test("drifted menu keys replay the LAST SUCCESSFUL publish verbatim (never recomputed)", async () => {
  const published: AstDbKV[] = [
    { family: "connect/t_slug1", key: "active_prompt", value: "custom/closed_menu" },
    { family: "connect/t_slug1", key: "opt_1/dest", value: "T35_cos-all,1101,1" },
  ];
  let replayedWith: AstDbKV[] | null = null;
  const { deps, calls } = makeDeps({
    lastSuccessfulPublishKeys: async () => ({ id: "pub1", publishedAt: OLD_PUBLISH_AT, keys: published }),
    readAstDbKeys: async (_slug, family, keyNames) => {
      if (family.startsWith("connect/didmap/")) {
        return expectedDidmapKeys(MAPPING, "slug1"); // didmap fine
      }
      return keyNames.map((k) => ({ family, key: k, value: "" })); // menu wiped
    },
    replayLastMenuPublish: async (tenantId, _slug, keys) => {
      calls.menuReplays.push(tenantId);
      replayedWith = keys;
    },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.menuReplays, ["ten1"]);
  assert.deepEqual(replayedWith, published);
  assert.ok(calls.alerts.includes("reconciler-menu-ten1"));
});

test("a FRESH publish is never overwritten by a repair (the silent-revert race)", async () => {
  // The reconciler replays the LAST publish. If an owner publishes while a
  // cycle is in flight, replaying writes the older values over the new ones
  // and the change silently reverts — caught by the e2e suite on 2026-08-06
  // when a greeting change vanished between publish and call.
  const published: AstDbKV[] = [{ family: "connect/t_slug1", key: "active_prompt", value: "custom/old" }];
  const { deps, calls } = makeDeps({
    lastSuccessfulPublishKeys: async () => ({ id: "pub-fresh", publishedAt: Date.now(), keys: published }),
    readAstDbKeys: async (_slug, family, keyNames) => {
      if (family.startsWith("connect/didmap/")) return expectedDidmapKeys(MAPPING, "slug1");
      // Live shows the NEWER value — which the old code called "drift".
      return keyNames.map((k) => ({ family, key: k, value: "custom/brand-new" }));
    },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.menuReplays, [], "a just-published tenant must not be 'repaired'");
});

test("a publish landing mid-cycle aborts the replay", async () => {
  const published: AstDbKV[] = [{ family: "connect/t_slug1", key: "active_prompt", value: "custom/old" }];
  let call = 0;
  const { deps, calls } = makeDeps({
    lastSuccessfulPublishKeys: async () => {
      call += 1;
      // First read: an old publish (so the freshness guard passes). Re-check
      // before writing: a different publish id — someone published meanwhile.
      return call === 1
        ? { id: "pub-old", publishedAt: OLD_PUBLISH_AT, keys: published }
        : { id: "pub-newer", publishedAt: Date.now(), keys: published };
    },
    readAstDbKeys: async (_slug, family, keyNames) => {
      if (family.startsWith("connect/didmap/")) return expectedDidmapKeys(MAPPING, "slug1");
      return keyNames.map((k) => ({ family, key: k, value: "something-else" }));
    },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.menuReplays, [], "must stand down when the publish moved under us");
});

test("a fresh publish is never overwritten by a didmap repair (the wrong-menu race)", async () => {
  // The didmap key IS the number's menu assignment. Repairing it from state
  // read seconds ago, right after the owner published a new assignment, writes
  // the OLD menu back — "I pointed the number at a menu and calls went
  // somewhere else". Reproduced live 2026-08-06.
  const { deps, calls } = makeDeps({
    lastSuccessfulPublishKeys: async () => ({ id: "pub-fresh", publishedAt: Date.now(), keys: [] }),
    readAstDbKeys: async (_slug, family, keyNames) =>
      keyNames.map((k) => ({ family, key: k, value: "" })), // looks totally drifted
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.didmapRepublishes, [], "must not rewrite a number's menu right after a publish");
});

test("didmap reads pass the DID so the endpoint's scope check accepts them", async () => {
  // Without didE164 the telephony read rejects a connect/didmap/* family, every
  // key reads back empty, and the reconciler "repairs" the same two keys on
  // every cycle forever.
  let sawDid: string | undefined = "NOT_CALLED";
  const { deps } = makeDeps({
    readAstDbKeys: async (_slug, family, keyNames, didE164) => {
      if (family.startsWith("connect/didmap/")) sawDid = didE164;
      return keyNames.map((k) => ({ family, key: k, value: "" }));
    },
    lastSuccessfulPublishKeys: async () => null,
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.equal(sawDid, MAPPING.e164);
});

test("an unreadable AstDB (every key empty) is NOT treated as drift — no repair, no alert", async () => {
  // The telephony read endpoint 400s above 32 keys; that used to surface as
  // "every key is missing" and had the reconciler republishing healthy tenants
  // on every cycle and emailing about each one.
  const published: AstDbKV[] = Array.from({ length: 40 }, (_, i) => ({
    family: "connect/t_slug1", key: `k${i}`, value: `v${i}`,
  }));
  const { deps, calls } = makeDeps({
    lastSuccessfulPublishKeys: async () => ({ id: "pub1", publishedAt: OLD_PUBLISH_AT, keys: published }),
    readAstDbKeys: async (_slug, family, keyNames) => {
      if (family.startsWith("connect/didmap/")) return expectedDidmapKeys(MAPPING, "slug1");
      return keyNames.map((k) => ({ family, key: k, value: "" }));
    },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.menuReplays, []);
  assert.equal(calls.alerts.includes("reconciler-menu-ten1"), false);
});

test("menu-key reads are chunked to 32 so large families are readable at all", async () => {
  const published: AstDbKV[] = Array.from({ length: 70 }, (_, i) => ({
    family: "connect/t_slug1", key: `k${i}`, value: `v${i}`,
  }));
  const batchSizes: number[] = [];
  const { deps } = makeDeps({
    lastSuccessfulPublishKeys: async () => ({ id: "pub1", publishedAt: OLD_PUBLISH_AT, keys: published }),
    readAstDbKeys: async (_slug, family, keyNames) => {
      if (family.startsWith("connect/didmap/")) return expectedDidmapKeys(MAPPING, "slug1");
      batchSizes.push(keyNames.length);
      return keyNames.map((k) => ({ family, key: k, value: published.find((p) => p.key === k)!.value }));
    },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.ok(batchSizes.length >= 3, `expected chunked reads, got ${JSON.stringify(batchSizes)}`);
  assert.ok(batchSizes.every((n) => n <= 32), `a batch exceeded the endpoint cap: ${JSON.stringify(batchSizes)}`);
});

test("never-published tenants are left alone — the reconciler must not push drafts live", async () => {
  const { deps, calls } = makeDeps({
    lastSuccessfulPublishKeys: async () => null,
    readAstDbKeys: async (_slug, family, keyNames) => {
      if (family.startsWith("connect/didmap/")) return expectedDidmapKeys(MAPPING, "slug1");
      return keyNames.map((k) => ({ family, key: k, value: "" }));
    },
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.menuReplays, []);
});

test("unhealthy doorway: loud alert + one self-heal re-assert", async () => {
  const { deps, calls } = makeDeps({
    doorwayStatus: async () => ({ ok: true, healthy: false, contextLive: false }),
  });
  const state: ReconcilerState = { lastReassertAt: new Map() };
  await runReconcilerCycle(deps, state);
  assert.ok(calls.alerts.includes("reconciler-doorway"));
  assert.deepEqual(calls.reasserts, ["map1"]);
});

test("an unreachable PBX helper alerts instead of repairing blind", async () => {
  const { deps, calls } = makeDeps({
    inspectMapping: async () => ({ ok: false, error: "connect ECONNREFUSED" }),
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.reasserts, []);
  assert.ok(calls.alerts.includes("reconciler-inspect-map1"));
});

test("one broken mapping never stops the others", async () => {
  const m2: ReconcilerMapping = { ...MAPPING, id: "map2", tenantId: "ten2", e164: "+15550001111" };
  const { deps, calls } = makeDeps({
    db: { didRouteMapping: { findMany: async () => [MAPPING, m2] } },
    getTenantSlug: async (tenantId: string) => {
      if (tenantId === "ten1") throw new Error("boom");
      return "slug2";
    },
    inspectMapping: async () => ({ ok: true, mode: "pbx" }),
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  // ten1 exploded before its checks; ten2 still got its drifted route re-asserted.
  assert.deepEqual(calls.reasserts, ["map2"]);
});

test("no connect-mode mappings: the cycle does nothing at all (no doorway noise on idle platforms)", async () => {
  const { deps, calls } = makeDeps({
    db: { didRouteMapping: { findMany: async () => [] } },
    doorwayStatus: async () => ({ ok: false, error: "should not be called" }),
  });
  await runReconcilerCycle(deps, { lastReassertAt: new Map() });
  assert.deepEqual(calls.alerts, []);
});
