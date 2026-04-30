import { EventEmitter } from "events";
import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { NormalizedExtensionState, ExtensionStatus } from "../types";
import { normalizeExtensionFromChannel } from "../normalizers/normalizeExtension";

const log = childLogger("ExtensionStateStore");
const UNREACHABLE_OFFLINE_GRACE_MS = 60_000;

export declare interface ExtensionStateStore {
  on(event: "extensionUpsert", listener: (ext: NormalizedExtensionState) => void): this;
}

// Key extensions by (tenantId ?? "__none__"):extension so that two different
// tenants that happen to use the same extension number (e.g. both have "106")
// do NOT overwrite each other's presence. Without this, a call on Tenant B's
// 106 would flip Tenant A's 106 to "On Call" in BLF/Team Directory.
function keyFor(tenantId: string | null | undefined, ext: string): string {
  return `${tenantId ?? "__none__"}:${ext}`;
}

export class ExtensionStateStore extends EventEmitter {
  private extensions = new Map<string, NormalizedExtensionState>();
  private unreachableTimers = new Map<string, NodeJS.Timeout>();

  getAll(): NormalizedExtensionState[] {
    return [...this.extensions.values()];
  }

  /** Deprecated: returns the first match regardless of tenant. Prefer getByTenantExtension. */
  getByExtension(ext: string): NormalizedExtensionState | undefined {
    for (const v of this.extensions.values()) {
      if (v.extension === ext) return v;
    }
    return undefined;
  }

  getByTenantExtension(tenantId: string | null, ext: string): NormalizedExtensionState | undefined {
    return this.extensions.get(keyFor(tenantId, ext));
  }

  getAllForTenant(tenantId: string | null): NormalizedExtensionState[] {
    return this.getAll().filter((e) => e.tenantId === tenantId);
  }

  onExtensionStatus(params: {
    exten: string;
    context: string;
    hint: string;
    status: string;
    statusText: string;
    tenantId: string | null;
  }): void {
    const key = keyFor(params.tenantId, params.exten);
    this.clearUnreachableTimer(key);
    const prev = this.extensions.get(key);
    const state: NormalizedExtensionState = {
      extension: params.exten,
      hint: params.hint,
      status: amiStatusToExtStatus(params.status, params.statusText),
      tenantId: params.tenantId,
      updatedAt: new Date().toISOString(),
    };
    this.debugTransition("ExtensionStatus", key, prev, state, { rawStatus: params.status, statusText: params.statusText });
    this.extensions.set(key, state);
    this.emit("extensionUpsert", { ...state });
  }

  onPeerStatus(params: {
    peer: string;
    peerStatus: string;
    tenantId: string | null;
  }): void {
    const ext = extractPeer(params.peer);
    if (!ext) return;

    const key = keyFor(params.tenantId, ext);
    const existing = this.extensions.get(key);
    const status = peerStatusToExtStatus(params.peerStatus);

    if (params.peerStatus === "Unreachable") {
      this.scheduleUnreachableOffline(key, ext, params.tenantId, existing);
      return;
    }

    this.clearUnreachableTimer(key);

    const state: NormalizedExtensionState = {
      extension: ext,
      hint: existing?.hint ?? "",
      status: status === "unknown" ? (existing?.status ?? "unknown") : status,
      tenantId: params.tenantId ?? existing?.tenantId ?? null,
      updatedAt: new Date().toISOString(),
    };

    if (params.peerStatus === "Unregistered") {
      state.status = "unavailable";
    }

    this.debugTransition("PeerStatus", key, existing, state, { peerStatus: params.peerStatus });
    this.extensions.set(key, state);
    this.emit("extensionUpsert", { ...state });
  }

  onDeviceStateChange(params: {
    device: string;
    state: string;
    tenantId: string | null;
  }): void {
    const ext = extractPeer(params.device);
    if (!ext) return;
    const key = keyFor(params.tenantId, ext);
    const existing = this.extensions.get(key);
    const status = deviceStateToExtStatus(params.state);
    if (status === "unavailable") {
      this.scheduleUnreachableOffline(key, ext, params.tenantId, existing);
      return;
    }
    this.clearUnreachableTimer(key);
    const state: NormalizedExtensionState = {
      extension: ext,
      hint: existing?.hint ?? params.device,
      status: status === "unknown" ? (existing?.status ?? "unknown") : status,
      tenantId: params.tenantId ?? existing?.tenantId ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.debugTransition("DeviceStateChange", key, existing, state, { device: params.device, deviceState: params.state });
    this.extensions.set(key, state);
    this.emit("extensionUpsert", { ...state });
  }

  private scheduleUnreachableOffline(
    key: string,
    ext: string,
    tenantId: string | null,
    existing: NormalizedExtensionState | undefined,
  ): void {
    if (!existing) {
      const state: NormalizedExtensionState = {
        extension: ext,
        hint: "",
        status: "unavailable",
        tenantId,
        updatedAt: new Date().toISOString(),
      };
      this.debugTransition("PeerStatus", key, existing, state, { peerStatus: "Unreachable", reason: "no_existing_state" });
      this.extensions.set(key, state);
      this.emit("extensionUpsert", { ...state });
      return;
    }

    if (this.unreachableTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.unreachableTimers.delete(key);
      const current = this.extensions.get(key);
      if (!current || current.status === "unavailable") return;
      const next: NormalizedExtensionState = {
        ...current,
        status: "unavailable",
        updatedAt: new Date().toISOString(),
      };
      this.debugTransition("PeerStatus", key, current, next, { peerStatus: "Unreachable", reason: "grace_expired" });
      this.extensions.set(key, next);
      this.emit("extensionUpsert", { ...next });
    }, UNREACHABLE_OFFLINE_GRACE_MS);
    if (timer.unref) timer.unref();
    this.unreachableTimers.set(key, timer);
    this.debugTransition("PeerStatus", key, existing, existing, { peerStatus: "Unreachable", reason: "grace_started" });
  }

  private clearUnreachableTimer(key: string): void {
    const timer = this.unreachableTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.unreachableTimers.delete(key);
  }

  private debugTransition(
    source: string,
    key: string,
    prev: NormalizedExtensionState | undefined,
    next: NormalizedExtensionState,
    extra: Record<string, unknown>,
  ): void {
    if (!env.ENABLE_BLF_DEBUG) return;
    log.info(
      {
        source,
        key,
        extension: next.extension,
        tenantId: next.tenantId,
        previous: prev?.status ?? null,
        next: next.status,
        ...extra,
      },
      "blf: extension_state_transition",
    );
  }
}

function amiStatusToExtStatus(status: string, statusText: string): ExtensionStatus {
  const n = parseInt(status, 10);
  if (isNaN(n)) return statusTextToExtStatus(statusText);
  switch (n) {
    case -2: return "unavailable";
    case -1: return "unavailable";
    case 0: return "idle";
    case 1: return "inuse";
    case 2: return "busy";
    case 4: return "unavailable";
    case 8: return "ringing";
    case 9: return "ringing";
    case 16: return "onhold";
    case 17: return "onhold";
    default: return "unknown";
  }
}

function statusTextToExtStatus(text: string): ExtensionStatus {
  const t = text.toLowerCase();
  if (t.includes("idle")) return "idle";
  if (t.includes("inuse") || t.includes("in use")) return "inuse";
  if (t.includes("busy")) return "busy";
  if (t.includes("ring")) return "ringing";
  if (t.includes("hold")) return "onhold";
  if (t.includes("unavail")) return "unavailable";
  return "unknown";
}

function peerStatusToExtStatus(peerStatus: string): ExtensionStatus {
  switch (peerStatus) {
    case "Registered": return "idle";
    case "Unregistered":
    case "Unreachable": return "unavailable";
    case "Reachable": return "idle";
    default: return "unknown";
  }
}

function deviceStateToExtStatus(state: string): ExtensionStatus {
  const s = String(state || "").trim().toUpperCase();
  switch (s) {
    case "NOT_INUSE":
      return "idle";
    case "INUSE":
      return "inuse";
    case "BUSY":
      return "busy";
    case "RINGING":
    case "RINGINUSE":
      return "ringing";
    case "ONHOLD":
      return "onhold";
    case "UNAVAILABLE":
    case "UNKNOWN":
    case "INVALID":
      return "unavailable";
    default:
      return statusTextToExtStatus(state);
  }
}

function extractPeer(peer: string): string | null {
  return normalizeExtensionFromChannel(peer);
}
