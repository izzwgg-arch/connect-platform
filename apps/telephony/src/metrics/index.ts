/**
 * Prometheus metrics for the Connect telephony service.
 * Exposes a /metrics endpoint scraped by Prometheus.
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "telephony" });

// Node.js runtime metrics (CPU, memory, event-loop lag, GC, etc.)
collectDefaultMetrics({ register: registry });

// ── PBX connectivity ─────────────────────────────────────────────────────────

export const amiConnected = new Gauge({
  name: "connect_ami_connected",
  help: "1 if AMI is connected to the PBX, 0 otherwise",
  registers: [registry],
});

export const ariConnected = new Gauge({
  name: "connect_ari_connected",
  help: "1 if ARI REST endpoint is reachable, 0 otherwise",
  registers: [registry],
});

// ── Call state ───────────────────────────────────────────────────────────────

export const activeCalls = new Gauge({
  name: "connect_active_calls",
  help: "Number of currently active calls (ringing + dialing + up + held)",
  registers: [registry],
});

export const activeCallsByDirection = new Gauge({
  name: "connect_active_calls_by_direction",
  help: "Active calls broken down by direction",
  labelNames: ["direction"] as const,
  registers: [registry],
});

export const callsTotal = new Counter({
  name: "connect_calls_total",
  help: "Total calls that completed (reached hungup state)",
  labelNames: ["direction", "disposition"] as const,
  registers: [registry],
});

export const callDurationSeconds = new Histogram({
  name: "connect_call_duration_seconds",
  help: "Duration of completed calls in seconds",
  labelNames: ["direction"] as const,
  buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

export const callTalkSeconds = new Histogram({
  name: "connect_call_talk_seconds",
  help: "Talk time (answer → end) of answered calls in seconds",
  labelNames: ["direction"] as const,
  buckets: [5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

// ── Extension / queue state ──────────────────────────────────────────────────

export const activeExtensions = new Gauge({
  name: "connect_active_extensions",
  help: "Number of extensions currently tracked",
  registers: [registry],
});

export const activeQueues = new Gauge({
  name: "connect_active_queues",
  help: "Number of queues currently tracked",
  registers: [registry],
});

// ── CDR pipeline ─────────────────────────────────────────────────────────────

export const cdrPostsTotal = new Counter({
  name: "connect_cdr_posts_total",
  help: "Total CDR POST attempts to the API",
  labelNames: ["status"] as const, // "ok" | "error" | "timeout" | "skipped"
  registers: [registry],
});

// ── WebSocket clients ────────────────────────────────────────────────────────

export const wsClients = new Gauge({
  name: "connect_ws_clients",
  help: "Number of active WebSocket clients connected to the telephony socket server",
  registers: [registry],
});

// ── Zombie / stale call tracking ─────────────────────────────────────────────

export const zombieCallsDetectedTotal = new Counter({
  name: "connect_zombie_calls_detected_total",
  help: "Total zombie/stale calls detected by the watchdog",
  labelNames: ["category"] as const, // stale_ringing | stale_up | orphan_no_channel
  registers: [registry],
});

export const zombieCallsAutoClearedTotal = new Counter({
  name: "connect_zombie_calls_auto_cleared_total",
  help: "Zombie calls that were successfully force-evicted and hung up",
  registers: [registry],
});

export const zombieCallCleanupFailuresTotal = new Counter({
  name: "connect_zombie_call_cleanup_failures_total",
  help: "Zombie call cleanup attempts that failed (AMI hangup error)",
  registers: [registry],
});

export const staleCallsActive = new Gauge({
  name: "connect_stale_calls_active",
  help: "Current number of calls flagged as stale/zombie by the watchdog",
  registers: [registry],
});

// ── Scrape helper ────────────────────────────────────────────────────────────

/** Render Prometheus text format for /metrics. */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

export const CONTENT_TYPE = registry.contentType;
