import { EventEmitter } from "events";
import type { NormalizedExtensionState, ExtensionStatus } from "../types";
import { normalizeExtensionFromChannel } from "../normalizers/normalizeExtension";

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
    const state: NormalizedExtensionState = {
      extension: params.exten,
      hint: params.hint,
      status: amiStatusToExtStatus(params.status, params.statusText),
      tenantId: params.tenantId,
      updatedAt: new Date().toISOString(),
    };
    this.extensions.set(keyFor(params.tenantId, params.exten), state);
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

    const state: NormalizedExtensionState = {
      extension: ext,
      hint: existing?.hint ?? "",
      status: existing && status === "unavailable" ? status : (existing?.status ?? status),
      tenantId: params.tenantId ?? existing?.tenantId ?? null,
      updatedAt: new Date().toISOString(),
    };

    if (params.peerStatus === "Unregistered" || params.peerStatus === "Unreachable") {
      state.status = "unavailable";
    }

    this.extensions.set(key, state);
    this.emit("extensionUpsert", { ...state });
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

function extractPeer(peer: string): string | null {
  return normalizeExtensionFromChannel(peer);
}
