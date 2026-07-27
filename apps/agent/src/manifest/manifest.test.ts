import { test } from "node:test";
import assert from "node:assert/strict";
import { loadManifest, executableCapabilities, type Capability } from "./manifest";

test("manifest parses and has no duplicate ids", () => {
  const caps = loadManifest();
  assert.ok(caps.length >= 20, "expected the full capability catalog");
});

test("GATE: planned/built/suspended capabilities are not executable", () => {
  const caps: Capability[] = [
    { id: "a", kind: "read", roles: ["owner"], title: "a", status: "planned" },
    { id: "b", kind: "action", roles: ["owner"], title: "b", status: "built" },
    { id: "c", kind: "action", roles: ["owner"], title: "c", status: "suspended" },
    { id: "d", kind: "read", roles: ["owner"], title: "d", status: "certified" },
    { id: "e", kind: "action", roles: ["owner"], title: "e", status: "live" },
  ];
  const exec = executableCapabilities(caps).map((c) => c.id);
  assert.deepEqual(exec, ["d", "e"]);
});

test("GATE: only certified/live capabilities are executable; planned/built are not", () => {
  const all = loadManifest();
  const exec = executableCapabilities(all);
  // Everything exposed must be certified or live — never planned/built/suspended.
  assert.ok(exec.every((c) => c.status === "certified" || c.status === "live"));
  // Planned capabilities (e.g. watchman, transcription) must NOT be exposed.
  assert.ok(!exec.some((c) => c.id === "watchman.security_monitor"));
  assert.ok(!exec.some((c) => c.id === "owner.kill_switch")); // still planned
});

test("GATE: PBX-write capabilities stay sim-only except ones explicitly certified live", () => {
  const pbx = loadManifest().filter((c) => c.pbxWrite);
  assert.ok(pbx.length >= 14);
  // liveEnabled is off by default and only flipped per capability after live
  // certification. M11 (DND/CF) was first; M1 (tenant MOH) and M2 (extension
  // MOH) went live for all tenants under the 2026-07-26 owner mandates.
  const liveEnabled = pbx.filter((c) => c.liveEnabled === true).map((c) => c.id);
  assert.deepEqual(liveEnabled, ["pbx.M1", "pbx.M2", "pbx.M11"]);
});
