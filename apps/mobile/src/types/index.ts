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

export type VoicemailFolder = "inbox" | "old" | "urgent";

export type Voicemail = {
  id: string;
  callerId: string;
  callerName?: string | null;
  receivedAt: string;
  durationSec: number;
  folder: VoicemailFolder;
  listened: boolean;
  extension: string;
  tenantId: string | null;
  tenantName?: string | null;
  transcription?: string | null;
  streamUrl?: string;
};

export type VoicemailResponse = {
  voicemails: Voicemail[];
  total: number;
  page: number;
};

export type TeamPresence = "available" | "ringing" | "on_call" | "offline";

export type TeamDirectoryMember = {
  id: string;
  name: string;
  extension: string;
  email?: string | null;
  department?: string | null;
  title?: string | null;
  tenantId?: string | null;
  tenantName?: string | null;
  presence: TeamPresence;
};

export type LiveCallState = "ringing" | "dialing" | "up" | "held" | "hungup" | "unknown";

export type LiveCall = {
  id: string;
  linkedId?: string | null;
  tenantId: string | null;
  tenantName: string | null;
  direction: "inbound" | "outbound" | "internal" | "unknown";
  state: LiveCallState;
  from: string | null;
  fromName: string | null;
  to: string | null;
  connectedLine: string | null;
  channels: string[];
  bridgeIds: string[];
  extensions: string[];
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  billableSec: number;
};

export type LiveExtensionState = {
  extension: string;
  hint: string;
  status: string;
  tenantId: string | null;
  updatedAt: string;
};

export type TelephonySnapshot = {
  calls: LiveCall[];
  extensions: LiveExtensionState[];
};

export type ContactPhone = { id?: string; type: string; numberRaw: string; numberNormalized?: string; isPrimary?: boolean };
export type ContactEmail = { id?: string; type: string; email: string; isPrimary?: boolean };
export type ContactTag = { id: string; name: string; color?: string | null };

export type Contact = {
  id: string;
  tenantId: string;
  type: "internal_extension" | "external" | "company";
  extensionId?: string | null;
  extension?: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  avatarUrl?: string | null;
  notes?: string | null;
  favorite: boolean;
  source: "manual" | "extension" | "imported";
  phones: ContactPhone[];
  emails: ContactEmail[];
  addresses: Array<Record<string, string | null | undefined>>;
  tags: ContactTag[];
  primaryPhone?: ContactPhone | null;
  primaryEmail?: ContactEmail | null;
};

export type ContactsResponse = {
  tenantId: string;
  rows: Contact[];
  tags: ContactTag[];
  stats: { total: number; internalExtensions: number; external: number; companies: number; favorites: number };
};

export type ChatThreadType = "SMS" | "DM" | "GROUP" | "TENANT_GROUP";
export type ChatMessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "VOICE_NOTE" | "FILE" | "LOCATION" | "SYSTEM";

export type ChatThread = {
  id: string;
  type: ChatThreadType;
  title?: string | null;
  isDefaultTenantGroup?: boolean;
  tenantSmsE164?: string | null;
  externalSmsE164?: string | null;
  participantName: string;
  participantExtension: string;
  lastMessage: string;
  lastAt: string;
  unread: number;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
};

export type ChatMessage = {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
  mine: boolean;
  type: ChatMessageType;
  editedAt?: string | null;
  deletedForEveryoneAt?: string | null;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
};

export type ChatDirectoryUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  extensionId?: string | null;
  extensionNumber?: string | null;
  extensionName?: string | null;
  self?: boolean;
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
