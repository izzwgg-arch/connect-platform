import type { CpuConsumerRow } from "./CpuLiveCharts";

/** Plausible metric wave for localhost dev previews (charts need history before live polls accumulate). */
export function seedDevMetricHistory(center: number, points = 28): number[] {
  const base = Number.isFinite(center) ? center : 24;
  return Array.from({ length: points }, (_, i) => {
    const wave = Math.sin((i / points) * Math.PI * 2.4) * 11;
    const drift = (i / points) * 5;
    const jitter = ((i * 17) % 7) - 3;
    return Math.max(3, Math.min(97, Math.round(base + wave + drift + jitter)));
  });
}

const DEMO_CONSUMERS: CpuConsumerRow[] = [
  { kind: "process", id: "demo-node", name: "node", cpuPct: 31.2, memoryBytes: 520_000_000, detail: null },
  { kind: "process", id: "demo-postgres", name: "postgres", cpuPct: 18.4, memoryBytes: 890_000_000, detail: null },
  { kind: "container", id: "demo-api", name: "app-api-1", cpuPct: 14.1, memoryBytes: 410_000_000, detail: "docker" },
  { kind: "container", id: "demo-portal", name: "app-portal-1", cpuPct: 9.8, memoryBytes: 280_000_000, detail: "docker" },
  { kind: "process", id: "demo-chrome", name: "chrome", cpuPct: 7.2, memoryBytes: 640_000_000, detail: null },
  { kind: "container", id: "demo-worker", name: "app-worker-1", cpuPct: 5.6, memoryBytes: 190_000_000, detail: "docker" },
  { kind: "process", id: "demo-powershell", name: "powershell", cpuPct: 3.1, memoryBytes: 95_000_000, detail: null },
];

export function seedDevConsumerTrackState(
  consumers: CpuConsumerRow[],
): Record<string, { cpuSeries: number[]; rankSeries: number[]; name: string; kind: CpuConsumerRow["kind"] }> {
  const rows =
    consumers.filter((c) => c.cpuPct > 0 || c.detail !== "warming up").length > 0
      ? [...consumers].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 8)
      : DEMO_CONSUMERS;

  const out: Record<string, { cpuSeries: number[]; rankSeries: number[]; name: string; kind: CpuConsumerRow["kind"] }> =
    {};

  rows.forEach((row, rankIdx) => {
    const key = `${row.kind}:${row.id}:${row.name}`;
    const center = row.cpuPct > 0 ? row.cpuPct : 8 + rankIdx * 3;
    const cpuSeries = seedDevMetricHistory(center, 24).map((v, i) =>
      Math.max(0.5, v * (0.75 + (rows.length - rankIdx) / rows.length * 0.35) * (0.92 + (i % 5) * 0.02)),
    );
    const rankSeries = Array.from({ length: cpuSeries.length }, (_, i) => {
      const wobble = Math.sin(i / 3 + rankIdx) > 0.3 ? 0 : 1;
      return Math.max(1, Math.min(rows.length, rankIdx + 1 + wobble));
    });
    out[key] = {
      cpuSeries,
      rankSeries,
      name: row.name,
      kind: row.kind,
    };
  });

  return out;
}
