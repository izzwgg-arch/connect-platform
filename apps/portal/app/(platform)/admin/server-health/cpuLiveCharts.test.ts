import test from "node:test";
import assert from "node:assert/strict";
import { buildConsumerTracks, cpuHeatColor } from "./CpuLiveCharts";

test("cpuHeatColor maps low to green and high to red", () => {
  assert.equal(cpuHeatColor(0), "rgb(34, 197, 94)");
  assert.equal(cpuHeatColor(100), "rgb(239, 68, 68)");
  const mid = cpuHeatColor(50);
  assert.ok(mid.includes("234") || mid.includes("179"));
});

test("buildConsumerTracks records rank positions over samples", () => {
  const c1 = { kind: "process" as const, id: "1", name: "node", cpuPct: 40, memoryBytes: null, detail: null };
  const c2 = { kind: "process" as const, id: "2", name: "postgres", cpuPct: 20, memoryBytes: null, detail: null };
  const first = buildConsumerTracks([c1, c2], {});
  const state: Record<string, { cpuSeries: number[]; rankSeries: number[]; name: string; kind: "process" }> = {};
  for (const t of first) {
    state[t.key] = { cpuSeries: t.cpuSeries, rankSeries: t.rankSeries, name: t.name, kind: t.kind };
  }
  const swapped = buildConsumerTracks(
    [
      { ...c2, cpuPct: 55 },
      { ...c1, cpuPct: 10 },
    ],
    state,
  );
  const postgres = swapped.find((t) => t.name === "postgres");
  assert.ok(postgres);
  assert.equal(postgres!.currentRank, 1);
  assert.equal(postgres!.rankSeries.length, 2);
  assert.equal(postgres!.rankSeries[0], 2);
  assert.equal(postgres!.rankSeries[1], 1);
  assert.equal(postgres!.rankDelta, 1);
});
