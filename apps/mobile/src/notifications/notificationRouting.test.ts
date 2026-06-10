import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUserAlertPushType,
  shouldPresentForegroundUserAlert,
  shouldSuppressForegroundPush,
  userAlertChannelId,
  notificationDataToRoute,
  setActiveNotificationChatThread,
} from "./notificationRouting";

test("isUserAlertPushType recognises the four user-facing alert types", () => {
  assert.equal(isUserAlertPushType("voicemail"), true);
  assert.equal(isUserAlertPushType("missed_call"), true);
  assert.equal(isUserAlertPushType("dm_message"), true);
  assert.equal(isUserAlertPushType("sms_message"), true);
  assert.equal(isUserAlertPushType("INCOMING_CALL"), false);
  assert.equal(isUserAlertPushType(undefined), false);
  assert.equal(isUserAlertPushType(""), false);
});

test("foreground present: data-only voicemail with alertTitle is presented", () => {
  const data = { type: "voicemail", alertTitle: "New voicemail", alertBody: "From 8455551212" };
  assert.equal(shouldPresentForegroundUserAlert(data, false), true);
});

test("foreground present: chat + voicemail + missed call all surface in foreground", () => {
  assert.equal(
    shouldPresentForegroundUserAlert({ type: "dm_message", alertTitle: "Jane", conversationId: "c1" }, false),
    true,
  );
  assert.equal(
    shouldPresentForegroundUserAlert({ type: "sms_message", alertTitle: "8455551212", conversationId: "c2" }, false),
    true,
  );
  assert.equal(
    shouldPresentForegroundUserAlert({ type: "missed_call", alertTitle: "Missed call" }, false),
    true,
  );
});

test("foreground present: skipped when the push already had an OS notification block", () => {
  const data = { type: "voicemail", alertTitle: "New voicemail" };
  assert.equal(shouldPresentForegroundUserAlert(data, true), false);
});

test("foreground present: skipped for the re-entrant local notification", () => {
  const data = { type: "voicemail", alertTitle: "New voicemail", _localPresented: true };
  assert.equal(shouldPresentForegroundUserAlert(data, false), false);
  const dataStr = { type: "voicemail", alertTitle: "New voicemail", _localPresented: "true" };
  assert.equal(shouldPresentForegroundUserAlert(dataStr, false), false);
});

test("foreground present: skipped when there is no alertTitle to render", () => {
  assert.equal(shouldPresentForegroundUserAlert({ type: "voicemail" }, false), false);
});

test("foreground present: skipped for non-user-alert (call) types", () => {
  assert.equal(
    shouldPresentForegroundUserAlert({ type: "INCOMING_CALL", alertTitle: "x" }, false),
    false,
  );
});

test("foreground present: suppressed for the chat thread currently being viewed", () => {
  setActiveNotificationChatThread("conv-123");
  const sameThread = { type: "dm_message", alertTitle: "Jane", conversationId: "conv-123" };
  const otherThread = { type: "dm_message", alertTitle: "Jane", conversationId: "conv-999" };
  assert.equal(shouldPresentForegroundUserAlert(sameThread, false), false);
  assert.equal(shouldPresentForegroundUserAlert(otherThread, false), true);
  setActiveNotificationChatThread(null);
});

test("userAlertChannelId honours explicit channel, else falls back by type", () => {
  assert.equal(userAlertChannelId({ type: "voicemail", androidChannelId: "custom" }), "custom");
  assert.equal(userAlertChannelId({ type: "voicemail" }), "connect-voicemail");
  assert.equal(userAlertChannelId({ type: "missed_call" }), "connect-missed-calls");
  assert.equal(userAlertChannelId({ type: "dm_message" }), "connect-messages");
  assert.equal(userAlertChannelId({ type: "sms_message" }), "connect-messages");
});

test("notificationDataToRoute maps each alert type to a deep-link route", () => {
  assert.deepEqual(notificationDataToRoute({ type: "voicemail", voicemailId: "v1" }), {
    type: "voicemail",
    voicemailId: "v1",
    tenantId: undefined,
    extensionId: undefined,
  });
  assert.deepEqual(notificationDataToRoute({ type: "missed_call", callId: "c1", callerNumber: "845" }), {
    type: "missed_call",
    callId: "c1",
    tenantId: undefined,
    extensionId: undefined,
    callerNumber: "845",
  });
  assert.deepEqual(notificationDataToRoute({ type: "dm_message", conversationId: "conv1", messageId: "m1" }), {
    type: "dm_message",
    conversationId: "conv1",
    messageId: "m1",
    tenantId: undefined,
  });
  // chat route with no conversationId is unroutable
  assert.equal(notificationDataToRoute({ type: "dm_message" }), null);
});

test("shouldSuppressForegroundPush only suppresses the active chat thread", () => {
  setActiveNotificationChatThread("active");
  assert.equal(shouldSuppressForegroundPush({ type: "dm_message", conversationId: "active" }), true);
  assert.equal(shouldSuppressForegroundPush({ type: "dm_message", conversationId: "other" }), false);
  assert.equal(shouldSuppressForegroundPush({ type: "voicemail" }), false);
  setActiveNotificationChatThread(null);
});
