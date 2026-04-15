// Telephony module barrel — instantiates and wires all sub-systems.
// Import this once at startup and call start() / stop().

import http from "http";
import { env } from "../config/env";
import { childLogger } from "../logging/logger";
import { AmiClient } from "./ami/AmiClient";
import { AriClient } from "./ari/AriClient";
import { AriActions } from "./ari/AriActions";
import { CallStateStore } from "./state/CallStateStore";
import { ExtensionStateStore } from "./state/ExtensionStateStore";
import { QueueStateStore } from "./state/QueueStateStore";
import { TelephonyService } from "./services/TelephonyService";
import { HealthService } from "./services/HealthService";
import { SnapshotService } from "./services/SnapshotService";
import { TelephonySocketServer } from "./websocket/TelephonySocketServer";
import { TelephonyBroadcaster } from "./websocket/TelephonyBroadcaster";
import { CdrNotifier } from "./services/CdrNotifier";
import { MobilePushNotifier } from "./services/MobilePushNotifier";
import { AriBridgedActivePoller } from "./ari/AriBridgedActivePoller";
import { PbxTenantMapCache, derivePbxTenantMapUrl } from "./state/PbxTenantMapCache";
import { HealingEngine } from "./services/HealingEngine";
import * as metrics from "../metrics";

export type TelephonyModule = ReturnType<typeof createTelephonyModule>;

const log = childLogger("Telephony");

export function createTelephonyModule(server: http.Server) {
  const ami = new AmiClient({
    host: env.PBX_HOST,
    port: env.AMI_PORT,
    username: env.AMI_USERNAME,
    password: env.AMI_PASSWORD,
    debugFrames: env.ENABLE_TELEPHONY_DEBUG,
  });

  const ari = new AriClient({
    baseUrl: env.ARI_BASE_URL,
    username: env.ARI_USERNAME,
    password: env.ARI_PASSWORD,
    appName: env.ARI_APP_NAME,
  });

  const callStore = new CallStateStore();
  const extStore = new ExtensionStateStore();
  const queueStore = new QueueStateStore();

  const mapUrl =
    env.TELEPHONY_PBX_MAP_URL ||
    (env.CDR_INGEST_URL ? derivePbxTenantMapUrl(env.CDR_INGEST_URL) : undefined);
  const pbxMapCache = new PbxTenantMapCache(mapUrl, env.CDR_INGEST_SECRET, 60_000);
  pbxMapCache.start();

  const telephonyService = new TelephonyService(ami, ari, callStore, extStore, queueStore, {
    pbxTenantMapCache: pbxMapCache,
  });
  const ariBridgedPoller = new AriBridgedActivePoller(ari, telephonyService.getResolver());
  const healthService = new HealthService(ami, ari, callStore, extStore, queueStore, ariBridgedPoller);

  // CDR notifier: listens for completed calls and POSTs to the API for DB persistence.
  const cdrNotifier = new CdrNotifier();
  // Mobile push notifier: fires an Expo push when an inbound call rings at an extension.
  const mobilePushNotifier = new MobilePushNotifier();
  callStore.on("callUpsert", (call) => {
    // Mobile push must run on every upsert so it can retry once the extension is resolved.
    mobilePushNotifier.notify(call);
    // ── Metrics: active call gauge ─────────────────────────────────────────
    const ACTIVE_STATES = new Set(["ringing", "dialing", "up", "held"]);
    const allCalls = callStore.getActive();
    metrics.activeCalls.set(allCalls.length);
    const byCounts = { inbound: 0, outbound: 0, internal: 0, unknown: 0 };
    for (const c of allCalls) {
      const d = c.direction as keyof typeof byCounts;
      if (d in byCounts) byCounts[d]++;
      else byCounts.unknown++;
    }
    for (const [dir, count] of Object.entries(byCounts)) {
      metrics.activeCallsByDirection.labels(dir).set(count);
    }

    // ── Metrics: completed call counters ───────────────────────────────────
    if (call.state === "hungup") {
      cdrNotifier.notify(call);
      // Count completed calls — direction resolved by CDR notifier; use raw here
      const dir = call.direction ?? "unknown";
      const disp = call.answeredAt ? "answered" : "missed";
      metrics.callsTotal.labels(dir, disp).inc();
      metrics.callDurationSeconds.labels(dir).observe(call.durationSec ?? 0);
      if (call.answeredAt && call.endedAt) {
        const talkSec = Math.max(0,
          (new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000);
        metrics.callTalkSeconds.labels(dir).observe(talkSec);
      }
    }
  });
  const snapshotService = new SnapshotService(callStore, extStore, queueStore, healthService);
  const socketServer = new TelephonySocketServer(server, snapshotService);
  const broadcaster = new TelephonyBroadcaster(
    socketServer,
    callStore,
    extStore,
    queueStore,
    healthService,
  );
  const ariActions = new AriActions(ari);
  const healingEngine = new HealingEngine(callStore, extStore, healthService, ami, ari);

  // ── Periodic metrics refresh (every 5 s) ─────────────────────────────────
  let _metricsInterval: ReturnType<typeof setInterval> | null = null;

  function refreshMetrics() {
    const health = healthService.getHealth();
    metrics.amiConnected.set(health.ami.connected ? 1 : 0);
    metrics.ariConnected.set(health.ari.restHealthy ? 1 : 0);
    metrics.activeExtensions.set(health.activeExtensions);
    metrics.activeQueues.set(health.activeQueues);
    // Active calls also refreshed here as a safety net
    const allCalls = callStore.getActive();
    metrics.activeCalls.set(allCalls.length);
  }

  function start() {
    log.info("Starting telephony module");
    ami.start();
    ari.start();
    ariBridgedPoller.start();
    healingEngine.start();
    // Run stale ghost cleanup every 60 s so zombies are evicted even when no new WS clients connect
    callStore.startPeriodicStaleCleanup(60_000);
    _metricsInterval = setInterval(refreshMetrics, 5_000);
  }

  function stop() {
    log.info("Stopping telephony module");
    if (_metricsInterval) { clearInterval(_metricsInterval); _metricsInterval = null; }
    callStore.stopPeriodicStaleCleanup();
    healingEngine.stop();
    pbxMapCache.stop();
    broadcaster.stop();
    ariBridgedPoller.stop();
    socketServer.close();
    ami.stop();
    ari.stop();
  }

  return {
    ami,
    ari,
    ariBridgedPoller,
    ariActions,
    telephonyService,
    healthService,
    snapshotService,
    socketServer,
    broadcaster,
    callStore,
    extStore,
    queueStore,
    healingEngine,
    start,
    stop,
  };
}
