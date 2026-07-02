// Unit tests for MOH control-mode + PBX-handoff tombstones + verify classifier.
// Pure logic — no DB, no AstDB, no Fastify.

import test from "node:test";
import assert from "node:assert/strict";
import {
  canManageMohControl,
  classifyMohVerify,
  computePbxControlTombstones,
  effectiveExtensionControlMode,
  normalizeExtensionControlMode,
  normalizeTenantControlMode,
} from "./mohControl";
import type { MohAstDbKey } from "@connect/shared";

test("normalizeTenantControlMode: only 'pbx' flips; everything else → connect", () => {
  assert.equal(normalizeTenantControlMode("pbx"), "pbx");
  assert.equal(normalizeTenantControlMode("PBX"), "pbx");
  assert.equal(normalizeTenantControlMode("connect"), "connect");
  assert.equal(normalizeTenantControlMode(""), "connect");
  assert.equal(normalizeTenantControlMode(null), "connect");
  assert.equal(normalizeTenantControlMode("garbage"), "connect");
});

test("normalizeExtensionControlMode: inherit default", () => {
  assert.equal(normalizeExtensionControlMode("connect"), "connect");
  assert.equal(normalizeExtensionControlMode("pbx"), "pbx");
  assert.equal(normalizeExtensionControlMode("inherit"), "inherit");
  assert.equal(normalizeExtensionControlMode(""), "inherit");
  assert.equal(normalizeExtensionControlMode("weird"), "inherit");
});

test("effectiveExtensionControlMode: ext override beats tenant; inherit follows tenant", () => {
  assert.equal(effectiveExtensionControlMode("connect", "inherit"), "connect");
  assert.equal(effectiveExtensionControlMode("pbx", "inherit"), "pbx");
  assert.equal(effectiveExtensionControlMode("pbx", "connect"), "connect");
  assert.equal(effectiveExtensionControlMode("connect", "pbx"), "pbx");
});

test("canManageMohControl: SUPER_ADMIN any; ADMIN own tenant only", () => {
  assert.equal(canManageMohControl({ role: "SUPER_ADMIN", tenantId: "x" }, "t1"), true);
  assert.equal(canManageMohControl({ role: "ADMIN", tenantId: "t1" }, "t1"), true);
  assert.equal(canManageMohControl({ role: "ADMIN", tenantId: "t2" }, "t1"), false);
  assert.equal(canManageMohControl({ role: "AGENT", tenantId: "t1" }, "t1"), false);
  assert.equal(canManageMohControl(null, "t1"), false);
});

test("computePbxControlTombstones: clears every prior key (incl tenant default), skips empties + keeps admin overlay", () => {
  const prev: MohAstDbKey[] = [
    { family: "connect/t_acme", key: "moh_class", value: "moh5" },
    { family: "connect/t_acme", key: "active_moh_class", value: "moh5" },
    { family: "connect/t_acme", key: "hold_mode", value: "ringback" },
    { family: "connect/t_acme/moh/src", key: "outbound", value: "moh2" },
    { family: "connect/t_acme", key: "admin_moh_class", value: "yom_tov" }, // active admin overlay
    { family: "connect/t_acme", key: "already_empty", value: "" }, // skipped
  ];
  const keep: MohAstDbKey[] = [{ family: "connect/t_acme", key: "admin_moh_class", value: "yom_tov" }];
  const clears = computePbxControlTombstones(prev, keep);
  const cleared = new Map(clears.map((k) => [`${k.family}\u0000${k.key}`, k.value]));
  assert.equal(cleared.get("connect/t_acme\u0000moh_class"), "");
  assert.equal(cleared.get("connect/t_acme\u0000hold_mode"), "");
  assert.equal(cleared.get("connect/t_acme/moh/src\u0000outbound"), "");
  // Admin overlay kept, empties skipped.
  assert.ok(!cleared.has("connect/t_acme\u0000admin_moh_class"));
  assert.ok(!cleared.has("connect/t_acme\u0000already_empty"));
  for (const k of clears) assert.equal(k.value, "");
});

test("classifyMohVerify: verified / drift / unverified / trivial", () => {
  const loaded = new Set(["moh2", "moh5"]);
  assert.deepEqual(classifyMohVerify({ desiredClass: "moh5", probeOk: true, loadedClasses: loaded }), {
    status: "verified",
    observed: "moh5",
  });
  assert.deepEqual(classifyMohVerify({ desiredClass: "moh9", probeOk: true, loadedClasses: loaded }), {
    status: "drift",
    observed: null,
  });
  assert.deepEqual(classifyMohVerify({ desiredClass: "moh5", probeOk: false, loadedClasses: null }), {
    status: "unverified",
    observed: null,
  });
  // PBX handoff — nothing to verify.
  assert.deepEqual(classifyMohVerify({ desiredClass: "", probeOk: false, loadedClasses: null }), {
    status: "verified",
    observed: null,
  });
});
