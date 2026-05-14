import test from "node:test";
import assert from "node:assert/strict";
import { isCrmQueuePatchOwnershipForbidden } from "./guard";

const agent = "user_agent";
const other = "user_other";

test("admin roles are never forbidden", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("SUPER_ADMIN", agent, other, { action: "skip" }),
    false,
  );
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("TENANT_ADMIN", agent, other, { action: "skip" }),
    false,
  );
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("ADMIN", agent, other, { action: "skip" }),
    false,
  );
});

test("agent may skip own member", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("EXTENSION_USER", agent, agent, { action: "skip" }),
    false,
  );
});

test("agent may not skip another user member", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("EXTENSION_USER", agent, other, { action: "skip" }),
    true,
  );
});

test("agent may not skip unassigned member", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("EXTENSION_USER", agent, null, { action: "skip" }),
    true,
  );
});

test("assign-to-me allowed when unassigned", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("EXTENSION_USER", agent, null, { action: "assign-to-me" }),
    false,
  );
});

test("assign-to-me allowed when already assigned to self", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("EXTENSION_USER", agent, agent, { action: "assign-to-me" }),
    false,
  );
});

test("assign-to-me forbidden when assigned to someone else", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("EXTENSION_USER", agent, other, { action: "assign-to-me" }),
    true,
  );
});

test("status-only PATCH requires assignment", () => {
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("USER", agent, other, { status: "CONTACTED" }),
    true,
  );
  assert.equal(
    isCrmQueuePatchOwnershipForbidden("USER", agent, agent, { status: "CONTACTED" }),
    false,
  );
});
