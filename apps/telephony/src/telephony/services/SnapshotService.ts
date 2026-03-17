import type { TelephonySnapshot } from "../types";
import type { CallStateStore } from "../state/CallStateStore";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "./HealthService";
import { normalizeCallForClient } from "../normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../normalizers/normalizeQueueEvent";

export class SnapshotService {
  constructor(
    private readonly calls: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
  ) {}

  // Returns a point-in-time snapshot suitable for sending to a new WS client.
  getSnapshot(tenantId?: string | null): TelephonySnapshot {
    let calls = this.calls.getActive();
    let exts = this.extensions.getAll();
    let qs = this.queues.getAll();

    if (tenantId !== undefined && tenantId !== null) {
      calls = calls.filter((c) => c.tenantId === null || c.tenantId === tenantId);
      exts = exts.filter((e) => e.tenantId === null || e.tenantId === tenantId);
      qs = qs.filter((q) => q.tenantId === null || q.tenantId === tenantId);
    }

    return {
      calls: calls.map(normalizeCallForClient),
      extensions: exts.map(normalizeExtensionForClient),
      queues: qs.map(normalizeQueueForClient),
      health: this.health.getHealth(),
    };
  }
}
