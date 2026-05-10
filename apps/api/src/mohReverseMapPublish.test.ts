// Focused tests for the MOH reverse-tenant-map publish helper.
//
// These tests deliberately do NOT spin up Fastify, the telephony service,
// or AstDB — the contract under test is "given this input, build these
// keys; given a fake publish fn, attach this evidence." The HTTP delivery
// layer (`publishMohToAstDb`) is exercised in production code only.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTenantMohReverseMapKeys,
  publishTenantMohReverseMap,
} from "./mohReverseMapPublish";

test("buildTenantMohReverseMapKeys: writes slug+moh_class for numeric pbxTenantId", () => {
  const keys = buildTenantMohReverseMapKeys({
    pbxTenantId: "3",
    canonicalSlug: "secro_selution",
    mohClass: "moh8",
  });
  assert.deepEqual(keys, [
    { family: "connect/pbx_tenant_map/3", key: "slug", value: "secro_selution" },
    { family: "connect/pbx_tenant_map/3", key: "moh_class", value: "moh8" },
  ]);
});

test("buildTenantMohReverseMapKeys: tolerates whitespace in pbxTenantId", () => {
  const keys = buildTenantMohReverseMapKeys({
    pbxTenantId: "  21  ",
    canonicalSlug: "landau_home",
    mohClass: "moh3",
  });
  assert.equal(keys.length, 2);
  assert.equal(keys[0].family, "connect/pbx_tenant_map/21");
});

test("buildTenantMohReverseMapKeys: empty pbxTenantId emits no keys", () => {
  assert.equal(buildTenantMohReverseMapKeys({ pbxTenantId: "", canonicalSlug: "s", mohClass: "moh1" }).length, 0);
  assert.equal(buildTenantMohReverseMapKeys({ pbxTenantId: null, canonicalSlug: "s", mohClass: "moh1" }).length, 0);
  assert.equal(buildTenantMohReverseMapKeys({ pbxTenantId: undefined, canonicalSlug: "s", mohClass: "moh1" }).length, 0);
});

test("buildTenantMohReverseMapKeys: rejects non-numeric, alphanumeric, and oversized ids", () => {
  for (const bad of ["abc", "T3", "3a", "3 4", "12345678901", "../../etc"]) {
    assert.equal(
      buildTenantMohReverseMapKeys({ pbxTenantId: bad, canonicalSlug: "s", mohClass: "moh1" }).length,
      0,
      `expected zero keys for pbxTenantId=${JSON.stringify(bad)}`,
    );
  }
});

test("publishTenantMohReverseMap: success path returns reverseMapPublished=true and forwards keys", async () => {
  const calls: any[] = [];
  const evidence = await publishTenantMohReverseMap(
    { pbxTenantId: "3", canonicalSlug: "secro_selution", mohClass: "moh8" },
    async (keys) => {
      calls.push(keys);
    },
  );
  assert.equal(evidence.reverseMapPublished, true);
  assert.equal(evidence.pbxTenantId, "3");
  assert.equal(evidence.canonicalSlug, "secro_selution");
  assert.equal(evidence.mohClass, "moh8");
  assert.equal(evidence.reason, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { family: "connect/pbx_tenant_map/3", key: "slug", value: "secro_selution" },
    { family: "connect/pbx_tenant_map/3", key: "moh_class", value: "moh8" },
  ]);
});

test("publishTenantMohReverseMap: missing pbxTenantId reports tenant_pbx_link_missing and skips publish", async () => {
  let calls = 0;
  const evidence = await publishTenantMohReverseMap(
    { pbxTenantId: null, canonicalSlug: "secro_selution", mohClass: "moh8" },
    async () => {
      calls += 1;
    },
  );
  assert.equal(evidence.reverseMapPublished, false);
  assert.equal(evidence.pbxTenantId, null);
  assert.equal(evidence.reason, "tenant_pbx_link_missing");
  assert.equal(calls, 0, "publish must not be invoked when there are no keys to write");
});

test("publishTenantMohReverseMap: non-numeric pbxTenantId reports non_numeric_pbx_tenant_id and skips publish", async () => {
  let calls = 0;
  const evidence = await publishTenantMohReverseMap(
    { pbxTenantId: "T3", canonicalSlug: "secro_selution", mohClass: "moh8" },
    async () => {
      calls += 1;
    },
  );
  assert.equal(evidence.reverseMapPublished, false);
  assert.equal(evidence.pbxTenantId, "T3");
  assert.match(evidence.reason ?? "", /^non_numeric_pbx_tenant_id:T3/);
  assert.equal(calls, 0);
});

test("publishTenantMohReverseMap: publish failure is captured in evidence, not thrown", async () => {
  const evidence = await publishTenantMohReverseMap(
    { pbxTenantId: "3", canonicalSlug: "secro_selution", mohClass: "moh8" },
    async () => {
      throw new Error("telephony moh-publish failed: 502 boom");
    },
  );
  assert.equal(evidence.reverseMapPublished, false);
  assert.equal(evidence.pbxTenantId, "3");
  assert.match(evidence.reason ?? "", /^reverse_map_publish_failed:/);
  assert.match(evidence.reason ?? "", /telephony moh-publish failed: 502 boom/);
});

test("publishTenantMohReverseMap: long publish error message is truncated", async () => {
  const big = "x".repeat(500);
  const evidence = await publishTenantMohReverseMap(
    { pbxTenantId: "3", canonicalSlug: "s", mohClass: "moh8" },
    async () => {
      throw new Error(big);
    },
  );
  assert.equal(evidence.reverseMapPublished, false);
  assert.ok(
    (evidence.reason ?? "").length <= "reverse_map_publish_failed:".length + 200,
    "reason must be truncated to bounded length",
  );
});
