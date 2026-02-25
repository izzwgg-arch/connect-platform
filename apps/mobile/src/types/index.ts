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
  sipPassword: string;
  sipWsUrl: string;
  sipDomain: string;
  outboundProxy?: string | null;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode?: "RFC2833" | "SIP_INFO";
};

export type CallRecord = {
  id: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  startedAt: string;
  durationSec: number;
  disposition?: string;
};

export type SipRegistrationState = "idle" | "registering" | "registered" | "failed";
export type CallState = "idle" | "dialing" | "ringing" | "connected" | "ended";
