import { EventEmitter } from "events";
import type { NormalizedExtensionState, ExtensionStatus } from "../types";

export declare interface ExtensionStateStore {
  on(event: "extensionUpsert", listener: (ext: NormalizedExtensionState) => void): this;
}

export class ExtensionStateStore extends EventEmitter {
  private extensions = new Map<string, NormalizedExtensionState>();

  getAll(): NormalizedExtensionState[] {
    return [...this.extensions.values()];
  }

  getByExtension(ext: string): NormalizedExtensionState | undefined {
    return this.extensions.get(ext);
  }

  // Called on ExtensionStatus AMI event
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
    this.extensions.set(params.exten, state);
    this.emit("extensionUpsert", { ...state });
  }

  // Called on PeerStatus / ContactStatus (registration status)
  onPeerStatus(params: {
    peer: string;
    peerStatus: string;
    tenantId: string | null;
  }): void {
    const ext = extractPeer(params.peer);
    if (!ext) return;

    const existing = this.extensions.get(ext);
    const status = peerStatusToExtStatus(params.peerStatus);

    const state: NormalizedExtensionState = {
      extension: ext,
      hint: existing?.hint ?? "",
      status: existing && status === "unavailable" ? status : (existing?.status ?? status),
      tenantId: params.tenantId ?? existing?.tenantId ?? null,
      updatedAt: new Date().toISOString(),
    };

    // Unregistered peer overrides any current status
    if (params.peerStatus === "Unregistered" || params.peerStatus === "Unreachable") {
      state.status = "unavailable";
    }

    this.extensions.set(ext, state);
    this.emit("extensionUpsert", { ...state });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function amiStatusToExtStatus(status: string, statusText: string): ExtensionStatus {
  const n = parseInt(status, 10);
  if (isNaN(n)) return statusTextToExtStatus(statusText);
  // Asterisk ExtensionStatus numeric codes
  switch (n) {
    case -2: return "unavailable";
    case -1: return "unavailable";
    case 0: return "idle";
    case 1: return "inuse";
    case 2: return "busy";
    case 4: return "unavailable";
    case 8: return "ringing";
    case 9: return "ringing"; // ringing + inuse
    case 16: return "onhold";
    case 17: return "onhold"; // onhold + inuse
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
  // Peer format: "PJSIP/1001" or "SIP/1001"
  const m = /(?:PJSIP|SIP|IAX2?)\/(.+)/.exec(peer);
  return m ? (m[1] ?? null) : null;
}
