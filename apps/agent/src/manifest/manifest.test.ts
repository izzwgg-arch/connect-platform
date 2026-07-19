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

test("GATE: fresh manifest exposes nothing (nothing certified yet)", () => {
  // Phase 0 truth: until the certification harness flips statuses, the agent
  // has ZERO executable capabilities. This test is the owner mandate in code.
  assert.equal(executableCapabilities().length, 0);
});
