// ─── Core call model ──────────────────────────────────────────────────────────

export type CallDirection = "inbound" | "outbound" | "internal" | "unknown";
export type CallState = "ringing" | "dialing" | "up" | "held" | "hungup" | "unknown";

/** CRM inbound caller match — optional, permission-filtered per WS viewer. */
export type CrmInboundCallMatchSource = "exact" | "secondary" | "fallback_suffix";

export interface CrmInboundCallFields {
  crmContactId: string;
  crmContactName: string;
  crmCompanyName?: string;
  crmProfileUrl: string;
  crmMatchSource: CrmInboundCallMatchSource;
}

export interface NormalizedCall {
  id: string;
  linkedId: string;
  tenantId: string | null;
  /** Stable tenant slug for UI fallback labels when tenantName is unavailable. */
  tenantSlug: string | null;
  /** Human-readable Connect tenant name; populated when resolved via Ombutel DID cache. */
  tenantName: string | null;
  direction: CallDirection;
  state: CallState;
  from: string | null;
  /** Caller name (CNAM) from AMI CallerIDName. Null when unavailable or generic. */
  fromName: string | null;
  to: string | null;
  connectedLine: string | null;
  source_extension: string | null;
  destination_extension: string | null;
  channelState: string | null;
  channels: string[];
  bridgeIds: string[];
  extensions: string[];
  queueId: string | null;
  trunk: string | null;
  startedAt: string;
  /**
   * First moment ANY channel of the call reached the "up" state — including
   * the inbound trunk leg's IVR `Answer()` to play the greeting. Used for CDR
   * billing and "answered vs missed" classification.
   *
   * NOTE: This is NOT a reliable signal that the *called extension* actually
   * answered. For DID→IVR→ext routes the trunk leg goes "up" 5–30 seconds
   * before the dialed extension is even rung. If you need to know "is the
   * caller currently talking to my extension's endpoint?", use
   * {@link extensionAnsweredAt} instead.
   */
  answeredAt: string | null;
  /**
   * First moment a tenant-extension leg (`PJSIP/T<id>_<exten>...` — including
   * WebRTC `_<n>` suffix variants) reached the "up" state or joined a real
   * bridge. This is the truthful "the called extension answered" timestamp.
   *
   * Used by the mobile-wake answer pipeline's "already bridged" gate in
   * {@link TelephonyService.requeueLiveCallToDialplan} so an inbound IVR
   * call can still be redirected to ring the extension when the user taps
   * Answer in the cold-start mobile UI — the mobile cold-start path needs
   * this redirect because its SIP UA wasn't running when the original
   * Asterisk dial fired and so it never received the original SIP INVITE.
   *
   * Null until at least one extension leg actually answers; remains null
   * forever for missed calls / IVR-only journeys / voicemail-handled calls.
   */
  extensionAnsweredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  billableSec: number;
  metadata: Record<string, unknown>;
  /** Present only for inbound calls when API matched a CRM contact the viewer may access. */
  crmContactId?: string;
  crmContactName?: string;
  crmCompanyName?: string;
  crmProfileUrl?: string;
  crmMatchSource?: CrmInboundCallMatchSource;
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

export type PbxLinkState = "healthy" | "reconnecting" | "degraded" | "stale";

export interface ConnectionHealth {
  connected: boolean;
  lastEventAt: string | null;
  /**
   * Count of successful AMI reconnections after an outage (from internal backoff state).
   * Distinct from `reconnectAttempt` (current backoff generation).
   */
  reconnectCount: number;
  lastError: string | null;
  /** ISO timestamp of last AMI event *or* response frame (includes Ping/Pong). */
  lastTrafficAt: string | null;
  /** Current backoff generation; 0 while stably connected. */
  reconnectAttempt: number;
  lastDisconnectAt: string | null;
  connectedSince: string | null;
}

export interface AriHealth {
  /** True when the most recent ARI REST probe succeeded. */
  restHealthy: boolean;
  /** Always false — res_ari_websockets.so is not available on this PBX build. */
  webSocketSupported: false;
  lastCheckAt: string | null;
  lastError: string | null;
  /** Probes failed since last successful `/ari/asterisk/info` (resets on success). */
  consecutiveProbeFailures: number;
}

export interface TelephonyHealth {
  status: "ok" | "degraded" | "down";
  /** PBX link quality for operators (banner / ops); see `computePbxLinkState`. */
  pbxLinkState: PbxLinkState;
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
