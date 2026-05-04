import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { TelephonySocketServer, WsClient } from "./TelephonySocketServer";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "../services/HealthService";
import type { CallStateStore } from "../state/CallStateStore";
import type { TenantAliasMatcher } from "../services/SnapshotService";
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
    private readonly tenantAliasMatcher: TenantAliasMatcher | null = null,
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

      const filter = this.buildCallFilter(call);
      const clientCount = this.socket.clientCount();
      const matchingClients = this.socket.countMatchingClients(filter);
      // Always log at info so we can trace every broadcast
      log.info(
        {
          callId: call.id,
          state: call.state,
          from: call.from,
          to: call.to,
          tenantId: call.tenantId,
          tenantName: call.tenantName,
          callExtensions: call.extensions,
          totalWsClients: clientCount,
          matchingWsClients: matchingClients,
        },
        "PIPE[4/6]: broadcasting callUpsert to WS clients",
      );

      this.socket.broadcast(
        "telephony.call.upsert",
        normalizeCallForClient(call),
        filter,
      );
    });

    this.callStore.on("callRemove", (callId: string) => {
      // Broadcast remove to ALL clients (global + tenant-scoped) so everyone clears the row.
      // Per-user extension scoping doesn't apply here: if the client never had
      // the call in their list, removing a non-existent id is a no-op.
      this.socket.broadcast("telephony.call.remove", { callId }, undefined);
    });
  }

  private bindStores(): void {
    this.extensions.on("extensionUpsert", (ext: NormalizedExtensionState) => {
      this.socket.broadcast(
        "telephony.extension.upsert",
        normalizeExtensionForClient(ext),
        this.buildTenantFilter(ext.tenantId),
      );
    });

    this.queues.on("queueUpsert", (queue: NormalizedQueueState) => {
      this.socket.broadcast(
        "telephony.queue.upsert",
        normalizeQueueForClient(queue),
        this.buildTenantFilter(queue.tenantId),
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

  /** Tenant-scoping filter for a single event. Admins (client.tenantId===null)
   *  always see everything. Tenant-scoped clients receive records that either
   *  match their tenant exactly OR alias to it via the configured matcher
   *  (covers CUID ↔ `vpbx:<slug>` namespace). Unknown-tenant records are
   *  delivered only to admins.
   */
  private buildTenantFilter(
    recordTenantId: string | null,
  ): ((client: WsClient) => boolean) | undefined {
    if (recordTenantId === null) return (client) => client.tenantId === null;
    const matcher = this.tenantAliasMatcher;
    return (client) => {
      if (client.tenantId === null) return true;
      if (client.tenantId === recordTenantId) return true;
      if (matcher) return matcher(recordTenantId, client.tenantId);
      return false;
    };
  }

  /** Live-call filter: tenant scope first, then per-user extension scope.
   *  • Admin / global clients (bypassExtensionFilter=true): tenant filter only.
   *  • Per-user clients with extensions: must also have at least one of their
   *    extensions appear in `call.extensions` (the source/dest extensions
   *    Asterisk derived for this call).
   *  • Per-user clients with NO extensions: never see live calls (their owned
   *    extensions list is empty, so there's nothing to match).
   *  This implements the spec's filterCallsForUser at the broadcast layer
   *  rather than the frontend, so users cannot snoop on each other's calls.
   */
  private buildCallFilter(
    call: NormalizedCall,
  ): ((client: WsClient) => boolean) | undefined {
    const tenantFilter = this.buildTenantFilter(call.tenantId);
    return (client: WsClient) => {
      if (tenantFilter && !tenantFilter(client)) return false;
      if (client.bypassExtensionFilter) return true;
      if (client.extensions.length === 0) return false;
      const callExts = call.extensions ?? [];
      if (callExts.length === 0) return false;
      for (const ext of client.extensions) {
        if (callExts.includes(ext)) return true;
      }
      return false;
    };
  }
}
