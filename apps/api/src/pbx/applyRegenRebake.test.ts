// Guards for the post-Apply-Changes re-bake (see applyRegenRebake.ts for the
// 2026-08-13 inii mini incident that motivated it: Apply Changes regen wiped
// the doorway bake and seven inbound calls got dead air).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rebakeConnectRoutesAfterRegen, type ApplyRegenRebakeDeps } from "./applyRegenRebake";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeDeps(over: Partial<ApplyRegenRebakeDeps> & { mappings?: Array<{ e164: string }> } = {}): ApplyRegenRebakeDeps {
  const mappings = over.mappings ?? [{ e164: "+16469846023" }];
  return {
    db: { didRouteMapping: { findMany: async () => mappings } },
    log: silentLog,
    pbxTenantId: "105",
    pbxInstanceId: null,
    resolveCfgFn: (() => ({ baseUrl: "http://pbx", secret: "s" })) as any,
    rebakeFn: (async () => ({ ok: true, did: "+16469846023", changed: 1 })) as any,
    ...over,
  };
}

test("re-bakes every enabled connect-mode mapping of the tenant", async () => {
  const baked: string[] = [];
  const deps = makeDeps({
    mappings: [{ e164: "+16469846023" }, { e164: "+18452605692" }],
    rebakeFn: (async (_cfg: any, body: any) => {
      baked.push(body.did);
      return { ok: true, did: body.did, changed: 1 };
    }) as any,
  });
  const r = await rebakeConnectRoutesAfterRegen("t1", deps);
  assert.deepEqual(baked, ["+16469846023", "+18452605692"]);
  assert.equal(r.attempted, 2);
  assert.equal(r.rebaked, 2);
  assert.equal(r.linesChanged, 2);
  assert.deepEqual(r.failed, []);
});

test("queries only enabled connect-mode mappings — pbx-mode numbers are not Connect's to bake", async () => {
  let where: any = null;
  const deps = makeDeps({
    db: { didRouteMapping: { findMany: async (q: any) => { where = q.where; return []; } } },
  });
  await rebakeConnectRoutesAfterRegen("t1", deps);
  assert.deepEqual(where, { tenantId: "t1", enabled: true, routingMode: "connect" });
});

test("one number failing never stops the rest, and NOTHING throws", async () => {
  const baked: string[] = [];
  const deps = makeDeps({
    mappings: [{ e164: "+1111" }, { e164: "+2222" }, { e164: "+3333" }],
    rebakeFn: (async (_cfg: any, body: any) => {
      if (body.did === "+2222") throw new Error("helper_timeout");
      baked.push(body.did);
      return { ok: true, did: body.did, changed: 0 };
    }) as any,
  });
  const r = await rebakeConnectRoutesAfterRegen("t1", deps);
  assert.deepEqual(baked, ["+1111", "+3333"]);
  assert.equal(r.attempted, 3);
  assert.equal(r.rebaked, 2);
  assert.deepEqual(r.failed, [{ e164: "+2222", error: "helper_timeout" }]);
});

test("no helper config → reports every number failed instead of throwing (reconciler covers)", async () => {
  const deps = makeDeps({ resolveCfgFn: (() => null) as any });
  const r = await rebakeConnectRoutesAfterRegen("t1", deps);
  assert.equal(r.rebaked, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].error, "route_helper_not_configured");
});

test("db failure → empty result, no throw", async () => {
  const deps = makeDeps({
    db: { didRouteMapping: { findMany: async () => { throw new Error("db down"); } } },
  });
  const r = await rebakeConnectRoutesAfterRegen("t1", deps);
  assert.deepEqual(r, { attempted: 0, rebaked: 0, linesChanged: 0, failed: [] });
});

// ── source guard ─────────────────────────────────────────────────────────────
// The defect was a CALLER-side omission: createForward fires Apply Changes and
// nothing re-baked afterwards. A unit test of the re-bake function passes
// straight through that bug, so read the route source and fail if the call is
// ever dropped (the internalDoorBypass.test.ts pattern).
test("forwardRoutes calls the re-bake after createForward", () => {
  const src = readFileSync(path.join(__dirname, "forwardRoutes.ts"), "utf8");
  assert.ok(
    src.includes("rebakeConnectRoutesAfterRegen("),
    "POST /voice/forwards no longer re-bakes after Apply Changes — the 2026-08-13 dead-air window is back",
  );
  const createIdx = src.indexOf("await createForward(");
  // Awaited (not fire-and-forget — the response must not race the repair) and
  // AFTER createForward's Apply Changes.
  const rebakeIdx = src.indexOf("await rebakeConnectRoutesAfterRegen(", createIdx);
  assert.ok(createIdx > 0 && rebakeIdx > createIdx, "the re-bake must be awaited AFTER createForward's Apply Changes");
});
