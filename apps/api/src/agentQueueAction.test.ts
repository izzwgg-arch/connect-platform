// M10: queue field allow-list — pure validation, no DB, no PBX.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentQueueActionRequest, AgentQueuePatch, pickQueueFields } from "./agentQueueAction";

test("patch allow-list: valid fields pass", () => {
  assert.equal(AgentQueuePatch.safeParse({ strategy: "ringall", timeout: 20 }).success, true);
  assert.equal(AgentQueuePatch.safeParse({ ringinuse: "no", maxlen: 50 }).success, true);
});

test("patch: unknown field is REJECTED (strict — no arbitrary payload)", () => {
  assert.equal(AgentQueuePatch.safeParse({ context: "evil" }).success, false);
  assert.equal(AgentQueuePatch.safeParse({ strategy: "ringall", members: "101,102" }).success, false);
});

test("patch: out-of-range / bad enum rejected", () => {
  assert.equal(AgentQueuePatch.safeParse({ timeout: 601 }).success, false);
  assert.equal(AgentQueuePatch.safeParse({ maxlen: -1 }).success, false);
  assert.equal(AgentQueuePatch.safeParse({ strategy: "telepathy" }).success, false);
  assert.equal(AgentQueuePatch.safeParse({ ringinuse: "maybe" }).success, false);
});

test("patch: empty patch rejected", () => {
  assert.equal(AgentQueuePatch.safeParse({}).success, false);
});

test("request: update requires queueId + patch", () => {
  const base = { tenantId: "21", agentActionId: "a" };
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "list" }).success, true);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "update", queueId: "q5" }).success, false);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "update", queueId: "q5", patch: { timeout: 30 } }).success, true);
});

test("NATIVE actions (2026-07-28): per-action field requirements", () => {
  const base = { tenantId: "21", agentActionId: "a" };
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "native_list" }).success, true);
  // member ops need a queue ref (id or dialable extension) + extension
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "members_add", queueExtension: "1121", extension: "102" }).success, true);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "members_remove", queueId: "3", extension: "102" }).success, true);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "members_add", queueExtension: "1121" }).success, false);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "members_add", extension: "102" }).success, false);
  // set_moh needs the class; set_announcement allows a null recording (clear)
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "set_moh", queueExtension: "1121", mohClass: "connect_x" }).success, true);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "set_moh", queueExtension: "1121" }).success, false);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "set_announcement", queueExtension: "1121", slot: "periodic", recordingId: "9" }).success, true);
  assert.equal(AgentQueueActionRequest.safeParse({ ...base, action: "set_announcement", queueExtension: "1121", slot: "periodic", recordingId: null }).success, true);
});

test("pickQueueFields extracts only allow-listed keys", () => {
  const picked = pickQueueFields({ strategy: "ringall", timeout: 15, secret_field: "x", extension: "800" });
  assert.deepEqual(picked, { strategy: "ringall", timeout: 15 });
});
