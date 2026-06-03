import test from "node:test";
import assert from "node:assert/strict";
import {
  canAttemptMobileInviteRequeue,
  isPendingMobileInviteEligible,
  markMobileInviteRequeueAttempt,
  resetMobileInviteRequeueGuardForTests,
  requeueTriggerLabel,
  resolveFlightUploadSessionIds,
} from "./mobileInviteRequeue.js";

test("requeue guard allows first attempts and blocks after max", () => {
  resetMobileInviteRequeueGuardForTests();
  const linkedId = "1780501104.55724";
  assert.equal(canAttemptMobileInviteRequeue(linkedId), true);
  markMobileInviteRequeueAttempt(linkedId);
  assert.equal(canAttemptMobileInviteRequeue(linkedId), true);
  markMobileInviteRequeueAttempt(linkedId);
  markMobileInviteRequeueAttempt(linkedId);
  markMobileInviteRequeueAttempt(linkedId);
  assert.equal(canAttemptMobileInviteRequeue(linkedId), false);
});

test("pending invite eligibility requires PENDING status and pbxCallId", () => {
  assert.equal(
    isPendingMobileInviteEligible({
      id: "inv1",
      pbxCallId: "1780501104.55724",
      toExtension: "101",
      status: "PENDING",
    }),
    true,
  );
  assert.equal(
    isPendingMobileInviteEligible({
      id: "inv2",
      pbxCallId: "1780501104.55724",
      toExtension: "101",
      status: "ACCEPTED",
    }),
    false,
  );
  assert.equal(
    isPendingMobileInviteEligible({
      id: "inv3",
      pbxCallId: null,
      toExtension: "101",
      status: "PENDING",
    }),
    false,
  );
});

test("requeue trigger labels are stable", () => {
  assert.equal(requeueTriggerLabel("accept"), "invite_accept");
  assert.equal(requeueTriggerLabel("register_complete"), "device_register_complete");
});

test("flight upload resolves inviteId from session.meta", () => {
  const resolved = resolveFlightUploadSessionIds({
    id: "cfs_test",
    meta: {
      inviteId: "inv_123",
      pbxCallId: "1780501104.55724",
      extension: "101",
    },
    events: [],
  });
  assert.equal(resolved.inviteId, "inv_123");
  assert.equal(resolved.pbxCallId, "1780501104.55724");
  assert.equal(resolved.linkedId, "1780501104.55724");
});
