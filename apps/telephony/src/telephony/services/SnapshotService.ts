import type { NormalizedCall, TelephonySnapshot } from "../types";
import type { CallStateStore } from "../state/CallStateStore";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { HealthService } from "./HealthService";
import { normalizeCallForClient, isLocalOnlyCall, hasValidChannel } from "../normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../normalizers/normalizeQueueEvent";
import { normalizeExtensionFromChannel, looksLikeExtension } from "../normalizers/normalizeExtension";
import { childLogger } from "../../logging/logger";

const log = childLogger("SnapshotService");

function callInvolvesViewerExtension(call: NormalizedCall, viewerExtensions: Set<string>): boolean {
  const involved = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const raw = String(value).trim();
    if (!raw) return;
    if (looksLikeExtension(raw)) involved.add(raw);
    const normalized = normalizeExtensionFromChannel(raw);
    if (normalized) involved.add(normalized);
  };

  for (const ext of call.extensions) add(ext);
  add(call.source_extension);
  add(call.destination_extension);
  add(call.from);
  add(call.to);
  add(call.connectedLine);
  for (const channel of call.channels) add(channel);

  return [...involved].some((ext) => viewerExtensions.has(ext));
}

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
    private readonly activeCallProvider: (() => NormalizedCall[]) | null = null,
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

    // Use the ARI bridge snapshot when available. It is the PBX-correct source:
    // one active call equals one qualifying bridge, not one AMI channel/event.
    const activeSource = this.activeCallProvider?.() ?? this.calls.getActive();
    const allActive = activeSource.filter(
      (c) => !isLocalOnlyCall(c) && (c.bridgeIds.length > 0 || hasValidChannel(c)),
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
        : calls.filter((c) => callInvolvesViewerExtension(c, viewerExtensions));
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
