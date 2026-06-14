import type { ServerHealthSnapshot } from "./serverHealth";
import {
  buildHostOnlyHealthSnapshot,
  buildServerHealthSnapshot,
  type ServerHealthDeps,
} from "./serverHealth";

let cachedSnapshot: ServerHealthSnapshot | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const SNAPSHOT_BUILD_TIMEOUT_MS = Math.min(
  30_000,
  Math.max(3000, Number(process.env.SERVER_HEALTH_BUILD_TIMEOUT_MS || 12_000)),
);

async function withBuildTimeout<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server_health_build_timeout")), SNAPSHOT_BUILD_TIMEOUT_MS);
    fn()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function warmingSnapshot(): ServerHealthSnapshot {
  const now = new Date().toISOString();
  return {
    timestamp: now,
    overallStatus: "unknown",
    systemHealth: "unknown",
    serverHealth: "unknown",
    host: {
      timestamp: now,
      hostname: "warming",
      platform: "",
      arch: "",
      uptimeSec: 0,
      cpuCount: 0,
      cpuUsagePct: null,
      loadAvg: [0, 0, 0],
      memory: {
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        usedPct: 0,
        cgroupLimited: false,
      },
      storage: [],
      processMemory: { heapUsedBytes: 0, rssBytes: 0 },
      cpuConsumers: {
        scope: "unavailable",
        scopeNote: "Collecting first metrics sample…",
        consumers: [],
        sampledAt: now,
      },
    },
    services: [],
    deployQueue: null,
  };
}

export function hasServerHealthCache(): boolean {
  return cachedSnapshot !== null;
}

export function getCachedServerHealthSnapshot(): ServerHealthSnapshot {
  return cachedSnapshot ?? warmingSnapshot();
}

export async function refreshServerHealthSnapshot(deps: ServerHealthDeps): Promise<void> {
  if (refreshInFlight) {
    await refreshInFlight;
    return;
  }
  refreshInFlight = (async () => {
    try {
      cachedSnapshot = await withBuildTimeout(() => buildServerHealthSnapshot(deps));
    } catch {
      try {
        cachedSnapshot = await buildHostOnlyHealthSnapshot(deps);
      } catch {
        // keep last good snapshot on transient errors
      }
    }
  })();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export function startServerHealthRefresh(deps: ServerHealthDeps, intervalMs = 5000): void {
  if (refreshTimer) return;
  void refreshServerHealthSnapshot(deps);
  refreshTimer = setInterval(() => {
    void refreshServerHealthSnapshot(deps);
  }, intervalMs);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

export function stopServerHealthRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
