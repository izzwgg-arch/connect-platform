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

/** Alias-aware tenant matcher. Returns true when `recordTenantId` should be
 *  visible to a viewer scoped to `viewerTenantId`. Used to bridge the CUID vs
 *  `vpbx:<slug>` namespace gap for live calls/extensions that were tagged via
 *  CDR context before the slug→CUID map was warm.
 */
export type TenantAliasMatcher = (
  recordTenantId: string | null | undefined,
  viewerTenantId: string,
) => boolean;

export type ViewerCallScope = {
  tenantId?: string | null;
  extensions?: string[];
  extensionScoped?: boolean;
};

export class SnapshotService {
  constructor(
    private readonly calls: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    private readonly health: HealthService,
    private readonly tenantAliasMatcher: TenantAliasMatcher | null = null,
  ) {}

  // Returns a point-in-time snapshot suitable for sending to a new WS client.
  getSnapshot(scopeOrTenantId?: string | null | ViewerCallScope): TelephonySnapshot {
    this.calls.runStaleCleanup();
    const scope: ViewerCallScope =
      typeof scopeOrTenantId === "object" && scopeOrTenantId !== null
        ? scopeOrTenantId
        : { tenantId: scopeOrTenantId };
    const tenantId = scope.tenantId ?? null;
    const extensionScoped = scope.extensionScoped === true;
    const viewerExtensions = new Set((scope.extensions ?? []).map((ext) => String(ext).trim()).filter(Boolean));

    // Use AMI-tracked active calls for live call list (DID-based tenant resolution).
    const allActive = this.calls.getActive().filter(
      (c) => !isLocalOnlyCall(c) && hasValidChannel(c),
    );
    let calls = allActive;
    let exts = this.extensions.getAll();
    let qs = this.queues.getAll();

    // Tenant filter (ID-based) with alias-aware fallback so a viewer scoped to
    // a Connect CUID still sees records tagged with an equivalent
    // `vpbx:<slug>` alias (and vice-versa). Admins (tenantId === null) bypass
    // filtering entirely.
    if (tenantId !== undefined && tenantId !== null) {
      const matches = (recordTid: string | null | undefined): boolean => {
        if (recordTid === tenantId) return true;
        if (this.tenantAliasMatcher) return this.tenantAliasMatcher(recordTid, tenantId);
        return false;
      };
      calls = calls.filter((c) => matches(c.tenantId));
      exts = exts.filter((e) => matches(e.tenantId));
      qs = qs.filter((q) => matches(q.tenantId));
    }

    if (extensionScoped) {
      calls = viewerExtensions.size === 0
        ? []
        : calls.filter((c) => c.extensions.some((ext) => viewerExtensions.has(ext)));
    }

    log.info(
      {
        forTenantId: tenantId ?? "GLOBAL",
        extensionScoped,
        viewerExtensions: [...viewerExtensions],
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
