import type { LogForensicsRow, LogForensicsSummary, StorageInventoryItem, StorageMaintenanceConfig, StorageTrendPoint } from "../types";

type LogDirProbe = {
  path: string;
  label: string;
  sizeBytes: number | null;
  oldestFile: string | null;
  newestFile: string | null;
  oldestDate: string | null;
  newestDate: string | null;
};

export function buildLogForensics(
  items: StorageInventoryItem[],
  config: StorageMaintenanceConfig,
  history: StorageTrendPoint[] = [],
): LogForensicsSummary {
  const logPaths: Array<{ path: string; label: string }> = [
    { path: config.journalRoot, label: "systemd journal" },
    { path: config.deployLogsRoot, label: "connect deploy logs" },
    { path: config.monitoringLogsRoot, label: "monitoring logs" },
  ];

  const locations: LogForensicsRow[] = logPaths.map(({ path, label }) => {
    const item = items.find((i) => i.pathOrRef === path || i.pathOrRef.endsWith(path.split("/").pop() ?? ""));
    const fsItem = items.find((i) => i.kind === "log_directory" && i.pathOrRef.includes(path));
    const sizeBytes = item?.sizeBytes ?? fsItem?.sizeBytes ?? null;
    return {
      path,
      label,
      sizeBytes,
      oldestFile: null,
      newestFile: null,
      oldestDate: null,
      newestDate: null,
      growthRateBytesPerDay: estimateLogGrowth(history),
    };
  });

  const extraLogs = items
    .filter((i) => i.kind === "log_directory" && !locations.some((l) => l.path === i.pathOrRef))
    .map((i) => ({
      path: i.pathOrRef,
      label: i.label,
      sizeBytes: i.sizeBytes,
      oldestFile: null,
      newestFile: null,
      oldestDate: null,
      newestDate: null,
      growthRateBytesPerDay: estimateLogGrowth(history),
    }));

  const all = [...locations, ...extraLogs];
  const totalBytes = all.reduce((s, l) => s + (l.sizeBytes ?? 0), 0);
  return { totalBytes, locations: all };
}

function estimateLogGrowth(history: StorageTrendPoint[]): number | null {
  if (history.length < 2) return null;
  const sorted = [...history].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const dtDays = (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / (24 * 60 * 60 * 1000);
  if (dtDays < 0.5) return null;
  const du = (last.usedBytes ?? 0) - (first.usedBytes ?? 0);
  return Math.round(du / dtDays);
}
