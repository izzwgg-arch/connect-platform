import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import os from "node:os";

const execFileAsync = promisify(execFile);

export type CpuConsumerKind = "process" | "container";

export type CpuConsumer = {
  kind: CpuConsumerKind;
  id: string;
  name: string;
  cpuPct: number;
  memoryBytes: number | null;
  detail: string | null;
};

export type CpuConsumerScope = "host_processes" | "container_processes" | "docker_containers" | "unavailable";

export type CpuConsumersSnapshot = {
  scope: CpuConsumerScope;
  scopeNote: string;
  consumers: CpuConsumer[];
  sampledAt: string;
};

type ProcessCpuSample = {
  jiffies: number;
  memoryBytes: number;
  name: string;
  cmdline: string | null;
};

const DEFAULT_TOP_N = Math.min(25, Math.max(5, Number(process.env.SERVER_HEALTH_CPU_TOP_N || 15)));
const CLK_TCK = 100;
const DOCKER_SOCKET = (process.env.SERVER_HEALTH_DOCKER_SOCKET || "/var/run/docker.sock").trim();
const PROC_ROOT = (process.env.SERVER_HEALTH_PROC_ROOT || "/proc").replace(/\/+$/, "");

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function parseProcStat(content: string): { utime: number; stime: number; name: string } | null {
  const open = content.indexOf("(");
  const close = content.indexOf(")");
  if (open < 0 || close <= open) return null;
  const name = content.slice(open + 1, close);
  const rest = content.slice(close + 2).split(" ");
  if (rest.length < 13) return null;
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utime, stime, name };
}

async function readProcCmdline(pid: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(`${PROC_ROOT}/${pid}/cmdline`, "utf8");
    const parts = raw.split("\0").filter(Boolean);
    if (parts.length === 0) return null;
    const joined = parts.join(" ").trim();
    return joined.length > 120 ? `${joined.slice(0, 117)}...` : joined;
  } catch {
    return null;
  }
}

async function readProcStatusVmRss(pid: string): Promise<number> {
  try {
    const raw = await fs.readFile(`${PROC_ROOT}/${pid}/status`, "utf8");
    const line = raw.split("\n").find((l) => l.startsWith("VmRSS:"));
    if (!line) return 0;
    const kb = Number(line.split(/\s+/)[1]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

async function listLinuxProcessSamples(): Promise<Map<string, ProcessCpuSample>> {
  const out = new Map<string, ProcessCpuSample>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(PROC_ROOT);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const statRaw = await fs.readFile(`${PROC_ROOT}/${entry}/stat`, "utf8");
      const parsed = parseProcStat(statRaw);
      if (!parsed) continue;
      const cmdline = await readProcCmdline(entry);
      const memoryBytes = await readProcStatusVmRss(entry);
      out.set(entry, {
        jiffies: parsed.utime + parsed.stime,
        memoryBytes,
        name: parsed.name,
        cmdline,
      });
    } catch {
      // process exited between list and read
    }
  }
  return out;
}

function computeProcessConsumers(
  prev: Map<string, ProcessCpuSample>,
  next: Map<string, ProcessCpuSample>,
  elapsedMs: number,
  cores: number,
): CpuConsumer[] {
  const elapsedSec = Math.max(0.001, elapsedMs / 1000);
  const consumers: CpuConsumer[] = [];

  for (const [pid, sample] of next) {
    const before = prev.get(pid);
    if (!before) continue;
    const deltaJiffies = sample.jiffies - before.jiffies;
    if (deltaJiffies <= 0) continue;
    const cpuPct = clampPct((deltaJiffies / CLK_TCK / elapsedSec / cores) * 100);
    if (cpuPct <= 0) continue;
    const displayName = sample.cmdline?.split(/\s+/)[0] || sample.name;
    consumers.push({
      kind: "process",
      id: pid,
      name: displayName,
      cpuPct,
      memoryBytes: sample.memoryBytes > 0 ? sample.memoryBytes : null,
      detail: sample.cmdline && sample.cmdline !== displayName ? sample.cmdline : null,
    });
  }

  return consumers.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, DEFAULT_TOP_N);
}

type WindowsProcSample = { pid: string; name: string; cpuSec: number; memoryBytes: number };

async function listWindowsProcessSamples(): Promise<WindowsProcSample[]> {
  const script =
    "Get-Process | Sort-Object CPU -Descending | Select-Object -First 40 Id,ProcessName,CPU,WorkingSet | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 2500, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim()) as Array<{
      Id?: number;
      ProcessName?: string;
      CPU?: number;
      WorkingSet?: number;
    }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: String(row.Id ?? ""),
        name: String(row.ProcessName ?? "unknown"),
        cpuSec: Number(row.CPU ?? 0),
        memoryBytes: Number(row.WorkingSet ?? 0),
      }))
      .filter((r) => r.pid);
  } catch {
    return [];
  }
}

function computeWindowsConsumers(
  prev: Map<string, WindowsProcSample>,
  next: WindowsProcSample[],
  elapsedMs: number,
  cores: number,
): CpuConsumer[] {
  const elapsedSec = Math.max(0.001, elapsedMs / 1000);
  const consumers: CpuConsumer[] = [];
  for (const sample of next) {
    const before = prev.get(sample.pid);
    if (!before) continue;
    const deltaSec = sample.cpuSec - before.cpuSec;
    if (deltaSec <= 0) continue;
    const cpuPct = clampPct((deltaSec / elapsedSec / cores) * 100);
    if (cpuPct <= 0) continue;
    consumers.push({
      kind: "process",
      id: sample.pid,
      name: sample.name,
      cpuPct,
      memoryBytes: sample.memoryBytes > 0 ? sample.memoryBytes : null,
      detail: null,
    });
  }
  return consumers.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, DEFAULT_TOP_N);
}

type DockerContainerRow = { Id: string; Names: string[] };

function dockerHttpGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method: "GET",
        timeout: 4000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`docker ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("docker_timeout"));
    });
    req.end();
  });
}

async function listDockerContainerConsumers(): Promise<CpuConsumer[]> {
  try {
    await fs.access(DOCKER_SOCKET);
  } catch {
    return [];
  }

  try {
    const listRaw = await dockerHttpGet("/containers/json");
    const containers = JSON.parse(listRaw) as DockerContainerRow[];
    const cores = Math.max(1, os.cpus().length);
    const consumers: CpuConsumer[] = [];

    for (const c of containers.slice(0, 20)) {
      const id = c.Id;
      const shortId = id.slice(0, 12);
      const name = (c.Names?.[0] || shortId).replace(/^\//, "");
      try {
        const statsRaw = await dockerHttpGet(`/containers/${id}/stats?stream=false`);
        const stats = JSON.parse(statsRaw) as {
          memory_stats?: { usage?: number };
          cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
          precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
        };
        const cpuDelta =
          (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
          (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
        const sysDelta =
          (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
        let cpuPct = 0;
        if (sysDelta > 0 && cpuDelta > 0) {
          cpuPct = clampPct((cpuDelta / sysDelta) * cores * 100);
        }
        const memoryBytes = stats.memory_stats?.usage ?? null;
        if (cpuPct > 0 || memoryBytes != null) {
          consumers.push({
            kind: "container",
            id: shortId,
            name,
            cpuPct,
            memoryBytes: memoryBytes != null ? Number(memoryBytes) : null,
            detail: "docker",
          });
        }
      } catch {
        // skip container that failed stats
      }
    }

    return consumers.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, DEFAULT_TOP_N);
  } catch {
    return [];
  }
}

export class CpuConsumerTracker {
  private lastLinuxSamples = new Map<string, ProcessCpuSample>();
  private lastWindowsSamples = new Map<string, WindowsProcSample>();
  private lastSampleAt = 0;
  private lastSnapshot: CpuConsumersSnapshot = {
    scope: "unavailable",
    scopeNote: "Waiting for first CPU sample",
    consumers: [],
    sampledAt: new Date().toISOString(),
  };

  getSnapshot(): CpuConsumersSnapshot {
    return this.lastSnapshot;
  }

  async sampleOnce(): Promise<CpuConsumersSnapshot> {
    const now = Date.now();
    const elapsedMs = this.lastSampleAt > 0 ? now - this.lastSampleAt : 0;
    const cores = Math.max(1, os.cpus().length);
    const sampledAt = new Date().toISOString();

    const dockerConsumers = await listDockerContainerConsumers();
    if (dockerConsumers.length > 0) {
      this.lastSnapshot = {
        scope: "docker_containers",
        scopeNote: "Per-container CPU from Docker (all Connect services on this host)",
        consumers: dockerConsumers,
        sampledAt,
      };
      this.lastSampleAt = now;
      return this.lastSnapshot;
    }

    if (process.platform === "win32") {
      const current = await listWindowsProcessSamples();
      if (elapsedMs > 500 && this.lastWindowsSamples.size > 0) {
        const consumers = computeWindowsConsumers(this.lastWindowsSamples, current, elapsedMs, cores);
        this.lastSnapshot = {
          scope: "host_processes",
          scopeNote: "Per-process CPU on this Windows host",
          consumers,
          sampledAt,
        };
      } else if (this.lastSnapshot.consumers.length === 0) {
        this.lastSnapshot = {
          scope: "host_processes",
          scopeNote: "Collecting baseline — top CPU processes appear after the next sample",
          consumers: current.slice(0, DEFAULT_TOP_N).map((p) => ({
            kind: "process",
            id: p.pid,
            name: p.name,
            cpuPct: 0,
            memoryBytes: p.memoryBytes > 0 ? p.memoryBytes : null,
            detail: "warming up",
          })),
          sampledAt,
        };
      }
      this.lastWindowsSamples = new Map(current.map((p) => [p.pid, p]));
      this.lastSampleAt = now;
      return this.lastSnapshot;
    }

    const currentLinux = await listLinuxProcessSamples();
    const procRootIsHost = PROC_ROOT !== "/proc";
    const scope: CpuConsumerScope = procRootIsHost ? "host_processes" : "container_processes";
    const scopeNote = procRootIsHost
      ? "Per-process CPU on the app host (via mounted host /proc)"
      : "Per-process CPU inside the API container — mount host /proc at SERVER_HEALTH_PROC_ROOT for full host view, or enable Docker socket for container breakdown";

    if (elapsedMs > 500 && this.lastLinuxSamples.size > 0 && currentLinux.size > 0) {
      const consumers = computeProcessConsumers(this.lastLinuxSamples, currentLinux, elapsedMs, cores);
      this.lastSnapshot = {
        scope,
        scopeNote,
        consumers,
        sampledAt,
      };
    } else if (this.lastSnapshot.consumers.length === 0) {
      const warming = [...currentLinux.entries()]
        .slice(0, DEFAULT_TOP_N)
        .map(([pid, p]) => ({
          kind: "process" as const,
          id: pid,
          name: p.cmdline?.split(/\s+/)[0] || p.name,
          cpuPct: 0,
          memoryBytes: p.memoryBytes > 0 ? p.memoryBytes : null,
          detail: "warming up",
        }));
      this.lastSnapshot = {
        scope,
        scopeNote: "Collecting baseline — top CPU processes appear after the next sample",
        consumers: warming,
        sampledAt,
      };
    }

    this.lastLinuxSamples = currentLinux;
    this.lastSampleAt = now;
    return this.lastSnapshot;
  }
}
