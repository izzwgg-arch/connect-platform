export type AuthResponse = {
  token: string;
  user?: { id: string; email: string; role: string };
};

export type VoiceExtension = {
  extensionId: string;
  pbxExtensionLinkId: string;
  extensionNumber: string;
  displayName: string;
  sipUsername: string;
  hasSipPassword: boolean;
  webrtcEnabled: boolean;
  sipWsUrl: string | null;
  sipDomain: string | null;
  outboundProxy: string | null;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode: "RFC2833" | "SIP_INFO";
};

export type ProvisioningBundle = {
  sipUsername: string;
  /** The username used in the SIP Authorization header (PJSIP auth object name).
   * In VitalPBX 4 this is the device name (e.g. "T2_103_1"), NOT the extension number.
   * Falls back to sipUsername when not set. */
  authUsername?: string | null;
  sipPassword: string;
  sipWsUrl: string;
  sipDomain: string;
  outboundProxy?: string | null;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode?: "RFC2833" | "SIP_INFO";
};

export type CallRecord = {
  id: string;
  linkedId?: string | null;
  direction: string; // "inbound" | "outbound" | "internal" | "unknown"
  fromNumber: string;
  fromName?: string | null;
  toNumber: string;
  startedAt: string;
  durationSec: number;
  disposition?: string; // "answered" | "missed" | "busy" | "failed" | "canceled" | "unknown"
};

export type CallInvite = {
  id: string;
  tenantId: string;
  userId: string;
  extensionId?: string | null;
  pbxCallId?: string | null;
  pbxSipUsername?: string | null;
  sipCallTarget?: string | null;
  fromDisplay?: string | null;
  fromNumber: string;
  toExtension: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CANCELED";
  createdAt: string;
  expiresAt: string;
};

export type InviteClaimedPushPayload = {
  type: "INVITE_CLAIMED";
  inviteId: string;
  tenantId: string;
  timestamp: string;
};

export type MissedCallPushPayload = {
  type: "MISSED_CALL";
  inviteId: string;
  fromNumber: string;
  fromDisplay?: string | null;
  toExtension: string;
  tenantId: string;
  timestamp: string;
};

export type InviteCanceledPushPayload = {
  type: "INVITE_CANCELED";
  inviteId: string;
  pbxCallId?: string | null;
  reason?: string | null;
  tenantId: string;
  timestamp: string;
};

export type IncomingCallPushPayload = {
  type: "INCOMING_CALL";
  /** Primary id — FCM payloads may use `callId` instead; normalize in app. */
  inviteId: string;
  /** Alias for `inviteId` when push uses minimal FCM data map. */
  callId?: string;
  /** Alias for `fromNumber` when push uses minimal FCM data map. */
  from?: string;
  pbxCallId?: string | null;
  fromNumber: string;
  fromDisplay?: string | null;
  toExtension: string;
  sipCallTarget?: string | null;
  pbxSipUsername?: string | null;
  tenantId: string;
  timestamp: string;
};

export type MobilePushPayload = IncomingCallPushPayload | InviteClaimedPushPayload | InviteCanceledPushPayload | MissedCallPushPayload;

export type SipRegistrationState =
  | "idle"          // no registration attempt has ever happened in this process
  | "registering"   // REGISTER request in flight
  | "registered"    // UA registered + WebSocket connected (healthy)
  | "disconnected"  // WebSocket dropped; UA is no longer authoritative
  | "retrying"      // Stage 1 keep-alive manager is between backoff attempts
  | "failed";       // terminal / auth-level failure (bad credentials, etc.)
export type CallState = "idle" | "dialing" | "ringing" | "connected" | "ended";
export type CallDirection = "inbound" | "outbound" | null;
