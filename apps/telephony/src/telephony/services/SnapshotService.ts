import type { TelephonySnapshot } from "../types";
import type { CallStateStore } from "../state/CallStateStore";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "./HealthService";
import { normalizeCallForClient, isLocalOnlyCall, hasValidChannel } from "../normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../normalizers/normalizeQueueEvent";
import { childLogger } from "../../logging/logger";

const log = childLogger("SnapshotService");

export class SnapshotService {
  constructor(
    private readonly calls: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
  ) {}

  // Returns a point-in-time snapshot suitable for sending to a new WS client.
  getSnapshot(tenantId?: string | null): TelephonySnapshot {
    this.calls.runStaleCleanup();

    // Use AMI-tracked active calls for live call list (DID-based tenant resolution).
    const allActive = this.calls.getActive().filter(
      (c) => !isLocalOnlyCall(c) && hasValidChannel(c),
    );
    let calls = allActive;
    let exts = this.extensions.getAll();
    let qs = this.queues.getAll();

    // Strict tenant filter when set (match portal callsByTenant: unresolved only in master)
    if (tenantId !== undefined && tenantId !== null) {
      calls = calls.filter((c) => c.tenantId === tenantId);
      exts = exts.filter((e) => e.tenantId === tenantId);
      qs = qs.filter((q) => q.tenantId === tenantId);
    }

    log.info(
      {
        forTenantId: tenantId ?? "GLOBAL",
        totalActiveCalls: allActive.length,
        callsInSnapshot: calls.length,
        droppedByTenantFilter: allActive.length - calls.length,
        callIds: calls.map((c) => c.id),
        droppedCallTenants: allActive.filter((c) => !calls.includes(c)).map((c) => ({ id: c.id, tenantId: c.tenantId })),
      },
      "PIPE[3/6]: snapshot built",
    );

    return {
      calls: calls.map(normalizeCallForClient),
      extensions: exts.map(normalizeExtensionForClient),
      queues: qs.map(normalizeQueueForClient),
      health: this.health.getHealth(),
    };
  }
}
