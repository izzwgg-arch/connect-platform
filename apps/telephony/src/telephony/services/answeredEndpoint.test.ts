/**
 * Guards for the telephony half of the answered_elsewhere self-cancel fix
 * (Hanna's dropped answers, 2026-08-21): the store must record WHICH channel
 * set extensionAnsweredAt, and the answered-stop payload must carry the
 * derived endpoint so the api can spare the answering app the cancel push.
 * See docs/ai-context/AGENT_HANDOFF_HANNA_FIRST_CALLS_2026-08-21.md §3.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Env bootstrap — env.ts validates on import (house pattern, see
// CdrNotifier.voicemailMissed.test.ts). Must run before requiring the module.
process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { answeredEndpointFromChannel } = require("./MobilePushNotifier") as typeof import("./MobilePushNotifier");

test("answeredEndpointFromChannel: the real channel shapes", () => {
  assert.strictEqual(answeredEndpointFromChannel("PJSIP/T141_101_1-0000125e"), "T141_101_1");
  assert.strictEqual(answeredEndpointFromChannel("PJSIP/T8_114-00001265"), "T8_114");
  assert.strictEqual(answeredEndpointFromChannel("PJSIP/344022_Comfortcont-00001250"), null);
  assert.strictEqual(answeredEndpointFromChannel("Local/T141_101_1@connect-mobile-wake-dial-000007d3;2"), null);
  assert.strictEqual(answeredEndpointFromChannel(null), null);
  assert.strictEqual(answeredEndpointFromChannel(undefined), null);
});

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

test("SOURCE GUARD: every extensionAnsweredAt stamp also records the channel", () => {
  const src = read("../state/CallStateStore.ts");
  const stamps = src.split("extensionAnsweredAt = new Date().toISOString()").length - 1;
  const channelStamps = src.split("extensionAnsweredChannel").length - 1;
  assert.ok(stamps >= 3, `expected the known stamp sites, saw ${stamps}`);
  // Each stamp site plus the merge must touch the channel field.
  assert.ok(
    channelStamps >= stamps + 1,
    `every stamp site (+merge) must record extensionAnsweredChannel — stamps=${stamps} channelStamps=${channelStamps}`,
  );
});

test("SOURCE GUARD: the answered_elsewhere payload carries answeredEndpoint", () => {
  const src = read("./MobilePushNotifier.ts");
  assert.ok(
    src.includes('answeredEndpoint: answeredEndpointFromChannel(call.extensionAnsweredChannel)'),
    "the answered-stop payload must include the answering endpoint",
  );
});
