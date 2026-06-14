import fs from "node:fs/promises";
import os from "node:os";
import { CpuConsumerTracker, type CpuConsumersSnapshot } from "./cpuConsumers";

export type HealthStatus = "ok" | "warning" | "critical" | "unknown";

export type DiskMountSnapshot = {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
};

export type HostMetricsSnapshot = {
  timestamp: string;
  hostname: string;
  platform: string;
  arch: string;
  uptimeSec: number;
  cpuCount: number;
  cpuUsagePct: number | null;
  loadAvg: [number, number, number];
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPct: number;
    cgroupLimited: boolean;
  };
  storage: DiskMountSnapshot[];
  processMemory: {
    heapUsedBytes: number;
    rssBytes: number;
  };
  cpuConsumers: CpuConsumersSnapshot;
};

type CpuSample = { idle: number; total: number };

const DEFAULT_MOUNT_PATHS = [
  "/",
  "/var/lib/connect/moh-assets",
  "/var/lib/connect/chat-attachments",
  "/var/lib/connect/crm-lead-docs",
];

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function parseProcStatCpuLine(line: string): CpuSample | null {
  if (!line.startsWith("cpu ")) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const idle = parts[3] + (parts[4] ?? 0);
  const total = parts.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

export function computeCpuUsagePct(prev: CpuSample, next: CpuSample): number {
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  if (totalDelta <= 0) return 0;
  const used = totalDelta - idleDelta;
  return clampPct((used / totalDelta) * 100);
}

async function readProcStatCpu(): Promise<CpuSample | null> {
  try {
    const raw = await fs.readFile("/proc/stat", "utf8");
    const line = raw.split("\n").find((l) => l.startsWith("cpu "));
    if (!line) return null;
    return parseProcStatCpuLine(line);
  } catch {
    return null;
  }
}

async function readCgroupMemoryLimitBytes(): Promise<number | null> {
  const paths = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];
  for (const path of paths) {
    try {
      const raw = (await fs.readFile(path, "utf8")).trim();
      if (raw === "max") return os.totalmem();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // try next path
    }
  }
  return null;
}

async function statMount(path: string): Promise<DiskMountSnapshot | null> {
  try {
    const stat = await fs.statfs(path);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bfree) * Number(stat.bsize);
    if (totalBytes <= 0) return null;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      path,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct: clampPct((usedBytes / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

function defaultMountPaths(): string[] {
  if (process.platform === "win32") {
    const drive = (process.env.SystemDrive || "C:").replace(/\/+$/, "");
    return [`${drive}\\`];
  }
  return DEFAULT_MOUNT_PATHS;
}

async function collectStorage(): Promise<DiskMountSnapshot[]> {
  const envPaths = String(process.env.SERVER_HEALTH_MOUNT_PATHS || "")
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const paths = envPaths.length > 0 ? envPaths : defaultMountPaths();
  const mounts: DiskMountSnapshot[] = [];
  for (const path of paths) {
    const snap = await statMount(path);
    if (snap) mounts.push(snap);
  }
  return mounts;
}

async function collectMemory(): Promise<HostMetricsSnapshot["memory"]> {
  const cgroupLimit = await readCgroupMemoryLimitBytes();
  const hostTotal = os.totalmem();
  const hostFree = os.freemem();
  const totalBytes = cgroupLimit ?? hostTotal;
  const usedBytes = cgroupLimit != null
    ? Math.min(cgroupLimit, Math.max(0, cgroupLimit - hostFree))
    : hostTotal - hostFree;
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usedPct: clampPct((usedBytes / totalBytes) * 100),
    cgroupLimited: cgroupLimit != null,
  };
}

export async function collectHostMetrics(
  cpuUsagePct: number | null,
  cpuConsumers: CpuConsumersSnapshot,
): Promise<HostMetricsSnapshot> {
  const memUsage = process.memoryUsage();
  const load = os.loadavg();
  const memory = await collectMemory();
  const storage = await collectStorage();

  return {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptimeSec: Math.floor(os.uptime()),
    cpuCount: os.cpus().length,
    cpuUsagePct,
    loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    memory,
    storage,
    processMemory: {
      heapUsedBytes: memUsage.heapUsed,
      rssBytes: memUsage.rss,
    },
    cpuConsumers,
  };
}

export class HostMetricsCollector {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpuSample: CpuSample | null = null;
  private lastProcessCpu: ReturnType<typeof process.cpuUsage> | null = null;
  private lastSampleAt = 0;
  private lastCpuUsagePct: number | null = null;
  private snapshot: HostMetricsSnapshot | null = null;
  private collecting = false;
  private cpuConsumerTracker = new CpuConsumerTracker();

  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
  }

  getSnapshot(): HostMetricsSnapshot | null {
    return this.snapshot;
  }

  async sampleOnce(): Promise<HostMetricsSnapshot> {
    if (this.collecting) {
      if (this.snapshot) return this.snapshot;
    }
    this.collecting = true;
    try {
      const now = Date.now();
      const cpuSample = await readProcStatCpu();
      const procCpu = process.cpuUsage();
      if (cpuSample && this.lastCpuSample) {
        this.lastCpuUsagePct = computeCpuUsagePct(this.lastCpuSample, cpuSample);
      } else if (this.lastProcessCpu && this.lastSampleAt > 0) {
        const elapsedMs = Math.max(1, now - this.lastSampleAt);
        const usedUs =
          (procCpu.user - this.lastProcessCpu.user) + (procCpu.system - this.lastProcessCpu.system);
        const cores = Math.max(1, os.cpus().length);
        this.lastCpuUsagePct = clampPct((usedUs / 1000 / elapsedMs / cores) * 100);
      } else if (this.lastCpuUsagePct == null) {
        const cores = Math.max(1, os.cpus().length);
        const load = os.loadavg()[0] ?? 0;
        this.lastCpuUsagePct = load > 0 ? clampPct((load / cores) * 100) : null;
      }
      if (cpuSample) this.lastCpuSample = cpuSample;
      this.lastProcessCpu = procCpu;
      this.lastSampleAt = now;

      const cpuConsumers = await this.cpuConsumerTracker.sampleOnce();
      const snap = await collectHostMetrics(this.lastCpuUsagePct, cpuConsumers);
      this.snapshot = snap;
      return snap;
    } finally {
      this.collecting = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.sampleOnce();
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function deriveResourceHealth(
  cpuPct: number | null,
  memPct: number,
  storage: DiskMountSnapshot[],
): HealthStatus {
  const storageMax = storage.reduce((max, m) => Math.max(max, m.usedPct), 0);
  if (cpuPct != null && cpuPct >= 95 || memPct >= 95 || storageMax >= 95) return "critical";
  if (cpuPct != null && cpuPct >= 85 || memPct >= 85 || storageMax >= 90) return "warning";
  return "ok";
}
