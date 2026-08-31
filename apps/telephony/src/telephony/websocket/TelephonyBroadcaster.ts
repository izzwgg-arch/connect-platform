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
import type { CrmInboundCallerEnricher } from "../services/CrmInboundCallerEnricher";
import type { NormalizedCall, NormalizedExtensionState, NormalizedQueueState } from "../types";

const log = childLogger("TelephonyBroadcaster");

// Live calls: AMI CallStateStore events (real-time, DID-based tenant resolution).
// Extensions/queues: debounced AMI-driven upserts.

export class TelephonyBroadcaster {
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  // ── Per-call message ordering (2026-08-31) ────────────────────────────────
  // `call.remove` is broadcast synchronously but `call.upsert` can ride an
  // async CRM-enrichment promise (up to 2.5s) — so a stale upsert could be
  // DELIVERED after the hangup's remove and resurrect the dead call on every
  // client until the next sweep ("hung up but stayed on screen for a minute").
  // Every message for a call now carries a monotonically increasing `seq`,
  // assigned SYNCHRONOUSLY at emit time; clients drop any call message whose
  // seq is older than the last one they applied for that call.
  private callSeqs = new Map<string, { seq: number; touchedMs: number }>();

  /** Next per-call sequence number. MUST be called synchronously in the event
   *  handler (before any await) so seq order == emit order. */
  private nextCallSeq(callId: string): number {
    const seq = (this.callSeqs.get(callId)?.seq ?? 0) + 1;
    this.callSeqs.set(callId, { seq, touchedMs: Date.now() });
    return seq;
  }

  private sweepCallSeqs(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, entry] of this.callSeqs) {
      if (entry.touchedMs < cutoff) this.callSeqs.delete(id);
    }
  }

  constructor(
    private readonly socket: TelephonySocketServer,
    private readonly callStore: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
    private readonly tenantAliasMatcher: TenantAliasMatcher | null = null,
    private readonly crmEnricher: CrmInboundCallerEnricher | null = null,
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
      // seq is assigned HERE, synchronously, even though the enriched send may
      // complete later — that is the whole ordering contract.
      const seq = this.nextCallSeq(call.id);
      // When a call transitions to "hungup" immediately send callRemove so the
      // frontend clears it in real-time.  Without this, the frontend map retains
      // the call until the 60-second stale cleanup fires, leaving the extension
      // stuck in "On Call" status for up to a minute after the call ends.
      if (call.state === "hungup") {
        this.socket.broadcast("telephony.call.remove", { callId: call.id, seq }, undefined);
        return;
      }

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
          totalWsClients: clientCount,
          matchingWsClients: matchingClients,
          extensions: call.extensions,
        },
        "PIPE[4/6]: broadcasting callUpsert to WS clients",
      );

      void this.broadcastCallUpsert(call, filter, seq);
    });

    this.callStore.on("callRemove", (callId: string) => {
      // Broadcast remove to ALL clients (global + tenant-scoped) so everyone clears the row.
      this.socket.broadcast(
        "telephony.call.remove",
        { callId, seq: this.nextCallSeq(callId) },
        undefined,
      );
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
      this.sweepCallSeqs();
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

  private broadcastCallUpsert(
    call: NormalizedCall,
    filter: ((client: WsClient) => boolean) | undefined,
    seq: number,
  ): void {
    if (!this.crmEnricher?.enabled()) {
      this.socket.broadcast(
        "telephony.call.upsert",
        { ...normalizeCallForClient(call), seq },
        filter,
      );
      return;
    }
    this.socket.forEachClient((client) => {
      void this.crmEnricher!.enrichForClient(call, client).then((enriched) => {
        // ⛔ Ordering guard (2026-08-31): the enrichment round-trip can finish
        // AFTER the call hung up and its synchronous `call.remove` already went
        // out. Delivering this upsert then would resurrect the dead call on
        // the client. Re-check the store at SEND time — hungup/gone ⇒ drop the
        // stale upsert (the remove is authoritative). The seq the client
        // receives is the one assigned at emit time, so even a survivor of
        // this check is dropped client-side if a newer message beat it.
        const current = this.callStore.getById(call.id);
        if (!current || current.state === "hungup") return;
        this.socket.sendToClient(
          client,
          "telephony.call.upsert",
          { ...normalizeCallForClient(enriched), seq },
        );
      });
    }, filter);
  }

  private buildCallFilter(call: NormalizedCall): ((client: WsClient) => boolean) | undefined {
    // Filter by tenant only — every connected user in the same tenant sees every
    // live call for that tenant.  Personal call history uses the REST endpoint with
    // its own extension-level filter; the real-time WS feed is tenant-wide.
    return this.buildTenantFilter(call.tenantId);
  }
}
