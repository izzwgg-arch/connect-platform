import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { TelephonySocketServer, WsClient } from "./TelephonySocketServer";
import type { CallStateStore } from "../state/CallStateStore";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "../services/HealthService";
import { normalizeCallForClient } from "../normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../normalizers/normalizeQueueEvent";
import type { NormalizedCall, NormalizedExtensionState, NormalizedQueueState } from "../types";

const log = childLogger("TelephonyBroadcaster");

// TelephonyBroadcaster subscribes to state-store events and pushes them
// to WebSocket clients, with optional debouncing to collapse rapid-fire updates.

export class TelephonyBroadcaster {
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private pendingCalls = new Map<string, NormalizedCall>();
  private pendingRemovals = new Set<string>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: TelephonySocketServer,
    private readonly calls: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
  ) {
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

  private bindStores(): void {
    this.calls.on("callUpsert", (call) => {
      this.debouncedCallUpsert(call);
    });

    this.calls.on("callRemove", (callId) => {
      // Cancel any pending upsert for this call
      const pending = this.debounceMap.get(`call:${callId}`);
      if (pending) {
        clearTimeout(pending);
        this.debounceMap.delete(`call:${callId}`);
      }
      this.pendingCalls.delete(callId);
      this.pendingRemovals.add(callId);
      this.scheduleFlushRemovals();
    });

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

  private debouncedCallUpsert(call: NormalizedCall): void {
    const key = `call:${call.id}`;
    this.pendingCalls.set(call.id, call);

    const existing = this.debounceMap.get(key);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
      this.debounceMap.delete(key);
      const latest = this.pendingCalls.get(call.id);
      if (!latest) return;
      this.pendingCalls.delete(call.id);
      this.socket.broadcast(
        "telephony.call.upsert",
        normalizeCallForClient(latest),
        tenantFilter(latest.tenantId),
      );
    }, env.TELEPHONY_EVENT_DEBOUNCE_MS);

    if (t.unref) t.unref();
    this.debounceMap.set(key, t);
  }

  private scheduleFlushRemovals(): void {
    const key = "flush:removals";
    const existing = this.debounceMap.get(key);
    if (existing) return;

    const t = setTimeout(() => {
      this.debounceMap.delete(key);
      for (const callId of this.pendingRemovals) {
        this.socket.broadcast("telephony.call.remove", { callId });
      }
      this.pendingRemovals.clear();
    }, env.TELEPHONY_EVENT_DEBOUNCE_MS);

    if (t.unref) t.unref();
    this.debounceMap.set(key, t);
  }

  private startSnapshotTimer(): void {
    this.snapshotTimer = setInterval(() => {
      if (this.socket.clientCount() === 0) return;
      this.socket.broadcast("telephony.health", this.health.getHealth());
      log.trace(
        { clients: this.socket.clientCount(), calls: this.calls.getActive().length },
        "Health broadcast",
      );
    }, env.TELEPHONY_SNAPSHOT_INTERVAL_MS);

    if (this.snapshotTimer.unref) this.snapshotTimer.unref();
  }
}

// Returns a filter predicate for tenant-scoped broadcasts.
// null tenantId = admin-visible (broadcast to everyone).
function tenantFilter(
  tenantId: string | null,
): ((client: WsClient) => boolean) | undefined {
  if (tenantId === null) return undefined;
  return (client) => client.tenantId === null || client.tenantId === tenantId;
}
