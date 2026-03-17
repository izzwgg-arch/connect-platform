// Mirror of the telephony service's normalized types.
// These are the shapes sent over the /ws/telephony WebSocket.

export type CallDirection = "inbound" | "outbound" | "internal" | "unknown";
export type CallState = "ringing" | "dialing" | "up" | "held" | "hungup" | "unknown";
export type ExtensionStatus = "idle" | "inuse" | "busy" | "unavailable" | "ringing" | "onhold" | "unknown";
export type QueueMemberStatus = "idle" | "inuse" | "busy" | "unavailable" | "ringing" | "onhold" | "paused" | "unknown";

export interface LiveCall {
  id: string;
  linkedId: string;
  tenantId: string | null;
  direction: CallDirection;
  state: CallState;
  from: string | null;
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

export interface LiveExtensionState {
  extension: string;
  hint: string;
  status: ExtensionStatus;
  tenantId: string | null;
  updatedAt: string;
}

export interface LiveQueueMember {
  name: string;
  interface: string;
  status: QueueMemberStatus;
  paused: boolean;
  callsTaken: number;
  lastCall: number;
}

export interface LiveQueueState {
  queueName: string;
  tenantId: string | null;
  callerCount: number;
  memberCount: number;
  members: LiveQueueMember[];
  updatedAt: string;
}

export interface TelephonyConnectionHealth {
  connected: boolean;
  lastEventAt: string | null;
  reconnectCount: number;
  lastError: string | null;
}

export interface TelephonyAriHealth {
  restHealthy: boolean;
  /** Always false — res_ari_websockets.so is not available on this PBX build */
  webSocketSupported: false;
  lastCheckAt: string | null;
  lastError: string | null;
}

export interface TelephonyHealth {
  status: "ok" | "degraded" | "down";
  ami: TelephonyConnectionHealth;
  ari: TelephonyAriHealth;
  activeCalls: number;
  activeExtensions: number;
  activeQueues: number;
  uptimeSec: number;
  pbxHost: string;
}

export interface TelephonySnapshot {
  calls: LiveCall[];
  extensions: LiveExtensionState[];
  queues: LiveQueueState[];
  health: TelephonyHealth;
}

export interface TelephonyEventEnvelope<T = unknown> {
  event: string;
  ts: string;
  data: T;
}
