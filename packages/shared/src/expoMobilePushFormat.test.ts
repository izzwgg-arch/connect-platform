import test from "node:test";
import assert from "node:assert/strict";
import { buildExpoPushV2Item, EXPO_PUSH_USER_ALERT_TYPES } from "./expoMobilePushFormat";

test("buildExpoPushV2Item — voicemail is data-only high priority", () => {
  const m = buildExpoPushV2Item({
    to: "ExponentPushToken[x]",
    payload: {
      type: "voicemail",
      voicemailId: "vm1",
      tenantId: "t1",
      extensionId: "e1",
      callerNameOrNumber: "Bob",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.equal(m.priority, "high");
  assert.ok(!("title" in m));
  assert.ok(!("sound" in m));
  const data = m.data as Record<string, string>;
  assert.equal(data.type, "voicemail");
  assert.ok(data.alertTitle?.includes("voicemail") || data.alertTitle === "New voicemail");
  assert.ok(data.alertBody?.includes("Bob"));
  assert.equal(data.androidChannelId, "connect-voicemail");
});

test("EXPO_PUSH_USER_ALERT_TYPES covers chat", () => {
  assert.ok(EXPO_PUSH_USER_ALERT_TYPES.has("dm_message"));
});
