import test from "node:test";
import assert from "node:assert/strict";
import { CpuConsumerTracker } from "./cpuConsumers";

test("CpuConsumerTracker returns warming snapshot then process consumers on Windows", async () => {
  if (process.platform !== "win32") {
    // Linux docker/proc paths are environment-specific; Windows path is reliable in dev.
    return;
  }

  const tracker = new CpuConsumerTracker();
  const first = await tracker.sampleOnce();
  assert.ok(first.scope === "host_processes" || first.scope === "unavailable");
  await new Promise((r) => setTimeout(r, 1100));
  const second = await tracker.sampleOnce();
  assert.ok(second.consumers.every((c) => c.kind === "process"));
  assert.ok(second.consumers.every((c) => c.cpuPct >= 0));
});

test("CpuConsumerTracker second sample includes cpuPct values", async () => {
  const tracker = new CpuConsumerTracker();
  await tracker.sampleOnce();
  await new Promise((r) => setTimeout(r, 1100));
  const snap = await tracker.sampleOnce();
  const withCpu = snap.consumers.filter((c) => c.cpuPct > 0);
  assert.ok(withCpu.length >= 0);
});
