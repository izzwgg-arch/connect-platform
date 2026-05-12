/**
 * Redis snapshot envelope for telephony ARI poller → API read model.
 *
 * Run: pnpm --filter @connect/telephony test
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const publisher = require("./ariBridgedRedisPublisher") as typeof import("./ariBridgedRedisPublisher");
const { serializeAriBridgedPollToRedisJson, createAriBridgedRedisPublisher } = publisher;

function minimalPollInput(): import("./ariBridgedRedisPublisher").AriBridgedPollSnapshotInput {
  return {
    pollIntervalMs: 5000,
    pbxHost: "pbx.example.com",
    ttlSec: 15,
    rawBridgeCount: 2,
    rawChannelCount: 4,
    registeredEndpoints: 10,
    unregisteredEndpoints: 1,
    totalEndpoints: 11,
    result: {
      activeCalls: 1,
      bridges: [
        {
          bridgeId: "br-1",
          channelCount: 2,
          caller: "101",
          callee: "102",
          channelNames: ["PJSIP/T1-0001", "PJSIP/T1-0002"],
          channelIds: ["ch1", "ch2"],
          sourceKind: "bridge",
          dialplanContext: "ctx",
          dialplanExten: "s",
          calledNumber: "18005551212",
        },
      ],
      debug: {
        totalChannels: 4,
        totalBridges: 2,
        qualifyingBridges: 1,
        orphanLegCalls: 0,
        excluded: [],
      },
      verification: {
        rawBridgeCount: 2,
        rawChannelCount: 4,
        qualifyingBridgeCount: 1,
        bridgeBackedCallCount: 1,
        orphanLegCallCount: 0,
        finalActiveCalls: 1,
        qualifyingBridges: [],
        excludedBridges: [],
        orphanLegs: [],
      },
    },
  };
}

test("serializeAriBridgedPollToRedisJson: v1 envelope, no credential fields", () => {
  const json = serializeAriBridgedPollToRedisJson(minimalPollInput());
  assert.ok(!json.includes("ARI_PASSWORD"));
  assert.ok(!json.includes("test-secret"));
  const o = JSON.parse(json) as Record<string, unknown>;
  assert.equal(o.v, 1);
  assert.equal(o.source, "telephony");
  assert.equal(o.pbxHost, "pbx.example.com");
  assert.equal(o.pollIntervalMs, 5000);
  assert.equal(o.activeCalls, 1);
  assert.equal(o.rawBridgeCount, 2);
  assert.ok(Array.isArray(o.bridges));
});

test("createAriBridgedRedisPublisher without redisUrl is a no-op", async () => {
  const pub = createAriBridgedRedisPublisher({ redisUrl: "", pbxHost: "h" });
  await assert.doesNotReject(() => pub.publishFromPoll(minimalPollInput()));
  await assert.doesNotReject(() => pub.close());
});
