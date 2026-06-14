import test from "node:test";
import assert from "node:assert/strict";
import { HostMetricsCollector } from "./hostMetrics";
import { buildServerHealthSnapshot } from "./serverHealth";

test("buildServerHealthSnapshot returns host metrics and service probes", async () => {
  const collector = new HostMetricsCollector(5000);
  await collector.sampleOnce();

  const db = {
    $queryRawUnsafe: async () => [{ "?column?": 1 }],
  };

  const redis = {
    ping: async () => "PONG",
    exists: async () => 1,
  };

  const snapshot = await buildServerHealthSnapshot({
    collector,
    db: db as never,
    redis: redis as never,
    dqFetch: async (_path: string, _timeoutMs?: number) => ({
      ok: true,
      status: 200,
      data: { runningCount: 0, queuedCount: 0, lock: { present: false } },
    }),
  });

  assert.ok(snapshot.host.hostname);
  assert.ok(snapshot.host.memory.totalBytes > 0);
  assert.ok(snapshot.host.cpuConsumers);
  assert.ok(Array.isArray(snapshot.host.cpuConsumers.consumers));
  assert.equal(snapshot.services.some((s) => s.id === "database"), true);
  assert.equal(snapshot.services.some((s) => s.id === "redis"), true);
  assert.ok(["ok", "warning", "critical", "unknown"].includes(snapshot.overallStatus));
  collector.stop();
});
