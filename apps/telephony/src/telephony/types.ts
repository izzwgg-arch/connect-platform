// ─── Core call model ──────────────────────────────────────────────────────────

export type CallDirection = "inbound" | "outbound" | "internal" | "unknown";
export type CallState = "ringing" | "dialing" | "up" | "held" | "hungup" | "unknown";

export interface NormalizedCall {
  id: string;
  linkedId: string;
  tenantId: string | null;
  /** Human-readable Connect tenant name; populated when resolved via Ombutel DID cache. */
  tenantName: string | null;
  direction: CallDirection;
  state: CallState;
  from: string | null;
  /** Caller name (CNAM) from AMI CallerIDName. Null when unavailable or generic. */
  fromName: string | null;
  to: string | null;
  connectedLine: string | null;
  channels: string[];
  bridgeIds: string[];
  extensions: string[];
  queueId: string | null;
  trunk: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  billableSec: number;
  metadata: Record<string, unknown>;
}

// ─── Extension / device presence ─────────────────────────────────────────────

export type ExtensionStatus =
  | "idle"
  | "inuse"
  | "busy"
  | "unavailable"
  | "ringing"
  | "onhold"
  | "unknown";

export interface NormalizedExtensionState {
  extension: string;
  hint: string;
  status: ExtensionStatus;
  tenantId: string | null;
  updatedAt: string;
}

// ─── Queue state ──────────────────────────────────────────────────────────────

export type QueueMemberStatus =
  | "idle"
  | "inuse"
  | "busy"
  | "unavailable"
  | "ringing"
  | "onhold"
  | "paused"
  | "unknown";

export interface QueueMember {
  name: string;
  interface: string;
  status: QueueMemberStatus;
  paused: boolean;
  callsTaken: number;
  lastCall: number;
}

export interface NormalizedQueueState {
  queueName: string;
  tenantId: string | null;
  callerCount: number;
  memberCount: number;
  members: QueueMember[];
  updatedAt: string;
}

// ─── Health ───────────────────────────────────────────────────────────────────

export interface ConnectionHealth {
  connected: boolean;
  lastEventAt: string | null;
  reconnectCount: number;
  lastError: string | null;
}

export interface AriHealth {
  /** True when the most recent ARI REST probe succeeded. */
  restHealthy: boolean;
  /** Always false — res_ari_websockets.so is not available on this PBX build. */
  webSocketSupported: false;
  lastCheckAt: string | null;
  lastError: string | null;
}

export interface TelephonyHealth {
  status: "ok" | "degraded" | "down";
  ami: ConnectionHealth;
  ari: AriHealth;
  activeCalls: number;
  activeExtensions: number;
  activeQueues: number;
  uptimeSec: number;
  pbxHost: string;
}

// ─── WebSocket envelope ───────────────────────────────────────────────────────

export interface TelephonyEventEnvelope<T = unknown> {
  event: string;
  ts: string;
  data: T;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export interface TelephonySnapshot {
  calls: NormalizedCall[];
  extensions: NormalizedExtensionState[];
  queues: NormalizedQueueState[];
  health: TelephonyHealth;
}
