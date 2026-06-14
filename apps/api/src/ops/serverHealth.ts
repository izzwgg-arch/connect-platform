import type { PrismaClient } from "@connect/db";
import type IORedis from "ioredis";
import {
  type DiskMountSnapshot,
  type HealthStatus,
  type HostMetricsCollector,
  type HostMetricsSnapshot,
  deriveResourceHealth,
} from "./hostMetrics";

export type ServiceProbe = {
  id: string;
  label: string;
  status: HealthStatus;
  latencyMs: number | null;
  detail: string | null;
  endpoint: string;
};

export type DeployQueueHealth = {
  status: HealthStatus;
  runningCount: number;
  queuedCount: number;
  detail: string | null;
};

export type ServerHealthSnapshot = {
  timestamp: string;
  overallStatus: HealthStatus;
  systemHealth: HealthStatus;
  serverHealth: HealthStatus;
  host: HostMetricsSnapshot;
  services: ServiceProbe[];
  deployQueue: DeployQueueHealth | null;
};

type ProbeTarget = {
  id: string;
  label: string;
  url: string;
  optional?: boolean;
};

type ServerHealthDeps = {
  collector: HostMetricsCollector;
  db: PrismaClient;
  redis: IORedis;
  dqFetch: (path: string, timeoutMs?: number) => Promise<{ ok: boolean; status: number; data: unknown }>;
};

const SERVICE_PROBE_TIMEOUT_MS = Math.min(
  2500,
  Math.max(400, Number(process.env.SERVER_HEALTH_PROBE_TIMEOUT_MS || 1200)),
);
const REDIS_PROBE_TIMEOUT_MS = Math.min(
  2500,
  Math.max(400, Number(process.env.SERVER_HEALTH_REDIS_PROBE_TIMEOUT_MS || 1500)),
);
const SERVICE_PROBE_CACHE_MS = 8000;
const DEPLOY_QUEUE_PROBE_TIMEOUT_MS = Math.min(
  2500,
  Math.max(300, Number(process.env.SERVER_HEALTH_DEPLOY_QUEUE_TIMEOUT_MS || 1500)),
);

function isLocalDevHost(): boolean {
  return process.env.NODE_ENV === "development" || process.platform === "win32";
}

function localProbeUrl(envKey: string, fallback: string): string {
  const raw = String(process.env[envKey] || "").trim();
  if (raw) return raw.replace(/\/+$/, "");
  return fallback;
}

let cachedServiceProbes: ServiceProbe[] | null = null;
let cachedServiceProbesAt = 0;
let cachedDeployQueue: DeployQueueHealth | null = null;
let cachedDeployQueueAt = 0;

function probeTargets(): ProbeTarget[] {
  const apiPort = Number(process.env.PORT || 3001);
  const apiReady = `${localProbeUrl("SERVER_HEALTH_API_PROBE_URL", `http://127.0.0.1:${apiPort}`)}/ready`;

  const portalBase = isLocalDevHost()
    ? localProbeUrl(
        "SERVER_HEALTH_PORTAL_PROBE_URL",
        `http://127.0.0.1:${process.env.SERVER_HEALTH_PORTAL_PORT || "3002"}`,
      )
    : (process.env.PORTAL_INTERNAL_URL || "http://portal:3000").replace(/\/+$/, "");

  const telephonyBase = isLocalDevHost()
    ? localProbeUrl("SERVER_HEALTH_TELEPHONY_PROBE_URL", "http://127.0.0.1:3003")
    : (process.env.TELEPHONY_INTERNAL_URL || "http://telephony:3003").replace(/\/+$/, "");

  const realtimeBase = isLocalDevHost()
    ? localProbeUrl("SERVER_HEALTH_REALTIME_PROBE_URL", "http://127.0.0.1:3002")
    : (process.env.REALTIME_INTERNAL_URL || "http://realtime:3002").replace(/\/+$/, "");
  // On local Windows dev, portal often occupies :3002 — skip realtime unless explicitly configured.
  const skipRealtimeLocal =
    isLocalDevHost() && !process.env.SERVER_HEALTH_REALTIME_PROBE_URL?.trim();

  return [
    { id: "api", label: "API", url: apiReady },
    { id: "portal", label: "Portal", url: `${portalBase}/ready` },
    { id: "telephony", label: "Telephony", url: `${telephonyBase}/health`, optional: isLocalDevHost() },
    ...(skipRealtimeLocal
      ? []
      : [{ id: "realtime", label: "Realtime", url: `${realtimeBase}/health`, optional: true }]),
  ];
}

function statusFromHttp(ok: boolean, statusCode: number): HealthStatus {
  if (ok) return "ok";
  if (statusCode === 503) return "warning";
  return "critical";
}

async function withProbeTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
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

async function probeHttp(target: ProbeTarget): Promise<ServiceProbe> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVICE_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(target.url, { signal: ctrl.signal });
    const latencyMs = Date.now() - start;
    const ok = res.ok;
    let detail: string | null = null;
    try {
      const body = await res.json() as Record<string, unknown>;
      if (typeof body.status === "string") detail = body.status;
      else if (typeof body.ready === "boolean") detail = body.ready ? "ready" : "not_ready";
      else if (typeof body.ok === "boolean") detail = body.ok ? "ok" : "error";
    } catch {
      detail = ok ? "reachable" : `HTTP ${res.status}`;
    }
    return {
      id: target.id,
      label: target.label,
      status: statusFromHttp(ok, res.status),
      latencyMs,
      detail,
      endpoint: target.url,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: target.id,
      label: target.label,
      status: target.optional ? "unknown" : "critical",
      latencyMs: null,
      detail: msg.slice(0, 120),
      endpoint: target.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeDatabase(db: PrismaClient): Promise<ServiceProbe> {
  const start = Date.now();
  try {
    await db.$queryRawUnsafe("SELECT 1");
    return {
      id: "database",
      label: "PostgreSQL",
      status: "ok",
      latencyMs: Date.now() - start,
      detail: "connected",
      endpoint: "prisma",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: "database",
      label: "PostgreSQL",
      status: "critical",
      latencyMs: null,
      detail: msg.slice(0, 120),
      endpoint: "prisma",
    };
  }
}

async function probeRedis(redis: IORedis): Promise<ServiceProbe> {
  const start = Date.now();
  try {
    const pong = await withProbeTimeout(REDIS_PROBE_TIMEOUT_MS, "redis_ping", () => redis.ping());
    return {
      id: "redis",
      label: "Redis",
      status: pong === "PONG" ? "ok" : "warning",
      latencyMs: Date.now() - start,
      detail: pong,
      endpoint: process.env.REDIS_URL || "redis",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: "redis",
      label: "Redis",
      status: "critical",
      latencyMs: null,
      detail: msg.slice(0, 120),
      endpoint: process.env.REDIS_URL || "redis",
    };
  }
}

async function probeWorkerQueues(redis: IORedis): Promise<ServiceProbe> {
  const start = Date.now();
  try {
    const metaExists = await withProbeTimeout(REDIS_PROBE_TIMEOUT_MS, "redis_exists", () =>
      redis.exists("bull:sms-send:meta"),
    );
    return {
      id: "worker",
      label: "Worker (queues)",
      status: "ok",
      latencyMs: Date.now() - start,
      detail: metaExists ? "sms-send queue registered" : "redis reachable",
      endpoint: "bull:sms-send:meta",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: "worker",
      label: "Worker (queues)",
      status: "warning",
      latencyMs: null,
      detail: msg.slice(0, 120),
      endpoint: "bull:sms-send",
    };
  }
}

async function collectServiceProbes(db: PrismaClient, redis: IORedis): Promise<ServiceProbe[]> {
  const now = Date.now();
  if (cachedServiceProbes && now - cachedServiceProbesAt < SERVICE_PROBE_CACHE_MS) {
    return cachedServiceProbes;
  }

  const httpTargets = probeTargets();
  const [dbProbe, redisProbe, workerProbe, ...httpProbes] = await Promise.all([
    probeDatabase(db),
    probeRedis(redis),
    probeWorkerQueues(redis),
    ...httpTargets.map((t) => probeHttp(t)),
  ]);

  const services = [dbProbe, redisProbe, workerProbe, ...httpProbes];
  cachedServiceProbes = services;
  cachedServiceProbesAt = now;
  return services;
}

async function collectDeployQueueHealth(
  dqFetch: ServerHealthDeps["dqFetch"],
): Promise<DeployQueueHealth | null> {
  const now = Date.now();
  if (cachedDeployQueue && now - cachedDeployQueueAt < SERVICE_PROBE_CACHE_MS) {
    return cachedDeployQueue;
  }

  if (!process.env.DEPLOY_QUEUE_TOKEN) {
    return null;
  }

  try {
    const r = await dqFetch("/ops/deploy/status", DEPLOY_QUEUE_PROBE_TIMEOUT_MS);
    if (!r.ok) {
      const out: DeployQueueHealth = {
        status: "warning",
        runningCount: 0,
        queuedCount: 0,
        detail: `queue HTTP ${r.status}`,
      };
      cachedDeployQueue = out;
      cachedDeployQueueAt = now;
      return out;
    }
    const data = r.data as {
      runningCount?: number;
      queuedCount?: number;
      lock?: { present?: boolean; pidAlive?: boolean | null };
    };
    const runningCount = Number(data.runningCount ?? 0);
    const queuedCount = Number(data.queuedCount ?? 0);
    const lockBad = data.lock?.present && data.lock?.pidAlive === false;
    const status: HealthStatus = lockBad ? "warning" : "ok";
    const out: DeployQueueHealth = {
      status,
      runningCount,
      queuedCount,
      detail: lockBad ? "stale deploy lock" : null,
    };
    cachedDeployQueue = out;
    cachedDeployQueueAt = now;
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out: DeployQueueHealth = {
      status: "unknown",
      runningCount: 0,
      queuedCount: 0,
      detail: msg.slice(0, 120),
    };
    cachedDeployQueue = out;
    cachedDeployQueueAt = now;
    return out;
  }
}

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  const rank: Record<HealthStatus, number> = {
    critical: 4,
    warning: 3,
    unknown: 2,
    ok: 1,
  };
  let worst: HealthStatus = "ok";
  for (const s of statuses) {
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

export async function buildHostOnlyHealthSnapshot(deps: ServerHealthDeps): Promise<ServerHealthSnapshot> {
  let hostSnap = deps.collector.getSnapshot();
  if (!hostSnap) {
    await deps.collector.sampleOnce();
    hostSnap = deps.collector.getSnapshot();
  }
  if (!hostSnap) {
    throw new Error("host_metrics_not_ready");
  }
  const systemHealth = deriveResourceHealth(
    hostSnap.cpuUsagePct,
    hostSnap.memory.usedPct,
    hostSnap.storage as DiskMountSnapshot[],
  );
  return {
    timestamp: new Date().toISOString(),
    overallStatus: systemHealth,
    systemHealth,
    serverHealth: "unknown",
    host: hostSnap,
    services: [],
    deployQueue: null,
  };
}

export async function buildServerHealthSnapshot(deps: ServerHealthDeps): Promise<ServerHealthSnapshot> {
  const host = deps.collector.getSnapshot();
  if (!host) {
    await deps.collector.sampleOnce();
  }
  const hostSnap = deps.collector.getSnapshot();
  if (!hostSnap) {
    throw new Error("host_metrics_not_ready");
  }
  const services = await collectServiceProbes(deps.db, deps.redis);
  const deployQueue = await collectDeployQueueHealth(deps.dqFetch);

  const systemHealth = deriveResourceHealth(
    host.cpuUsagePct,
    host.memory.usedPct,
    host.storage as DiskMountSnapshot[],
  );

  const serviceStatuses = services.map((s) => s.status);
  if (deployQueue) serviceStatuses.push(deployQueue.status);
  const serverHealth = worstStatus(serviceStatuses);
  const overallStatus = worstStatus([systemHealth, serverHealth]);

  return {
    timestamp: new Date().toISOString(),
    overallStatus,
    systemHealth,
    serverHealth,
    host: hostSnap,
    services,
    deployQueue,
  };
}
