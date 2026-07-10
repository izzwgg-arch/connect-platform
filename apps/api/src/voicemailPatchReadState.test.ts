import test from "node:test";
import assert from "node:assert/strict";
import { computeVoicemailPatchUpdate } from "./voicemailAccessPolicy";

const FIXED_NOW = new Date("2026-07-09T12:00:00.000Z");

test("owner listening to their own voicemail marks it read", () => {
  const { data, readStateSkipped } = computeVoicemailPatchUpdate({
    body: { listened: true },
    currentReadAt: null,
    isOwnMailbox: true,
    now: FIXED_NOW,
  });
  assert.equal(readStateSkipped, false);
  assert.equal(data.listened, true);
  assert.deepEqual(data.readAt, FIXED_NOW);
});

test("tenant-wide viewer (can_view_tenant_voicemails) listening to another extension's voicemail does NOT mark it read", () => {
  const { data, readStateSkipped } = computeVoicemailPatchUpdate({
    body: { listened: true },
    currentReadAt: null,
    isOwnMailbox: false,
    now: FIXED_NOW,
  });
  assert.equal(readStateSkipped, true);
  assert.equal("listened" in data, false);
  assert.equal("readAt" in data, false);
});

test("bare PATCH (no listened, no folder) defaults to mark-read only for the owner", () => {
  const owner = computeVoicemailPatchUpdate({
    body: {},
    currentReadAt: null,
    isOwnMailbox: true,
    now: FIXED_NOW,
  });
  assert.equal(owner.readStateSkipped, false);
  assert.equal(owner.data.listened, true);

  const nonOwner = computeVoicemailPatchUpdate({
    body: {},
    currentReadAt: null,
    isOwnMailbox: false,
    now: FIXED_NOW,
  });
  assert.equal(nonOwner.readStateSkipped, true);
  assert.equal("listened" in nonOwner.data, false);
});

test("owner marking unread clears readAt", () => {
  const { data, readStateSkipped } = computeVoicemailPatchUpdate({
    body: { listened: false },
    currentReadAt: new Date("2026-07-01T00:00:00.000Z"),
    isOwnMailbox: true,
    now: FIXED_NOW,
  });
  assert.equal(readStateSkipped, false);
  assert.equal(data.listened, false);
  assert.equal(data.readAt, null);
});

test("existing readAt is preserved when owner re-marks read", () => {
  const existing = new Date("2026-07-01T00:00:00.000Z");
  const { data } = computeVoicemailPatchUpdate({
    body: { listened: true },
    currentReadAt: existing,
    isOwnMailbox: true,
    now: FIXED_NOW,
  });
  assert.deepEqual(data.readAt, existing);
});

test("folder moves are allowed for a non-owner, but read state is still skipped", () => {
  const { data, readStateSkipped } = computeVoicemailPatchUpdate({
    body: { folder: "old" },
    currentReadAt: null,
    isOwnMailbox: false,
    now: FIXED_NOW,
  });
  // folder-only body => no implicit read-state change, so nothing skipped
  assert.equal(readStateSkipped, false);
  assert.equal(data.folder, "old");
  assert.equal("listened" in data, false);
});

test("explicit listened + folder from a non-owner moves folder but skips read state", () => {
  const { data, readStateSkipped } = computeVoicemailPatchUpdate({
    body: { listened: true, folder: "old" },
    currentReadAt: null,
    isOwnMailbox: false,
    now: FIXED_NOW,
  });
  assert.equal(readStateSkipped, true);
  assert.equal(data.folder, "old");
  assert.equal("listened" in data, false);
});
