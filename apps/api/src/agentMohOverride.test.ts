// M1: unit tests for the agent MOH-override door's pure pieces.
// Pure logic — no DB, no Fastify.

import test from "node:test";
import assert from "node:assert/strict";
import { AgentMohOverrideRequest, agentMohSecretOk, shapeMohSnapshot, shapeExtensionOverride } from "./agentMohOverride";

test("schema: activate requires profileId; read/deactivate do not", () => {
  const base = { tenantId: "21", agentActionId: "act1" };
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "activate" }).success, false);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "activate", profileId: "p1" }).success, true);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "read" }).success, true);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "deactivate" }).success, true);
});

test("schema: agentActionId is mandatory (attribution contract)", () => {
  assert.equal(AgentMohOverrideRequest.safeParse({ tenantId: "21", action: "read" }).success, false);
});

test("schema: bad expiry / unknown action / empty tenant rejected", () => {
  const base = { tenantId: "21", agentActionId: "a" };
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "activate", profileId: "p", expiresAt: "not-a-date" }).success, false);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "delete" }).success, false);
  assert.equal(AgentMohOverrideRequest.safeParse({ tenantId: "", action: "read", agentActionId: "a" }).success, false);
});

test("schema: schedule_add/remove require profileId + exactly one shape (one_time XOR weekly)", () => {
  const base = { tenantId: "21", agentActionId: "a", profileId: "p1" };
  const oneTime = { startAt: "2026-07-30T19:00:00.000Z", endAt: "2026-07-30T21:00:00.000Z" };
  const weekly = { weekday: 5, startTime: "15:00", endTime: "17:00" };
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_add", ...oneTime }).success, true);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_add", ...weekly }).success, true);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_remove", ...oneTime }).success, true);
  // missing profileId
  assert.equal(AgentMohOverrideRequest.safeParse({ tenantId: "21", agentActionId: "a", action: "schedule_add", ...oneTime }).success, false);
  // no shape at all
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_add" }).success, false);
  // both shapes at once
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_add", ...oneTime, ...weekly }).success, false);
  // end before start
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_add", startAt: oneTime.endAt, endAt: oneTime.startAt }).success, false);
  // bad weekly time format
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "schedule_add", weekday: 5, startTime: "3pm", endTime: "17:00" }).success, false);
});

test("secret check: FAIL-CLOSED when unset; wrong/empty refused; exact match passes", () => {
  assert.equal(agentMohSecretOk("anything", undefined), false);
  assert.equal(agentMohSecretOk("anything", ""), false);
  assert.equal(agentMohSecretOk(undefined, "s3cret"), false);
  assert.equal(agentMohSecretOk("", "s3cret"), false);
  assert.equal(agentMohSecretOk("wrong", "s3cret"), false);
  assert.equal(agentMohSecretOk("s3cret-longer", "s3cret"), false);
  assert.equal(agentMohSecretOk("s3cret", "s3cret"), true);
});

test("snapshot shaping: override + active profiles + latest publish incl. X4 queue evidence", () => {
  const shaped = shapeMohSnapshot({
    tenantId: "t1",
    override: { isActive: true, profileId: "p2", expiresAt: new Date("2026-07-24T09:00:00Z") },
    profiles: [
      { id: "p1", name: "Default", type: "default", vitalPbxMohClassName: "moh8", isActive: true },
      { id: "p2", name: "Holiday", type: "holiday", vitalPbxMohClassName: "moh3", isActive: true },
      { id: "p3", name: "Old", type: "custom", vitalPbxMohClassName: "moh2", isActive: false },
    ],
    latestPublish: {
      id: "pub1",
      status: "success",
      newMohClass: "moh3",
      nativeSync: { queuesTotal: 2, helperResponse: { queuePatch: { patched: 2, error: null } } },
    },
  });
  assert.equal(shaped.override?.profileId, "p2");
  assert.equal(shaped.override?.expiresAt, "2026-07-24T09:00:00.000Z");
  assert.deepEqual(shaped.profiles.map((p) => p.id), ["p1", "p2"]); // inactive excluded
  assert.equal(shaped.latestPublish?.newMohClass, "moh3");
  assert.deepEqual(shaped.latestPublish?.queuePatch, { patched: 2, error: null });
  assert.equal(shaped.latestPublish?.queuesTotal, 2);
});

test("snapshot shaping: null override / no publish handled", () => {
  const shaped = shapeMohSnapshot({ tenantId: "t1", override: null, profiles: [], latestPublish: null });
  assert.equal(shaped.override, null);
  assert.equal(shaped.latestPublish, null);
  assert.deepEqual(shaped.profiles, []);
});

test("M2 schema: ext_set requires extension+profileId; ext_clear requires extension", () => {
  const base = { tenantId: "21", agentActionId: "a" };
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "ext_set", extension: "103" }).success, false);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "ext_set", extension: "103", profileId: "p1" }).success, true);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "ext_clear" }).success, false);
  assert.equal(AgentMohOverrideRequest.safeParse({ ...base, action: "ext_clear", extension: "103" }).success, true);
});

test("shapeExtensionOverride: row and null", () => {
  assert.deepEqual(shapeExtensionOverride({ extension: "103", enabled: true, mohProfileId: "p2", vitalPbxMohClassName: "moh3" }), { extension: "103", enabled: true, profileId: "p2", vitalPbxMohClassName: "moh3" });
  assert.equal(shapeExtensionOverride(null), null);
});
