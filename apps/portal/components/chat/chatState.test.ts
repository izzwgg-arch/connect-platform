import test from "node:test";
import assert from "node:assert/strict";
import {
  isNearScrollBottom,
  mergeChatMessages,
  resolveActiveThread,
  shouldAutoScroll,
  shouldPreserveScrollOffset,
} from "./chatState";
import type { ChatMessage, ChatThread } from "./types";

const baseThread: ChatThread = {
  id: "thread-1",
  type: "SMS",
  participantName: "Ada Lovelace",
  participantExtension: "",
  externalSmsE164: "+18455550100",
  smsInboxKind: "shared",
  crmSms: true,
  lastMessage: "Hello",
  lastAt: "2026-05-31T12:00:00.000Z",
  unread: 0,
};

function message(id: string, sentAt: string, body = id): ChatMessage {
  return {
    id,
    threadId: "thread-1",
    senderId: "user-1",
    senderName: "Ada",
    body,
    sentAt,
    mine: false,
    type: "TEXT",
  };
}

test("mergeChatMessages de-duplicates IDs and keeps chronological order", () => {
  const first = message("m1", "2026-05-31T12:00:00.000Z");
  const second = message("m2", "2026-05-31T12:01:00.000Z");
  const updatedFirst = message("m1", "2026-05-31T12:00:00.000Z", "updated");

  const merged = mergeChatMessages([second, first], [updatedFirst, second]);

  assert.deepEqual(merged.map((row) => row.id), ["m1", "m2"]);
  assert.equal(merged[0]?.body, "updated");
});

test("mergeChatMessages preserves the previous array when nothing changed", () => {
  const rows = [message("m1", "2026-05-31T12:00:00.000Z")];

  assert.equal(mergeChatMessages(rows, rows), rows);
});

test("resolveActiveThread preserves selected thread reference when refresh is unchanged", () => {
  const refreshed = { ...baseThread };

  assert.equal(resolveActiveThread(baseThread, [refreshed], null), baseThread);
});

test("resolveActiveThread switches to pending thread once it appears", () => {
  const pending = { ...baseThread, id: "thread-2", participantName: "Grace Hopper" };

  assert.equal(resolveActiveThread(baseThread, [baseThread, pending], "thread-2")?.id, "thread-2");
});

test("scroll helpers only auto-scroll background messages when near bottom", () => {
  assert.equal(isNearScrollBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), true);
  assert.equal(isNearScrollBottom({ scrollTop: 600, clientHeight: 100, scrollHeight: 1000 }), false);
  assert.equal(shouldAutoScroll({ reason: "background", threadChanged: false, wasNearBottom: true, previousCount: 2, nextCount: 3 }), true);
  assert.equal(shouldAutoScroll({ reason: "background", threadChanged: false, wasNearBottom: false, previousCount: 2, nextCount: 3 }), false);
  assert.equal(shouldAutoScroll({ reason: "send", threadChanged: false, wasNearBottom: false, previousCount: 2, nextCount: 3 }), true);
});

test("scroll helpers preserve offset when reading older messages", () => {
  assert.equal(shouldPreserveScrollOffset({
    reason: "background",
    threadChanged: false,
    wasNearBottom: false,
    previousScrollHeight: 1000,
    nextScrollHeight: 1200,
  }), true);
  assert.equal(shouldPreserveScrollOffset({
    reason: "background",
    threadChanged: false,
    wasNearBottom: true,
    previousScrollHeight: 1000,
    nextScrollHeight: 1200,
  }), false);
});
