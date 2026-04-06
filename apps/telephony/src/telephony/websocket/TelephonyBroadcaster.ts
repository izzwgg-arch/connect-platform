import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { TelephonySocketServer, WsClient } from "./TelephonySocketServer";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "../services/HealthService";
import type { CallStateStore } from "../state/CallStateStore";
import { normalizeCallForClient } from "../normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../normalizers/normalizeQueueEvent";
import type { NormalizedCall, NormalizedExtensionState, NormalizedQueueState } from "../types";

const log = childLogger("TelephonyBroadcaster");

// Live calls: AMI CallStateStore events (real-time, DID-based tenant resolution).
// Extensions/queues: debounced AMI-driven upserts.

export class TelephonyBroadcaster {
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: TelephonySocketServer,
    private readonly callStore: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
  ) {
    this.bindCallStore();
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
  }

  private bindCallStore(): void {
    this.callStore.on("callUpsert", (call: NormalizedCall) => {
      // Only broadcast active (non-hungup) calls.
      if (call.state === "hungup") return;
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug(
          { callId: call.id, from: call.from, to: call.to, tenantId: call.tenantId, tenantName: call.tenantName },
          "live_call: ws_upsert",
        );
      }
      this.socket.broadcast(
        "telephony.call.upsert",
        normalizeCallForClient(call),
        tenantFilter(call.tenantId),
      );
    });

    this.callStore.on("callRemove", (callId: string) => {
      // Broadcast remove to ALL clients (global + tenant-scoped) so everyone clears the row.
      this.socket.broadcast("telephony.call.remove", { callId }, undefined);
    });
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

  private startSnapshotTimer(): void {
    this.snapshotTimer = setInterval(() => {
      if (this.socket.clientCount() === 0) return;
      this.socket.broadcast("telephony.health", this.health.getHealth());
      log.trace(
        { clients: this.socket.clientCount() },
        "Health broadcast",
      );
    }, env.TELEPHONY_SNAPSHOT_INTERVAL_MS);

    if (this.snapshotTimer.unref) this.snapshotTimer.unref();
  }
}

function tenantFilter(
  tenantId: string | null,
): ((client: WsClient) => boolean) | undefined {
  // Unknown tenant: only global admins (client.tenantId === null) should see it.
  if (tenantId === null) return (client) => client.tenantId === null;
  // Known tenant: global admins + clients scoped to that exact tenant.
  return (client) => client.tenantId === null || client.tenantId === tenantId;
}
