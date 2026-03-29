import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { TelephonySocketServer, WsClient } from "./TelephonySocketServer";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "../services/HealthService";
import type { AriBridgedActivePoller } from "../ari/AriBridgedActivePoller";
import { normalizeCallForClient } from "../normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../normalizers/normalizeQueueEvent";
import type { NormalizedExtensionState, NormalizedQueueState } from "../types";

const log = childLogger("TelephonyBroadcaster");

// Live calls: AriBridgedActivePoller @ 1 Hz (no per-AMI callUpsert fanout).
// Extensions/queues: debounced AMI-driven upserts.

export class TelephonyBroadcaster {
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private snapshotTimer: NodeJS.Timeout | null = null;
  private prevBridgeCallIds = new Set<string>();

  constructor(
    private readonly socket: TelephonySocketServer,
    private readonly bridgePoller: AriBridgedActivePoller,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
  ) {
    this.bridgePoller.on("update", () => this.syncBridgedCallsToWs());
    this.bindStores();
    this.startSnapshotTimer();
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    for (const t of this.debounceMap.values()) clearTimeout(t);
    this.debounceMap.clear();
    this.bridgePoller.removeAllListeners("update");
  }

  private bindStores(): void {
    this.extensions.on("extensionUpsert", (ext: NormalizedExtensionState) => {
      this.socket.broadcast(
        "telephony.extension.upsert",
        normalizeExtensionForClient(ext),
        tenantFilter(ext.tenantId),
      );
    });

    this.queues.on("queueUpsert", (queue: NormalizedQueueState) => {
      this.socket.broadcast(
        "telephony.queue.upsert",
        normalizeQueueForClient(queue),
        tenantFilter(queue.tenantId),
      );
    });
  }

  private syncBridgedCallsToWs(): void {
    const calls = this.bridgePoller.getCallsForSnapshot();
    const nextIds = new Set(calls.map((c) => c.id));

    for (const id of this.prevBridgeCallIds) {
      if (!nextIds.has(id)) {
        this.socket.broadcast("telephony.call.remove", { callId: id }, undefined);
      }
    }

    for (const call of calls) {
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug(
          { callId: call.id, wsClients: this.socket.clientCount() },
          "live_call: websocket_bridge_upsert",
        );
      }
      this.socket.broadcast(
        "telephony.call.upsert",
        normalizeCallForClient(call),
        tenantFilter(call.tenantId),
      );
    }

    this.prevBridgeCallIds = nextIds;
  }

  private startSnapshotTimer(): void {
    this.snapshotTimer = setInterval(() => {
      if (this.socket.clientCount() === 0) return;
      this.socket.broadcast("telephony.health", this.health.getHealth());
      log.trace(
        { clients: this.socket.clientCount(), bridgeActive: this.bridgePoller.getActiveCallCount() },
        "Health broadcast",
      );
    }, env.TELEPHONY_SNAPSHOT_INTERVAL_MS);

    if (this.snapshotTimer.unref) this.snapshotTimer.unref();
  }
}

function tenantFilter(
  tenantId: string | null,
): ((client: WsClient) => boolean) | undefined {
  if (tenantId === null) return undefined;
  return (client) => client.tenantId === null || client.tenantId === tenantId;
}
