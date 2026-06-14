import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { HostMetricsCollector } from "./hostMetrics";
import { buildServerHealthSnapshot } from "./serverHealth";

test("buildServerHealthSnapshot completes when redis is unreachable", async () => {
  const collector = new HostMetricsCollector(5000);
  await collector.sampleOnce();

  const redis = new IORedis("redis://127.0.0.1:6379", { maxRetriesPerRequest: null });

  const snapshot = await buildServerHealthSnapshot({
    collector,
    db: { $queryRawUnsafe: async () => [{ "?column?": 1 }] } as never,
    redis: redis as never,
    dqFetch: async () => ({ ok: false, status: 502, data: {} }),
  });

  redis.disconnect();

  assert.ok(snapshot.host.hostname);
  assert.ok(snapshot.host.memory.totalBytes > 0);
  const redisProbe = snapshot.services.find((s) => s.id === "redis");
  assert.ok(redisProbe);
  assert.equal(redisProbe?.status, "critical");
  collector.stop();
});
