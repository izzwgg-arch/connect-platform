import test from "node:test";
import assert from "node:assert/strict";
import { isConnectChatMessageMine } from "./connectChatMessageMine";

const VIEWER = "user_viewer";
const OTHER_STAFF = "user_other_staff";

test("SMS: outbound message with no senderUserId is mine (provider-synced/historical row)", () => {
  assert.equal(
    isConnectChatMessageMine({ senderUserId: null, direction: "OUTBOUND" }, "SMS", VIEWER),
    true,
  );
});

test("SMS: outbound message sent by a different staff member is still mine (tenant side)", () => {
  // This is the exact scenario that broke production: senderUserId gets set to
  // NULL (onDelete: SetNull) once the sending staff account is deleted, but even
  // before that, any staff member's outbound SMS should read as "ours" for every
  // viewer — SMS is tenant-vs-customer, not per-user.
  assert.equal(
    isConnectChatMessageMine({ senderUserId: OTHER_STAFF, direction: "OUTBOUND" }, "SMS", VIEWER),
    true,
  );
});

test("SMS: inbound message from the customer is never mine", () => {
  assert.equal(
    isConnectChatMessageMine({ senderUserId: null, direction: "INBOUND" }, "SMS", VIEWER),
    false,
  );
});

test("SMS: direction wins even if senderUserId is unexpectedly populated on an inbound row", () => {
  assert.equal(
    isConnectChatMessageMine({ senderUserId: VIEWER, direction: "INBOUND" }, "SMS", VIEWER),
    false,
  );
});

test("Internal threads (DM/GROUP/TENANT_GROUP): mine iff senderUserId matches the viewer", () => {
  for (const threadType of ["DM", "GROUP", "TENANT_GROUP"]) {
    assert.equal(
      isConnectChatMessageMine({ senderUserId: VIEWER, direction: "INTERNAL" }, threadType, VIEWER),
      true,
      `expected mine=true for ${threadType}`,
    );
    assert.equal(
      isConnectChatMessageMine({ senderUserId: OTHER_STAFF, direction: "INTERNAL" }, threadType, VIEWER),
      false,
      `expected mine=false for ${threadType}`,
    );
  }
});

test("Internal threads: a system message with no senderUserId is never mine", () => {
  assert.equal(
    isConnectChatMessageMine({ senderUserId: null, direction: "INTERNAL" }, "GROUP", VIEWER),
    false,
  );
});

test("Missing/unknown threadType falls back to the internal senderUserId rule, not SMS", () => {
  assert.equal(
    isConnectChatMessageMine({ senderUserId: VIEWER, direction: "OUTBOUND" }, undefined, VIEWER),
    true,
  );
  assert.equal(
    isConnectChatMessageMine({ senderUserId: null, direction: "OUTBOUND" }, undefined, VIEWER),
    false,
  );
});
